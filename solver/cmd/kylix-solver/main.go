// Command kylix-solver reads a Kylix offer graph (from a JSON file or from a
// Gno.land node via read-only vm/qeval), finds settleable rings of 2..6 offers
// (with at most one GnoSwap-bridged hop), selects a disjoint set to settle,
// checks live deliverability, and prints the exact gnokey maketx call commands
// for SettleRing (direct) or SettleRingVia (bridged) with an explicit storage
// deposit cap.
//
// It never signs or broadcasts transactions.
package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"kylix/solver/ring"
	"kylix/solver/rpc"
)

const (
	defaultChainID         = "onyx-1"
	defaultKeyPlaceholder  = "<your-key>"
	defaultGasFee          = "auto"
	defaultDirectGasWanted = int64(0)
	defaultBridgeGasWanted = int64(0)

	// Per-ring automatic storage deposit cap components (100 ugnot/byte).
	//
	// Measured in security review 2: a 6-offer canonical GRC20 ring with 6
	// first-time receivers grew token storage by 12,348 B (~2,058 B per fresh
	// receiver = ~206,000 ugnot) when allowances were not deleted. Even with
	// exact approvals deleting the allowance node (~-1,100 B), a fresh
	// receiver still nets ~+1,000 B in that token realm, and a bridged hop's
	// output token realm has no offer allowance to delete (~+2,100 B) plus
	// GnoSwap pool observation writes.
	//
	// Computing -max-deposit per ring gives honest rings with fresh receivers
	// enough headroom while keeping smaller rings and item-only rings tight:
	//   - 2-leg item/item:       200,000 ugnot (0.20 GNOT =  2,000 B)
	//   - 2-leg token/item:      350,000 ugnot (0.35 GNOT =  3,500 B)
	//   - 2-leg token/token:     500,000 ugnot (0.50 GNOT =  5,000 B)
	//   - 2-leg bridged t/item:  600,000 ugnot (0.60 GNOT =  6,000 B)
	//   - 6-leg token ring:    1,500,000 ugnot (1.50 GNOT = 15,000 B)
	//   - 6-leg bridged ring:  1,750,000 ugnot (1.75 GNOT = 17,500 B)
	defaultMaxDepositFlag = "auto"
	depositPerTokenHop    = int64(250_000)
	depositPerItemHop     = int64(100_000)
	depositBridgeExtra    = int64(250_000)

	defaultExpiryMargin = int64(10)
	defaultMaxQuotes    = 200

	// Deliverability screening bounds so a large or adversarial book stays
	// within a modest RPC budget (at most 10 rounds and 20 Deliverable(ids)
	// queries of 50 IDs each = up to 1,000 offers).
	defaultMaxScreenRounds  = 10
	defaultMaxScreenQueries = 20
	maxPreScreenPerRound    = 500
)

type cliConfig struct {
	graphFile          string
	rpcURL             string
	realmPath          string
	realmFlagSet       bool
	chainID            string
	keyName            string
	gasFee             string
	gasWanted          int64
	bridgeGasWanted    int64
	maxDepositRaw      string
	maxDepositFixed    int64 // > 0 when explicit numeric cap was given; 0 means "auto"
	allowUnofficial    bool
	bridgeFlag         bool
	bridgeFlagSet      bool
	deliverableFlag    bool
	deliverableFlagSet bool
	feeTiersRaw        string
	routerPath         string
	poolPath           string
	maxFanout          int
	maxPerOwner        int
	maxSteps           int
	maxStepsPerStart   int
	maxRings           int
	maxRingsPerStart   int
	maxQuotes          int
	maxScreenRounds    int
	maxScreenQueries   int
	expiryMargin       int64
	ignoreExpiry       bool
	printSimulate      bool
	verbose            bool
	jsonOutput         bool
	timeout            time.Duration
}

type hopSummary struct {
	FromOffer uint64 `json:"fromOffer"`
	FromOwner string `json:"fromOwner"`
	ToOffer   uint64 `json:"toOffer"`
	ToOwner   string `json:"toOwner"`
	Give      string `json:"give"`
	Want      string `json:"want"`
	Bridged   bool   `json:"bridged"`
	Fee       uint32 `json:"fee,omitempty"`
	QuoteOut  int64  `json:"quoteOut,omitempty"`
}

type selectedOutput struct {
	IDs                   []uint64         `json:"ids"`
	IDsArg                string           `json:"idsArg"`
	Legs                  int              `json:"legs"`
	Func                  string           `json:"func"`
	Bridged               bool             `json:"bridged"`
	BridgedHop            int              `json:"bridgedHop"`
	Fee                   uint32           `json:"fee,omitempty"`
	Bridge                *ring.BridgeInfo `json:"bridge,omitempty"`
	MaxDeposit            int64            `json:"maxDeposit"`
	UnofficialCollections []string         `json:"unofficialCollections,omitempty"`
	Warning               string           `json:"warning,omitempty"`
	Hops                  []hopSummary     `json:"hops"`
	SimulateCommand       string           `json:"simulateCommand,omitempty"`
	GnokeyCommand         string           `json:"gnokeyCommand"`
}

type droppedRing struct {
	IDs     []uint64 `json:"ids"`
	IDsArg  string   `json:"idsArg"`
	OfferID uint64   `json:"offerId"`
	Reason  string   `json:"reason"`
}

type solverOutput struct {
	Realm                string           `json:"realm"`
	Height               int64            `json:"height"`
	ChainID              string           `json:"chainId"`
	RPC                  string           `json:"rpc"`
	MaxDeposit           int64            `json:"maxDeposit,omitempty"`
	MaxDepositMode       string           `json:"maxDepositMode,omitempty"`
	Stats                ring.Stats       `json:"stats"`
	RPCCalls             int              `json:"rpcCalls"`
	CandidateCount       int              `json:"candidateCount"`
	SkippedUnofficial    int              `json:"skippedUnofficial,omitempty"`
	ScreenRounds         int              `json:"screenRounds,omitempty"`
	ScreenQueries        int              `json:"screenQueries,omitempty"`
	MayBeIncomplete      bool             `json:"mayBeIncomplete,omitempty"`
	IncompleteReason     string           `json:"incompleteReason,omitempty"`
	Warnings             []string         `json:"warnings,omitempty"`
	DroppedUndeliverable []droppedRing    `json:"droppedUndeliverable,omitempty"`
	DeliverableWarnings  []string         `json:"deliverableWarnings,omitempty"`
	Selected             []selectedOutput `json:"selected"`
}

func main() {
	if err := run(context.Background(), os.Args[1:], os.Stdin, os.Stdout, os.Stderr); err != nil {
		fmt.Fprintf(os.Stderr, "kylix-solver: %s\n", sanitizeText(err.Error()))
		os.Exit(1)
	}
}

func run(ctx context.Context, args []string, stdin io.Reader, stdout, stderr io.Writer) error {
	cfg, err := parseFlags(args, stderr)
	if err != nil {
		if errors.Is(err, flag.ErrHelp) {
			return nil
		}
		return err
	}
	fixedDeposit, err := parseMaxDeposit(cfg.maxDepositRaw)
	if err != nil {
		return err
	}
	cfg.maxDepositFixed = fixedDeposit
	if cfg.expiryMargin < 0 {
		return fmt.Errorf("--expiry-margin must be >= 0")
	}
	if cfg.maxScreenRounds <= 0 {
		return fmt.Errorf("--max-screen-rounds must be >= 1")
	}
	if cfg.maxScreenQueries <= 0 {
		return fmt.Errorf("--max-screen-queries must be >= 1")
	}

	ctx, cancel := context.WithTimeout(ctx, cfg.timeout)
	defer cancel()

	client := rpc.NewClient(cfg.rpcURL)

	var topWarnings []string

	// The printed commands must name the chain the offers were read from.
	if cfg.chainID == "" {
		cfg.chainID = defaultChainID
		if cfg.graphFile == "" {
			if id, err := client.ChainID(ctx); err == nil {
				if clean := sanitizeText(id); clean != "" && clean == id {
					cfg.chainID = id
				}
			}
		}
	}

	var g ring.Graph
	if cfg.graphFile != "" {
		raw, err := readGraphInput(cfg.graphFile, stdin)
		if err != nil {
			return err
		}
		g, err = ring.ParseGraphJSON(raw)
		if err != nil {
			return err
		}
	} else {
		g, err = rpc.FetchGraph(ctx, client, cfg.realmPath)
		if err != nil {
			return err
		}
	}

	realmPath := cfg.realmPath
	if realmPath == "" {
		realmPath = rpc.DefaultRealmPath
	}
	if cfg.graphFile != "" && !cfg.realmFlagSet && g.Realm != "" {
		if isValidRealmPath(g.Realm) {
			realmPath = g.Realm
			if realmPath != rpc.DefaultRealmPath {
				w := fmt.Sprintf("using realm path %s from --graph file (differs from default %s; pass --realm to override)", realmPath, rpc.DefaultRealmPath)
				topWarnings = append(topWarnings, w)
			}
		} else {
			w := fmt.Sprintf("ignoring malformed realm path in --graph file; using default %s", rpc.DefaultRealmPath)
			topWarnings = append(topWarnings, w)
		}
	}

	enableBridge := cfg.bridgeFlag
	if !cfg.bridgeFlagSet {
		// Default: quote GnoSwap bridges in live RPC mode, stay offline in --graph mode.
		enableBridge = cfg.graphFile == ""
	}

	checkDeliverable := cfg.deliverableFlag
	if !cfg.deliverableFlagSet {
		// Default: check live deliverability in RPC mode, off automatically with --graph.
		checkDeliverable = cfg.graphFile == ""
	}

	var quoteFn ring.QuoteFunc
	if enableBridge {
		tiers, err := parseFeeTiers(cfg.feeTiersRaw)
		if err != nil {
			return err
		}
		quoter := rpc.NewGnoSwapQuoter(client)
		quoter.RouterPath = cfg.routerPath
		quoter.PoolPath = cfg.poolPath
		quoter.FeeTiers = tiers
		quoteFn = quoter.QuoteFunc(ctx)
	}

	opts := ring.Options{
		MaxFanout:        cfg.maxFanout,
		MaxPerOwner:      cfg.maxPerOwner,
		MaxSteps:         cfg.maxSteps,
		MaxStepsPerStart: cfg.maxStepsPerStart,
		MaxRings:         cfg.maxRings,
		MaxRingsPerStart: cfg.maxRingsPerStart,
		MaxQuotes:        cfg.maxQuotes,
		ExpiryMargin:     cfg.expiryMargin,
		IgnoreExpiry:     cfg.ignoreExpiry,
		OfficialOnly:     !cfg.allowUnofficial,
	}

	byID := ring.IndexOffers(g.Offers)
	colMap := ring.IndexCollections(g.Collections)

	var (
		res                 ring.Result
		selected            []ring.Ring
		dropped             []droppedRing
		deliverableWarnings []string
		screenRounds        int
		screenQueries       int
		mayBeIncomplete     bool
		incompleteReason    string
	)
	if checkDeliverable {
		tracker := newDeliverableTracker(byID, cfg.verbose)
		var screenRes screenResult
		res, screenRes = screenAndFindRings(ctx, client, realmPath, g, quoteFn, opts, enableBridge, cfg.maxScreenRounds, cfg.maxScreenQueries, tracker)
		res.Stats.OffersInput = len(g.Offers)
		if screenRes.ranPreScreen {
			res.Stats.OffersEligible = screenRes.origStats.OffersEligible
			res.Stats.OffersSkippedExpiry = screenRes.origStats.OffersSkippedExpiry
			res.Stats.OffersSkippedUnofficial = screenRes.origStats.OffersSkippedUnofficial
		}
		var selectBudgetExhausted bool
		selected, selectBudgetExhausted = selectDeliverableRings(ctx, client, realmPath, res.Rings, cfg.maxScreenQueries, tracker)
		screenRounds = screenRes.rounds
		screenQueries = tracker.queriesUsed
		dropped = tracker.dropped
		deliverableWarnings = tracker.warnings

		switch {
		case screenRes.budgetExhausted && selectBudgetExhausted:
			mayBeIncomplete = true
			incompleteReason = fmt.Sprintf(
				"deliverability screening exhausted its budget (%d/%d rounds, %d/%d Deliverable queries) while search bound %q remained full, and unconfirmed rings were dropped; result may be incomplete",
				screenRounds, cfg.maxScreenRounds, screenQueries, cfg.maxScreenQueries, res.Stats.TruncatedReason,
			)
		case screenRes.budgetExhausted:
			mayBeIncomplete = true
			incompleteReason = fmt.Sprintf(
				"deliverability screening exhausted its budget (%d/%d rounds, %d/%d Deliverable queries) while search bound %q remained full; result may be incomplete",
				screenRounds, cfg.maxScreenRounds, screenQueries, cfg.maxScreenQueries, res.Stats.TruncatedReason,
			)
		case selectBudgetExhausted && res.Stats.Truncated:
			mayBeIncomplete = true
			incompleteReason = fmt.Sprintf(
				"search hit bound %q and deliverability check exhausted its query budget (%d/%d Deliverable queries) before confirming all selected rings; unconfirmed rings were dropped and result may be incomplete",
				res.Stats.TruncatedReason, screenQueries, cfg.maxScreenQueries,
			)
		case selectBudgetExhausted:
			mayBeIncomplete = true
			incompleteReason = fmt.Sprintf(
				"deliverability check exhausted its query budget (%d/%d Deliverable queries) before confirming all selected rings; unconfirmed rings were dropped and result may be incomplete",
				screenQueries, cfg.maxScreenQueries,
			)
		case res.Stats.Truncated:
			mayBeIncomplete = true
			incompleteReason = fmt.Sprintf(
				"search hit bound %q; result may be incomplete",
				res.Stats.TruncatedReason,
			)
		}
	} else {
		res = ring.FindRings(g, quoteFn, opts)
		selected = ring.SelectRings(res.Rings)
		if res.Stats.Truncated {
			mayBeIncomplete = true
			incompleteReason = fmt.Sprintf(
				"search hit bound %q; result may be incomplete",
				res.Stats.TruncatedReason,
			)
		}
	}
	if mayBeIncomplete && incompleteReason != "" {
		topWarnings = append(topWarnings, incompleteReason)
	}

	out := solverOutput{
		Realm:                realmPath,
		Height:               g.Height,
		ChainID:              cfg.chainID,
		RPC:                  cfg.rpcURL,
		MaxDeposit:           cfg.maxDepositFixed,
		MaxDepositMode:       "fixed",
		Stats:                res.Stats,
		RPCCalls:             client.Calls(),
		CandidateCount:       len(res.Rings),
		SkippedUnofficial:    res.Stats.OffersSkippedUnofficial,
		ScreenRounds:         screenRounds,
		ScreenQueries:        screenQueries,
		MayBeIncomplete:      mayBeIncomplete,
		IncompleteReason:     incompleteReason,
		Warnings:             topWarnings,
		DroppedUndeliverable: dropped,
		DeliverableWarnings:  deliverableWarnings,
		Selected:             make([]selectedOutput, 0, len(selected)),
	}
	if cfg.maxDepositFixed == 0 {
		out.MaxDepositMode = "auto"
	}

	for _, r := range selected {
		// Gas limit sized to the ring: 25M, plus 5M per token offer, 25M per
		// item offer and 150M for a GnoSwap hop. The ring page uses 25M per MNS
		// name and 8M per other item; the solver uses 25M for every item. An
		// explicit --gas-wanted or --bridge-gas-wanted overrides it.
		gasWanted := ringGasWanted(byID, r)
		if cfg.gasWanted > 0 {
			gasWanted = cfg.gasWanted
		}
		var fee uint32
		funcName := "SettleRing"
		if r.IsBridged() {
			if cfg.bridgeGasWanted > 0 {
				gasWanted = cfg.bridgeGasWanted
			}
			if r.Bridge == nil || r.Bridge.Fee == 0 {
				return fmt.Errorf("bridged ring [%s] is missing chosen GnoSwap fee tier", r.FormatIDs())
			}
			fee = r.Bridge.Fee
			funcName = "SettleRingVia"
		}
		gasFee := cfg.gasFee
		if gasFee == "" || gasFee == "auto" {
			// The fee is a flat amount, not gas used times a price, so a
			// large fee turns a small ring's storage refund into a loss.
			gasFee = fmt.Sprintf("%dugnot", (gasWanted+999)/1000)
		}
		maxDep := cfg.maxDepositFixed
		if maxDep == 0 {
			maxDep = ringMaxDeposit(byID, r)
		}
		cmd := buildGnokeyCommand(realmPath, funcName, r.FormatIDs(), fee, gasFee, gasWanted, maxDep, cfg.chainID, cfg.rpcURL, cfg.keyName, false)
		var simCmd string
		if cfg.printSimulate {
			simCmd = buildGnokeyCommand(realmPath, funcName, r.FormatIDs(), fee, gasFee, gasWanted, maxDep, cfg.chainID, cfg.rpcURL, cfg.keyName, true)
		}

		unofficialCols := ring.UnofficialCollections(byID, colMap, r)
		var warning string
		if len(unofficialCols) > 0 {
			warning = fmt.Sprintf(
				"touches unofficial collection(s): %s (custom callbacks can lock up to -max-deposit %dugnot)",
				strings.Join(unofficialCols, ", "),
				maxDep,
			)
		}

		out.Selected = append(out.Selected, selectedOutput{
			IDs:                   r.IDs,
			IDsArg:                r.FormatIDs(),
			Legs:                  len(r.IDs),
			Func:                  funcName,
			Bridged:               r.IsBridged(),
			BridgedHop:            r.BridgedHop,
			Fee:                   fee,
			Bridge:                r.Bridge,
			MaxDeposit:            maxDep,
			UnofficialCollections: unofficialCols,
			Warning:               warning,
			Hops:                  describeHops(byID, r),
			SimulateCommand:       simCmd,
			GnokeyCommand:         cmd,
		})
	}

	if cfg.jsonOutput {
		for _, w := range topWarnings {
			fmt.Fprintf(stderr, "Warning: %s\n", sanitizeText(w))
		}
		enc := json.NewEncoder(stdout)
		enc.SetIndent("", "  ")
		return enc.Encode(out)
	}

	writeTextOutput(stdout, out)
	return nil
}

type deliverableTracker struct {
	checked     map[uint64]rpc.DeliverableStatus
	unknown     map[uint64]bool
	dead        map[uint64]bool
	warnings    []string
	dropped     []droppedRing
	droppedKeys map[string]bool
	verbose     bool
	byID        map[uint64]ring.Offer
	queriesUsed int
}

func newDeliverableTracker(byID map[uint64]ring.Offer, verbose bool) *deliverableTracker {
	return &deliverableTracker{
		checked:     make(map[uint64]rpc.DeliverableStatus),
		unknown:     make(map[uint64]bool),
		dead:        make(map[uint64]bool),
		droppedKeys: make(map[string]bool),
		verbose:     verbose,
		byID:        byID,
	}
}

func (t *deliverableTracker) isKnown(id uint64) bool {
	if _, ok := t.checked[id]; ok {
		return true
	}
	return t.unknown[id]
}

func (t *deliverableTracker) knownSet() map[uint64]bool {
	out := make(map[uint64]bool, len(t.checked)+len(t.unknown))
	for id := range t.checked {
		out[id] = true
	}
	for id := range t.unknown {
		out[id] = true
	}
	return out
}

func (t *deliverableTracker) query(ctx context.Context, client *rpc.Client, realmPath string, ids []uint64) int {
	var unchecked []uint64
	seen := make(map[uint64]bool, len(ids))
	for _, id := range ids {
		if id == 0 || seen[id] || t.isKnown(id) {
			continue
		}
		seen[id] = true
		unchecked = append(unchecked, id)
	}
	if len(unchecked) == 0 {
		return 0
	}

	t.queriesUsed += (len(unchecked) + rpc.MaxDeliverableBatch - 1) / rpc.MaxDeliverableBatch
	res := rpc.CheckDeliverable(ctx, client, realmPath, unchecked)
	newlyDead := 0
	for id, st := range res.Statuses {
		t.checked[id] = st
		if !st.Deliverable && !t.dead[id] {
			t.dead[id] = true
			newlyDead++
		}
	}
	for _, id := range res.Unknown {
		t.unknown[id] = true
		if !t.dead[id] {
			t.dead[id] = true
			newlyDead++
		}
	}
	if t.verbose {
		t.warnings = append(t.warnings, res.VerboseWarnings...)
	} else {
		t.warnings = append(t.warnings, res.Warnings...)
	}
	return newlyDead
}

// checkRingFailClosed reports whether every offer in r is confirmed deliverable.
// If any offer is undeliverable, failed/omitted, or was never queried (for
// example because the query budget ran out), it fails closed and returns
// (false, offerID, safeReason).
func (t *deliverableTracker) checkRingFailClosed(r ring.Ring) (bool, uint64, string) {
	for _, id := range r.IDs {
		st, known := t.checked[id]
		if known {
			if !st.Deliverable {
				o, hasOffer := t.byID[id]
				reason := formatDropReason(id, o, hasOffer, st, true, t.verbose)
				return false, id, reason
			}
		} else if t.unknown[id] {
			o, hasOffer := t.byID[id]
			reason := formatDropReason(id, o, hasOffer, rpc.DeliverableStatus{}, false, t.verbose)
			return false, id, reason
		}
	}
	for _, id := range r.IDs {
		if !t.isKnown(id) {
			return false, id, fmt.Sprintf("offer #%d: deliverability check skipped (query budget exhausted)", id)
		}
	}
	return true, 0, ""
}

func (t *deliverableTracker) recordDropped(r ring.Ring, offerID uint64, reason string) {
	key := r.FormatIDs()
	if t.droppedKeys[key] {
		return
	}
	t.droppedKeys[key] = true
	t.dropped = append(t.dropped, droppedRing{
		IDs:     r.IDs,
		IDsArg:  key,
		OfferID: offerID,
		Reason:  reason,
	})
}

type screenResult struct {
	origStats       ring.Stats
	ranPreScreen    bool
	rounds          int
	budgetExhausted bool
}

func hasUncheckedIDs(ids []uint64, tracker *deliverableTracker) bool {
	for _, id := range ids {
		if id != 0 && !tracker.isKnown(id) {
			return true
		}
	}
	return false
}

// screenAndFindRings screens candidate offers and offers occupying truncated
// search bounds (max_fanout, max_per_owner, max_steps_per_start, max_steps,
// max_rings, max_quotes) via Deliverable(ids), drops dead offers, and retries
// in rounds within maxRounds and maxQueries (at most 50 IDs per query).
//
// Books with no truncation and no dead offers spend no extra Deliverable
// queries beyond checking visible candidate rings. When the round or query
// budget runs out while a search bound is still truncated with unchecked
// blocking offers, screenResult.budgetExhausted is set true with a plain
// explanation so callers warn that the result may be incomplete.
func screenAndFindRings(
	ctx context.Context,
	client *rpc.Client,
	realmPath string,
	g ring.Graph,
	quoteFn ring.QuoteFunc,
	opts ring.Options,
	enableBridge bool,
	maxRounds int,
	maxQueries int,
	tracker *deliverableTracker,
) (ring.Result, screenResult) {
	var sr screenResult

	// Phase A: zero-quote pre-screening rounds (direct rings, truncated-bound
	// blocking offers, and structurally bridgeable candidate offers).
	for sr.rounds < maxRounds && tracker.queriesUsed < maxQueries {
		liveGraph := filterOutDeadOffers(g, tracker.dead)
		directRes := ring.FindRings(liveGraph, nil, opts)
		if !sr.ranPreScreen {
			sr.origStats = directRes.Stats
			sr.ranPreScreen = true
		}

		selectedDirect := ring.SelectRings(directRes.Rings)
		remQueries := maxQueries - tracker.queriesUsed
		roundBudget := maxPreScreenPerRound
		if maxIDs := remQueries * rpc.MaxDeliverableBatch; maxIDs < roundBudget {
			roundBudget = maxIDs
		}

		toCheck := make([]uint64, 0, roundBudget)
		queued := make(map[uint64]bool)
		addID := func(id uint64) bool {
			if id == 0 || queued[id] || tracker.isKnown(id) {
				return false
			}
			if len(toCheck) >= roundBudget {
				return false
			}
			queued[id] = true
			toCheck = append(toCheck, id)
			return true
		}

		// 1. Offers in visible selected direct rings.
		for _, r := range selectedDirect {
			for _, id := range r.IDs {
				addID(id)
			}
		}

		// 2. Offers occupying truncated direct-search bounds (fan-out,
		// per-owner, per-start/total steps, max_rings).
		if directRes.Stats.Truncated {
			for _, id := range directRes.BlockingOffers {
				addID(id)
			}
		}

		// 3. Structurally bridgeable offers and bridged-scan blockers.
		var bScan ring.BridgedScanResult
		if enableBridge && len(toCheck) < roundBudget {
			skip := tracker.knownSet()
			for id := range queued {
				skip[id] = true
			}
			bScan = ring.ScanBridgedCandidates(liveGraph, opts, skip, roundBudget-len(toCheck))
			for _, id := range bScan.Offers {
				addID(id)
			}
			if bScan.Truncated {
				for _, id := range bScan.BlockingOffers {
					addID(id)
				}
			}
		}

		if len(toCheck) == 0 {
			break
		}

		newlyDead := tracker.query(ctx, client, realmPath, toCheck)
		sr.rounds++

		for _, r := range selectedDirect {
			hasDead := false
			for _, id := range r.IDs {
				if tracker.dead[id] {
					hasDead = true
					break
				}
			}
			if hasDead {
				if ok, badID, reason := tracker.checkRingFailClosed(r); !ok {
					tracker.recordDropped(r, badID, reason)
				}
			}
		}

		moreDirectBlockers := directRes.Stats.Truncated && hasUncheckedIDs(directRes.BlockingOffers, tracker)
		moreBridgedBlockers := enableBridge && bScan.Truncated && hasUncheckedIDs(bScan.BlockingOffers, tracker)
		if newlyDead == 0 && !moreDirectBlockers && !moreBridgedBlockers {
			break
		}
	}

	// Phase B: full search (including GnoSwap quoting if enabled). If a bound
	// (such as max_quotes or Phase 2 step/ring limits) is hit on unchecked
	// offers and screening budget remains, screen those blockers and retry.
	var res ring.Result
	for {
		liveGraph := filterOutDeadOffers(g, tracker.dead)
		res = ring.FindRings(liveGraph, quoteFn, opts)
		if !res.Stats.Truncated {
			break
		}
		if sr.rounds >= maxRounds || tracker.queriesUsed >= maxQueries {
			break
		}
		remQueries := maxQueries - tracker.queriesUsed
		roundBudget := maxPreScreenPerRound
		if maxIDs := remQueries * rpc.MaxDeliverableBatch; maxIDs < roundBudget {
			roundBudget = maxIDs
		}
		var toCheck []uint64
		queued := make(map[uint64]bool)
		for _, id := range res.BlockingOffers {
			if id == 0 || queued[id] || tracker.isKnown(id) {
				continue
			}
			queued[id] = true
			toCheck = append(toCheck, id)
			if len(toCheck) >= roundBudget {
				break
			}
		}
		if len(toCheck) == 0 {
			break
		}
		newlyDead := tracker.query(ctx, client, realmPath, toCheck)
		sr.rounds++
		if newlyDead == 0 && !hasUncheckedIDs(res.BlockingOffers, tracker) {
			break
		}
	}

	if res.Stats.Truncated && (sr.rounds >= maxRounds || tracker.queriesUsed >= maxQueries) && hasUncheckedIDs(res.BlockingOffers, tracker) {
		sr.budgetExhausted = true
	}
	return res, sr
}

func filterOutDeadOffers(g ring.Graph, dead map[uint64]bool) ring.Graph {
	if len(dead) == 0 {
		return g
	}
	live := g
	live.Offers = make([]ring.Offer, 0, len(g.Offers))
	for _, o := range g.Offers {
		if !dead[o.ID] {
			live.Offers = append(live.Offers, o)
		}
	}
	return live
}

// selectDeliverableRings picks a disjoint subset of candidates and verifies
// their offers via Kylix's batched Deliverable(ids) query within maxQueries
// total queries on tracker. It fails closed: any offer that is undeliverable,
// failed/omitted, or cannot be checked because the query budget is exhausted
// drops its ring so the loop can try other disjoint rings. Returns the
// confirmed disjoint rings and whether the query budget ran out before every
// selected ring could be confirmed.
func selectDeliverableRings(
	ctx context.Context,
	client *rpc.Client,
	realmPath string,
	candidates []ring.Ring,
	maxQueries int,
	tracker *deliverableTracker,
) ([]ring.Ring, bool) {
	remaining := append([]ring.Ring(nil), candidates...)
	budgetExhausted := false

	for len(remaining) > 0 {
		selected := ring.SelectRings(remaining)
		if len(selected) == 0 {
			return nil, budgetExhausted
		}

		var toCheck []uint64
		seen := make(map[uint64]bool)
		for _, r := range selected {
			for _, id := range r.IDs {
				if id != 0 && !seen[id] && !tracker.isKnown(id) {
					seen[id] = true
					toCheck = append(toCheck, id)
				}
			}
		}
		if len(toCheck) > 0 {
			remQueries := maxQueries - tracker.queriesUsed
			if remQueries < 0 {
				remQueries = 0
			}
			maxIDs := remQueries * rpc.MaxDeliverableBatch
			if len(toCheck) > maxIDs {
				budgetExhausted = true
				toCheck = toCheck[:maxIDs]
			}
			if len(toCheck) > 0 {
				tracker.query(ctx, client, realmPath, toCheck)
			}
		}

		badOffers := make(map[uint64]bool)
		for _, r := range selected {
			if ok, badID, reason := tracker.checkRingFailClosed(r); !ok {
				tracker.recordDropped(r, badID, reason)
				badOffers[badID] = true
				if !tracker.isKnown(badID) {
					budgetExhausted = true
				}
			}
		}

		if len(badOffers) == 0 {
			return selected, budgetExhausted
		}

		next := make([]ring.Ring, 0, len(remaining))
		for _, r := range remaining {
			hasBad := false
			for _, id := range r.IDs {
				if badOffers[id] {
					hasBad = true
					break
				}
			}
			if !hasBad {
				next = append(next, r)
			}
		}
		if len(next) == len(remaining) {
			return nil, budgetExhausted
		}
		remaining = next
	}

	return nil, budgetExhausted
}

func formatDropReason(offerID uint64, offer ring.Offer, hasOffer bool, st rpc.DeliverableStatus, known bool, verbose bool) string {
	if !known {
		return fmt.Sprintf("offer #%d: deliverability check failed", offerID)
	}
	raw := strings.TrimSpace(st.Reason)
	if raw == "" {
		return "undeliverable"
	}
	if verbose {
		return raw
	}
	if hasOffer && offer.Give.Kind == ring.KindItem {
		if isKnownKylixItemReason(raw) {
			return raw
		}
		return fmt.Sprintf("offer #%d: undeliverable (collection check)", offerID)
	}
	if isSafeShortReason(raw) {
		return raw
	}
	return fmt.Sprintf("offer #%d: undeliverable", offerID)
}

func isKnownKylixItemReason(s string) bool {
	if !isSafeShortReason(s) {
		return false
	}
	switch s {
	case "not open", "expired", "collection is not registered", "unknown asset kind":
		return true
	}
	if strings.HasPrefix(s, "owner no longer holds item ") {
		return true
	}
	if strings.HasPrefix(s, "item ") && strings.Contains(s, " cannot be moved by ") {
		return true
	}
	return false
}

func isSafeShortReason(s string) bool {
	if len(s) == 0 || len(s) > 160 {
		return false
	}
	return sanitizeText(s) == s
}

// ringGasWanted sizes the gas limit to the ring: 25M, plus 5M per token
// offer, 25M per item offer, and 150M for a GnoSwap hop (on onyx-1 a real
// 2-offer swap ring used 146M, and a token and an MNS name 44M). Kept in step with the
// ring page by hand. Measured settlements on a local chain used 24M (two
// tokens) to 60M (six items); the formula leaves headroom over each. The fee
// is a flat amount tied to this limit, so an oversized limit eats the
// settler's storage refund.
func ringGasWanted(byID map[uint64]ring.Offer, r ring.Ring) int64 {
	gas := int64(25_000_000)
	for _, id := range r.IDs {
		if o, ok := byID[id]; ok && o.Give.Kind == ring.KindItem {
			gas += 25_000_000
		} else {
			gas += 5_000_000
		}
	}
	if r.IsBridged() {
		gas += 150_000_000
	}
	return gas
}

// ringMaxDeposit computes a tight per-ring storage deposit cap in ugnot based
// on the number of fungible hops, item hops, and whether a GnoSwap bridge runs.
func ringMaxDeposit(byID map[uint64]ring.Offer, r ring.Ring) int64 {
	tokenHops := 0
	itemHops := 0
	for i, id := range r.IDs {
		if i == r.BridgedHop {
			tokenHops++
			continue
		}
		if o, ok := byID[id]; ok && o.Give.Kind == ring.KindItem {
			itemHops++
		} else {
			tokenHops++
		}
	}
	capUgnot := int64(tokenHops)*depositPerTokenHop + int64(itemHops)*depositPerItemHop
	if r.IsBridged() {
		capUgnot += depositBridgeExtra
	}
	if capUgnot < depositPerItemHop {
		capUgnot = depositPerItemHop
	}
	return capUgnot
}

func parseMaxDeposit(raw string) (int64, error) {
	s := strings.TrimSpace(raw)
	if s == "" || strings.EqualFold(s, "auto") {
		return 0, nil
	}
	v, err := strconv.ParseInt(s, 10, 64)
	if err != nil {
		return 0, fmt.Errorf("invalid --max-deposit %q: expected \"auto\" or a positive integer in ugnot", raw)
	}
	if v <= 0 {
		return 0, fmt.Errorf("--max-deposit must be > 0 ugnot (0 or unset falls back to the chain's large default_deposit)")
	}
	return v, nil
}

// isValidRealmPath reports whether s is a well-formed gno.land/r/... realm path
// containing only safe path segments ([a-z0-9._-], no empty or dot segments).
func isValidRealmPath(s string) bool {
	const prefix = "gno.land/r/"
	if !strings.HasPrefix(s, prefix) || len(s) <= len(prefix) || len(s) > 256 {
		return false
	}
	rest := s[len(prefix):]
	parts := strings.Split(rest, "/")
	for _, seg := range parts {
		if seg == "" || seg == "." || seg == ".." {
			return false
		}
		for i := 0; i < len(seg); i++ {
			c := seg[i]
			ok := (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c == '.' || c == '_' || c == '-'
			if !ok {
				return false
			}
		}
	}
	return true
}

// sanitizeText strips ANSI/VT terminal escape sequences (CSI, OSC, DCS/SOS/PM/APC,
// 2-byte ESC), C0/C1 control characters, DEL, and Unicode bidi/line controls so
// untrusted chain data or RPC errors cannot forge terminal output or lines.
func sanitizeText(s string) string {
	if s == "" {
		return ""
	}
	var sb strings.Builder
	sb.Grow(len(s))
	i := 0
	for i < len(s) {
		b := s[i]
		if b == 0x1b { // ESC
			i++
			if i >= len(s) {
				break
			}
			next := s[i]
			switch next {
			case '[': // CSI: ESC [ params intermediates final(0x40-0x7E)
				i++
				for i < len(s) {
					c := s[i]
					i++
					if c >= 0x40 && c <= 0x7e {
						break
					}
				}
			case ']': // OSC: terminated by BEL (0x07) or ST (ESC \)
				i++
				i = skipStringTerminated(s, i, true)
			case 'P', 'X', '^', '_': // DCS, SOS, PM, APC: terminated by ST (ESC \)
				i++
				i = skipStringTerminated(s, i, false)
			default:
				// 2-byte (or intermediate + final) ESC sequence.
				for i < len(s) && s[i] >= 0x20 && s[i] <= 0x2f {
					i++
				}
				if i < len(s) && s[i] >= 0x30 && s[i] <= 0x7e {
					i++
				}
			}
			continue
		}
		if b < 0x20 || b == 0x7f {
			i++
			continue
		}
		if b < 0x80 {
			sb.WriteByte(b)
			i++
			continue
		}
		r, size := utf8.DecodeRuneInString(s[i:])
		if r == utf8.RuneError && size == 1 {
			i++
			continue
		}
		i += size
		switch {
		case r == 0x9b: // 8-bit CSI
			for i < len(s) {
				c := s[i]
				i++
				if c >= 0x40 && c <= 0x7e {
					break
				}
			}
			continue
		case r == 0x9d: // 8-bit OSC
			i = skipStringTerminated(s, i, true)
			continue
		case r == 0x90 || r == 0x98 || r == 0x9e || r == 0x9f: // 8-bit DCS/SOS/PM/APC
			i = skipStringTerminated(s, i, false)
			continue
		case r >= 0x80 && r <= 0x9f: // other C1 controls
			continue
		case r == 0x200e || r == 0x200f || r == 0x2028 || r == 0x2029 ||
			(r >= 0x202a && r <= 0x202e) || (r >= 0x2066 && r <= 0x2069):
			continue
		}
		sb.WriteRune(r)
	}
	return sb.String()
}

func skipStringTerminated(s string, i int, allowBEL bool) int {
	for i < len(s) {
		if allowBEL && s[i] == 0x07 {
			return i + 1
		}
		if s[i] == 0x1b && i+1 < len(s) && s[i+1] == '\\' {
			return i + 2
		}
		r, size := utf8.DecodeRuneInString(s[i:])
		if r == 0x9c { // 8-bit ST
			return i + size
		}
		i += size
	}
	return i
}

func parseFlags(args []string, stderr io.Writer) (cliConfig, error) {
	var cfg cliConfig
	fs := flag.NewFlagSet("kylix-solver", flag.ContinueOnError)
	fs.SetOutput(stderr)

	fs.StringVar(&cfg.graphFile, "graph", "", "read ExportGraphJSON from file path (or '-' for stdin) instead of querying RPC")
	fs.StringVar(&cfg.rpcURL, "rpc", rpc.DefaultOnyxRPC, "Gno.land RPC URL for read-only vm/qeval queries and printed gnokey commands")
	fs.StringVar(&cfg.realmPath, "realm", rpc.DefaultRealmPath, "Kylix realm package path")
	fs.StringVar(&cfg.chainID, "chain-id", "", "chain-id for printed gnokey commands (default: read from the node with --rpc, otherwise "+defaultChainID+")")
	fs.StringVar(&cfg.keyName, "key", defaultKeyPlaceholder, "key name or address placeholder for printed gnokey commands")
	fs.StringVar(&cfg.gasFee, "gas-fee", defaultGasFee, "gas-fee for printed gnokey commands; \"auto\" means gas-wanted/1000 ugnot, the minimum at the base gas price")
	fs.Int64Var(&cfg.gasWanted, "gas-wanted", defaultDirectGasWanted, "gas-wanted for direct rings in printed gnokey commands (0 = sized to the ring)")
	fs.Int64Var(&cfg.bridgeGasWanted, "bridge-gas-wanted", defaultBridgeGasWanted, "gas-wanted for GnoSwap-bridged rings in printed gnokey commands (0 = sized to the ring)")
	fs.StringVar(&cfg.maxDepositRaw, "max-deposit", defaultMaxDepositFlag, "max storage deposit in ugnot for printed gnokey commands (\"auto\" computes per ring, or a positive integer; 0 is rejected)")
	fs.BoolVar(&cfg.allowUnofficial, "allow-unofficial", false, "include offers touching unofficial item collections (prints a warning per ring)")
	fs.BoolVar(&cfg.bridgeFlag, "bridge", false, "query GnoSwap DrySwapRoute for single bridged hops (default: true with --rpc, false with --graph)")
	fs.BoolVar(&cfg.deliverableFlag, "check-deliverable", false, "check live offer deliverability via Deliverable(ids) before printing rings (default: true with --rpc, false with --graph)")
	fs.StringVar(&cfg.feeTiersRaw, "fee-tiers", "100,500,3000,10000", "comma-separated GnoSwap fee tiers to probe")
	fs.StringVar(&cfg.routerPath, "gnoswap-router", rpc.DefaultGnoSwapRouterPath, "GnoSwap router realm path")
	fs.StringVar(&cfg.poolPath, "gnoswap-pool", rpc.DefaultGnoSwapPoolPath, "GnoSwap pool realm path")
	fs.IntVar(&cfg.maxFanout, "max-fanout", ring.DefaultMaxFanout, "max direct out-neighbors explored per offer")
	fs.IntVar(&cfg.maxPerOwner, "max-per-owner", ring.DefaultMaxPerOwner, "max offers kept per owner for each wanted asset")
	fs.IntVar(&cfg.maxSteps, "max-steps", ring.DefaultMaxSteps, "max total DFS steps")
	fs.IntVar(&cfg.maxStepsPerStart, "max-steps-per-start", ring.DefaultMaxStepsPerStart, "max DFS steps per start offer")
	fs.IntVar(&cfg.maxRings, "max-rings", ring.DefaultMaxRings, "max candidate rings collected before selection")
	fs.IntVar(&cfg.maxRingsPerStart, "max-rings-per-start", ring.DefaultMaxRingsPerStart, "max candidate rings collected per start offer")
	fs.IntVar(&cfg.maxQuotes, "max-quotes", defaultMaxQuotes, "max distinct uncached GnoSwap quote calls (0 = unlimited)")
	fs.IntVar(&cfg.maxScreenRounds, "max-screen-rounds", defaultMaxScreenRounds, "max deliverability screening rounds when search bounds are truncated or dead offers are dropped")
	fs.IntVar(&cfg.maxScreenQueries, "max-screen-queries", defaultMaxScreenQueries, "max batched Deliverable(ids) queries (50 IDs each) spent in deliverability screening")
	fs.Int64Var(&cfg.expiryMargin, "expiry-margin", defaultExpiryMargin, "skip offers expiring within this many blocks of the current height")
	fs.BoolVar(&cfg.ignoreExpiry, "ignore-expiry", false, "ignore offer expiry heights when solving a snapshot file")
	fs.BoolVar(&cfg.printSimulate, "print-simulate", false, "also print a simulate-only gnokey command (-broadcast -simulate only) next to each settle command")
	fs.BoolVar(&cfg.verbose, "verbose", false, "include raw RPC/collection error details in deliverability warnings and drop reasons (do not enable for AI agents)")
	fs.BoolVar(&cfg.jsonOutput, "json", false, "emit machine-readable JSON output")
	fs.DurationVar(&cfg.timeout, "timeout", 60*time.Second, "overall timeout for RPC queries")

	if err := fs.Parse(args); err != nil {
		return cliConfig{}, err
	}
	fs.Visit(func(f *flag.Flag) {
		switch f.Name {
		case "realm":
			cfg.realmFlagSet = true
		case "bridge":
			cfg.bridgeFlagSet = true
		case "check-deliverable":
			cfg.deliverableFlagSet = true
		}
	})
	return cfg, nil
}

func readGraphInput(path string, stdin io.Reader) ([]byte, error) {
	if path == "-" {
		b, err := io.ReadAll(stdin)
		if err != nil {
			return nil, fmt.Errorf("read graph from stdin: %w", err)
		}
		return b, nil
	}
	b, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("read graph file %q: %w", path, err)
	}
	return b, nil
}

func parseFeeTiers(raw string) ([]uint32, error) {
	parts := strings.Split(raw, ",")
	tiers := make([]uint32, 0, len(parts))
	seen := make(map[uint32]bool, len(parts))
	for _, p := range parts {
		p = strings.TrimSpace(p)
		if p == "" {
			continue
		}
		v, err := strconv.ParseUint(p, 10, 32)
		if err != nil {
			return nil, fmt.Errorf("invalid fee tier %q: %w", p, err)
		}
		fee := uint32(v)
		if !rpc.ValidFeeTier(fee) {
			return nil, fmt.Errorf("unsupported fee tier %d (expected one of 100, 500, 3000, 10000)", fee)
		}
		if !seen[fee] {
			seen[fee] = true
			tiers = append(tiers, fee)
		}
	}
	if len(tiers) == 0 {
		return nil, errors.New("at least one fee tier is required")
	}
	return tiers, nil
}

func describeHops(byID map[uint64]ring.Offer, r ring.Ring) []hopSummary {
	n := len(r.IDs)
	hops := make([]hopSummary, n)
	for i := 0; i < n; i++ {
		from := byID[r.IDs[i]]
		to := byID[r.IDs[(i+1)%n]]
		hs := hopSummary{
			FromOffer: from.ID,
			FromOwner: from.Owner,
			ToOffer:   to.ID,
			ToOwner:   to.Owner,
			Give:      from.Give.String(),
			Want:      to.Want.String(),
			Bridged:   i == r.BridgedHop,
		}
		if i == r.BridgedHop && r.Bridge != nil {
			hs.Fee = r.Bridge.Fee
			hs.QuoteOut = r.Bridge.ExpectedOut
		}
		hops[i] = hs
	}
	return hops
}

func buildGnokeyCommand(realm, funcName, idsArg string, fee uint32, gasFee string, gasWanted, maxDeposit int64, chainID, remote, key string, simulateOnly bool) string {
	maxDepositCoin := strconv.FormatInt(maxDeposit, 10) + "ugnot"
	broadcastFlag := "-broadcast"
	if simulateOnly {
		broadcastFlag = "-broadcast -simulate only"
	}
	if funcName == "SettleRingVia" {
		return fmt.Sprintf(
			"gnokey maketx call -pkgpath %s -func SettleRingVia -args %s -args %s -gas-fee %s -gas-wanted %d -max-deposit %s -chainid %s -remote %s %s %s",
			shellQuote(realm),
			shellQuote(idsArg),
			shellQuote(strconv.FormatUint(uint64(fee), 10)),
			shellQuote(gasFee),
			gasWanted,
			shellQuote(maxDepositCoin),
			shellQuote(chainID),
			shellQuote(remote),
			broadcastFlag,
			key,
		)
	}
	return fmt.Sprintf(
		"gnokey maketx call -pkgpath %s -func SettleRing -args %s -gas-fee %s -gas-wanted %d -max-deposit %s -chainid %s -remote %s %s %s",
		shellQuote(realm),
		shellQuote(idsArg),
		shellQuote(gasFee),
		gasWanted,
		shellQuote(maxDepositCoin),
		shellQuote(chainID),
		shellQuote(remote),
		broadcastFlag,
		key,
	)
}

func shellQuote(s string) string {
	return "'" + strings.ReplaceAll(s, "'", `'\''`) + "'"
}

func writeTextOutput(w io.Writer, out solverOutput) {
	fmt.Fprintf(w, "Kylix solver (%s, height %d)\n", sanitizeText(out.Realm), out.Height)
	fmt.Fprintf(w, "Offers: %d eligible / %d total | Candidates: %d | Selected: %d | Steps: %d",
		out.Stats.OffersEligible, out.Stats.OffersInput, out.CandidateCount, len(out.Selected), out.Stats.Steps)
	if out.Stats.OffersSkippedExpiry > 0 {
		fmt.Fprintf(w, " | Skipped near/past expiry: %d", out.Stats.OffersSkippedExpiry)
	}
	if out.RPCCalls > 0 {
		fmt.Fprintf(w, " | RPC calls: %d", out.RPCCalls)
	}
	fmt.Fprintln(w)
	if out.Stats.Truncated {
		fmt.Fprintf(w, "Note: search hit bound (%s); results are a bounded subset.\n", sanitizeText(out.Stats.TruncatedReason))
	}
	if out.SkippedUnofficial > 0 {
		fmt.Fprintf(w, "Skipped %d offer(s) touching unofficial collection(s) (pass --allow-unofficial to include).\n", out.SkippedUnofficial)
	}
	for _, warn := range out.Warnings {
		fmt.Fprintf(w, "Warning: %s\n", sanitizeText(warn))
	}
	for _, d := range out.DroppedUndeliverable {
		fmt.Fprintf(w, "Dropped ring [%s]: offer #%d undeliverable (%s)\n", sanitizeText(d.IDsArg), d.OfferID, sanitizeText(d.Reason))
	}
	for _, warn := range out.DeliverableWarnings {
		fmt.Fprintf(w, "Warning: %s\n", sanitizeText(warn))
	}

	if len(out.Selected) == 0 {
		if out.MayBeIncomplete {
			if out.IncompleteReason != "" {
				fmt.Fprintf(w, "\nNo settleable rings found (%s).\n", sanitizeText(out.IncompleteReason))
			} else {
				fmt.Fprintln(w, "\nNo settleable rings found (result may be incomplete).")
			}
		} else {
			fmt.Fprintln(w, "\nNo settleable rings found.")
		}
		return
	}

	for idx, r := range out.Selected {
		kind := "direct"
		if r.Bridged {
			kind = fmt.Sprintf("bridged hop %d, fee %d", r.BridgedHop, r.Fee)
		}
		fmt.Fprintf(w, "\nRing %d: [%s] (%d legs, %s, max-deposit %dugnot)\n", idx+1, sanitizeText(r.IDsArg), r.Legs, kind, r.MaxDeposit)
		if r.Warning != "" {
			fmt.Fprintf(w, "  WARNING: %s\n", sanitizeText(r.Warning))
		}
		for _, h := range r.Hops {
			if h.Bridged {
				fmt.Fprintf(w, "  #%d (%s) --[%s --GnoSwap(fee=%d, ~%d)--> %s]--> #%d (%s)\n",
					h.FromOffer, sanitizeText(h.FromOwner), sanitizeText(h.Give), h.Fee, h.QuoteOut, sanitizeText(h.Want), h.ToOffer, sanitizeText(h.ToOwner))
			} else {
				fmt.Fprintf(w, "  #%d (%s) --[%s]--> #%d (%s)\n",
					h.FromOffer, sanitizeText(h.FromOwner), sanitizeText(h.Give), h.ToOffer, sanitizeText(h.ToOwner))
			}
		}
		if r.SimulateCommand != "" {
			fmt.Fprintf(w, "  Simulate: %s\n", sanitizeText(r.SimulateCommand))
			fmt.Fprintf(w, "  Settle:   %s\n", sanitizeText(r.GnokeyCommand))
		} else {
			fmt.Fprintf(w, "  %s\n", sanitizeText(r.GnokeyCommand))
		}
	}
}
