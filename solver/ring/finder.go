package ring

import (
	"fmt"
	"sort"
)

const (
	// DefaultMaxFanout caps how many direct out-neighbors are explored per
	// offer (preferring distinct owners first, oldest matching offers within
	// each round) so dense token markets stay bounded.
	DefaultMaxFanout = 64

	// DefaultMaxPerOwner caps how many offers from a single owner are kept for
	// each wanted asset so one address cannot fill a neighbor list.
	DefaultMaxPerOwner = 4

	// DefaultMaxSteps caps total DFS node visits across the search.
	DefaultMaxSteps = 500_000

	// DefaultMaxStepsPerStart caps DFS node visits starting from any single
	// offer so one dense cluster cannot starve the rest of the book.
	DefaultMaxStepsPerStart = 2_000

	// DefaultMaxRings caps total candidate rings collected before selection.
	DefaultMaxRings = 10_000

	// DefaultMaxRingsPerStart caps candidate rings collected from any single
	// start offer so a few dead starts cannot exhaust DefaultMaxRings and hide
	// rings elsewhere in the book.
	DefaultMaxRingsPerStart = 100
)

// QuoteFunc estimates the net output amount and chosen GnoSwap pool fee tier
// (100, 500, 3000, or 10000) of swapping amountIn of tokenIn into tokenOut.
// ok is false when no pool or insufficient liquidity exists for the swap. A
// non-nil err aborts that hop (and is treated as unquotable for the hop).
type QuoteFunc func(tokenIn, tokenOut string, amountIn int64) (amountOut int64, fee uint32, ok bool, err error)

// Options controls search bounds for FindRings. Zero values use the package
// defaults; negative values disable the corresponding bound (intended for
// exhaustive tests on small books).
type Options struct {
	MaxFanout int
	// MaxPerOwner caps how many offers from any single owner are kept for each
	// wanted asset (0 uses DefaultMaxPerOwner, unless MaxFanout < 0 in which
	// case it is also unlimited; negative disables the cap).
	MaxPerOwner      int
	MaxSteps         int
	MaxStepsPerStart int
	MaxRings         int
	// MaxRingsPerStart caps candidate rings collected from any single start
	// offer (0 uses DefaultMaxRingsPerStart, unless MaxRings < 0 in which case
	// it is also unlimited; negative disables the cap).
	MaxRingsPerStart int
	// MaxQuotes optionally caps distinct uncached quote calls (0 = unlimited).
	MaxQuotes int
	// ExpiryMargin skips offers expiring within this many blocks of
	// Graph.Height (i.e., when offer.Expiry - Graph.Height < ExpiryMargin, for
	// offers with Expiry > 0). Zero checks only already-expired offers.
	ExpiryMargin int64
	// IgnoreExpiry disables filtering offers by Expiry.
	IgnoreExpiry bool
	// OfficialOnly removes offers touching unofficial (or unlisted) item
	// collections before building adjacency or running DFS.
	OfficialOnly bool
}

// Stats summarizes the search work and whether any bound truncated it.
type Stats struct {
	OffersInput             int    `json:"offersInput"`
	OffersEligible          int    `json:"offersEligible"`
	OffersSkippedExpiry     int    `json:"offersSkippedExpiry,omitempty"`
	OffersSkippedUnofficial int    `json:"offersSkippedUnofficial,omitempty"`
	Steps                   int    `json:"steps"`
	QuotesCalled            int    `json:"quotesCalled"`
	QuotesCached            int    `json:"quotesCached"`
	Truncated               bool   `json:"truncated"`
	TruncatedReason         string `json:"truncatedReason,omitempty"`
}

// Result holds all candidate rings discovered by FindRings plus search metrics.
type Result struct {
	Rings []Ring `json:"rings"`
	Stats Stats  `json:"stats"`
	// BlockingOffers holds prioritized, deduplicated offer IDs that occupied
	// a truncated bound (max_fanout, max_per_owner, max_steps_per_start,
	// max_steps, max_rings_per_start, max_rings, or max_quotes) when
	// Stats.Truncated is true. Empty when no search bound was hit.
	BlockingOffers []uint64 `json:"-"`
}

// BridgedScanResult holds structurally bridgeable offer IDs along with any
// truncation details and blocking offer IDs from the structural scan.
type BridgedScanResult struct {
	Offers          []uint64
	Truncated       bool
	TruncatedReason string
	BlockingOffers  []uint64
}

type itemKey struct {
	collection string
	id         string
}

type quoteKey struct {
	tokenIn  string
	tokenOut string
	amountIn int64
}

type quoteVal struct {
	out int64
	fee uint32
	ok  bool
}

func (o Options) resolved() Options {
	if o.MaxFanout == 0 {
		o.MaxFanout = DefaultMaxFanout
	}
	if o.MaxPerOwner == 0 {
		if o.MaxFanout < 0 {
			o.MaxPerOwner = -1
		} else {
			o.MaxPerOwner = DefaultMaxPerOwner
		}
	}
	if o.MaxSteps == 0 {
		o.MaxSteps = DefaultMaxSteps
	}
	if o.MaxStepsPerStart == 0 {
		o.MaxStepsPerStart = DefaultMaxStepsPerStart
	}
	if o.MaxRings == 0 {
		o.MaxRings = DefaultMaxRings
	}
	if o.MaxRingsPerStart == 0 {
		if o.MaxRings < 0 {
			o.MaxRingsPerStart = -1
		} else {
			o.MaxRingsPerStart = DefaultMaxRingsPerStart
		}
	}
	return o
}

// FindRings finds every settleable ring of MinLegs..MaxLegs offers in g,
// deduplicated across rotations (each ring is rotated so its smallest offer ID
// is first). When quote is non-nil, rings with at most one GnoSwap-bridged
// fungible-to-fungible hop are also found.
//
// Search structure:
//   - Direct-only rings (0 bridges): DFS along direct edges starting at each
//     offer s and stepping only to offers with ID > s.ID, so every cycle is
//     visited once in canonical rotation.
//   - 1-bridged rings: deleting the single bridged hop (u -> v) leaves a unique
//     direct path (v -> ... -> u) of 2..6 offers where v wants a fungible token
//     and u gives a different fungible token. DFS therefore traverses only
//     direct edges and tests the closing bridge at each path end, never
//     branching on O(N^2) bridged edges in the middle of the search.
func FindRings(g Graph, quote QuoteFunc, opts Options) Result {
	cfg := opts.resolved()
	res := Result{
		Stats: Stats{
			OffersInput: len(g.Offers),
		},
	}

	offers, skippedExpiry, skippedUnofficial := filterEligibleOffers(g, cfg.IgnoreExpiry, cfg.ExpiryMargin, cfg.OfficialOnly)
	res.Stats.OffersEligible = len(offers)
	res.Stats.OffersSkippedExpiry = skippedExpiry
	res.Stats.OffersSkippedUnofficial = skippedUnofficial
	if len(offers) < MinLegs {
		return res
	}

	adjRes := buildDirectAdjacency(offers, cfg.MaxFanout, cfg.MaxPerOwner)
	adj := adjRes.adj
	if adjRes.fanoutTruncated {
		markTruncated(&res.Stats, "max_fanout")
	} else if adjRes.perOwnerTruncated {
		markTruncated(&res.Stats, "max_per_owner")
	}

	hitMaxStepsPerStart := false
	hitMaxSteps := false
	hitMaxRingsPerStart := false
	hitMaxRings := false
	hitMaxQuotes := false

	seen := make(map[string]struct{})
	addRing := func(r Ring) (bool, bool) {
		key := canonicalRingKey(r.IDs)
		if _, dup := seen[key]; dup {
			return false, false
		}
		seen[key] = struct{}{}
		res.Rings = append(res.Rings, r)
		if cfg.MaxRings > 0 && len(res.Rings) >= cfg.MaxRings {
			hitMaxRings = true
			markTruncated(&res.Stats, "max_rings")
			return true, true
		}
		return true, false
	}

	// Step-blame accumulators: flat slices indexed by offer index so DFS has
	// zero per-step map lookups or allocations.
	allStepBlame := make([]int, len(offers))
	truncStartBlame := make([]int, len(offers))
	startBlame := make([]int, len(offers))
	touched := make([]int, 0, 64)
	var perStartRingCounts map[uint64]int
	var quoteBlame []int

	// Phase 1: direct-only rings (0 bridges).
	directStepLimit := cfg.MaxSteps
	if quote != nil && cfg.MaxSteps > 0 {
		// Reserve half the global budget for direct rings; any unused steps
		// roll over to Phase 2.
		directStepLimit = cfg.MaxSteps / 2
		if directStepLimit < 1 {
			directStepLimit = 1
		}
	}
	directPerStart := fairPerStart(cfg.MaxStepsPerStart, directStepLimit, len(offers))

	var path [MaxLegs]int
	var owners [MaxLegs]string
	var givenItems [MaxLegs]itemKey
	var givenItemCount int

	for start := 0; start < len(offers); start++ {
		if cfg.MaxRings > 0 && len(res.Rings) >= cfg.MaxRings {
			break
		}
		if directStepLimit > 0 && res.Stats.Steps >= directStepLimit {
			hitMaxSteps = true
			markTruncated(&res.Stats, "max_steps")
			break
		}

		path[0] = start
		owners[0] = offers[start].Owner
		givenItemCount = 0
		if offers[start].Give.Kind == KindItem {
			givenItems[0] = itemKey{offers[start].Give.Key, offers[start].Give.ID}
			givenItemCount = 1
		}

		startSteps := 0
		startRings := 0
		startHitPerStart := false
		startHitMaxRings := false
		ringsStartIdx := len(res.Rings)
		var dfsDirect func(depth int)
		dfsDirect = func(depth int) {
			if (cfg.MaxRings > 0 && len(res.Rings) >= cfg.MaxRings) ||
				(cfg.MaxRingsPerStart > 0 && startRings >= cfg.MaxRingsPerStart) {
				return
			}
			u := path[depth-1]
			for _, v := range adj[u] {
				if v <= start {
					continue
				}
				if directPerStart > 0 && startSteps >= directPerStart {
					startHitPerStart = true
					hitMaxStepsPerStart = true
					markTruncated(&res.Stats, "max_steps_per_start")
					return
				}
				if directStepLimit > 0 && res.Stats.Steps >= directStepLimit {
					hitMaxSteps = true
					markTruncated(&res.Stats, "max_steps")
					return
				}
				if !canAppend(offers, path[:depth], owners[:depth], givenItems[:givenItemCount], v) {
					continue
				}

				before := startSteps
				startSteps++
				res.Stats.Steps++

				path[depth] = v
				owners[depth] = offers[v].Owner
				addedItem := false
				if offers[v].Give.Kind == KindItem {
					givenItems[givenItemCount] = itemKey{offers[v].Give.Key, offers[v].Give.ID}
					givenItemCount++
					addedItem = true
				}

				nextDepth := depth + 1
				hitRings := false
				if nextDepth >= MinLegs && satisfiesDirect(offers[v].Give, offers[start].Want) {
					ids := make([]uint64, nextDepth)
					for i := 0; i < nextDepth; i++ {
						ids[i] = offers[path[i]].ID
					}
					added, hitGlobal := addRing(Ring{IDs: ids, BridgedHop: NoBridge})
					if added {
						startRings++
						if cfg.MaxRingsPerStart > 0 && startRings >= cfg.MaxRingsPerStart {
							startHitMaxRings = true
							hitMaxRingsPerStart = true
							markTruncated(&res.Stats, "max_rings_per_start")
						}
					}
					hitRings = hitGlobal || startHitMaxRings
				}
				if !hitRings && nextDepth < MaxLegs {
					dfsDirect(nextDepth)
				}
				if addedItem {
					givenItemCount--
				}
				delta := startSteps - before
				if startBlame[v] == 0 {
					touched = append(touched, v)
				}
				startBlame[v] += delta
				if hitRings || startHitMaxRings || (cfg.MaxRings > 0 && len(res.Rings) >= cfg.MaxRings) {
					return
				}
			}
		}
		dfsDirect(1)

		if startHitMaxRings {
			if perStartRingCounts == nil {
				perStartRingCounts = make(map[uint64]int)
			}
			for _, r := range res.Rings[ringsStartIdx:] {
				for _, id := range r.IDs {
					perStartRingCounts[id]++
				}
			}
		}

		allStepBlame[start] += startSteps
		for _, idx := range touched {
			allStepBlame[idx] += startBlame[idx]
			if startHitPerStart {
				truncStartBlame[idx] += startBlame[idx]
			}
			startBlame[idx] = 0
		}
		touched = touched[:0]
	}

	// Phase 2: 1-bridged rings (only when a quoter is provided).
	if quote != nil && !(cfg.MaxRings > 0 && len(res.Rings) >= cfg.MaxRings) {
		fungibleGiveKeys := make(map[string]struct{})
		var bridgedStarts []int
		for i := range offers {
			if offers[i].Give.Kind == KindFungible {
				fungibleGiveKeys[offers[i].Give.Key] = struct{}{}
			}
		}
		for i := range offers {
			if offers[i].Want.Kind != KindFungible {
				continue
			}
			// Need at least one fungible token in the book other than Want.Key.
			if len(fungibleGiveKeys) == 0 {
				continue
			}
			if len(fungibleGiveKeys) == 1 {
				if _, onlySelf := fungibleGiveKeys[offers[i].Want.Key]; onlySelf {
					continue
				}
			}
			bridgedStarts = append(bridgedStarts, i)
		}

		if len(bridgedStarts) > 0 {
			// Visit distinct owners first (round-robin by owner, oldest offer
			// first within each round) so one owner's spam offers cannot
			// exhaust MaxQuotes before other owners are quoted.
			bridgedStarts = roundRobinByOwner(offers, bridgedStarts)

			remainingSteps := -1
			if cfg.MaxSteps > 0 {
				remainingSteps = cfg.MaxSteps - res.Stats.Steps
				if remainingSteps <= 0 {
					hitMaxSteps = true
					markTruncated(&res.Stats, "max_steps")
				}
			}
			bridgedPerStart := fairPerStart(cfg.MaxStepsPerStart, remainingSteps, len(bridgedStarts))
			quoteCache := make(map[quoteKey]quoteVal)
			quoteBlame = make([]int, len(offers))

			getQuote := func(tokenIn, tokenOut string, amountIn int64, activePath []int) (int64, uint32, bool) {
				k := quoteKey{tokenIn: tokenIn, tokenOut: tokenOut, amountIn: amountIn}
				if cached, ok := quoteCache[k]; ok {
					res.Stats.QuotesCached++
					return cached.out, cached.fee, cached.ok
				}
				if cfg.MaxQuotes > 0 && res.Stats.QuotesCalled >= cfg.MaxQuotes {
					hitMaxQuotes = true
					markTruncated(&res.Stats, "max_quotes")
					return 0, 0, false
				}
				res.Stats.QuotesCalled++
				for _, idx := range activePath {
					quoteBlame[idx]++
				}
				out, fee, ok, err := quote(tokenIn, tokenOut, amountIn)
				if err != nil || !ok || out <= 0 {
					quoteCache[k] = quoteVal{out: 0, fee: 0, ok: false}
					return 0, 0, false
				}
				quoteCache[k] = quoteVal{out: out, fee: fee, ok: true}
				return out, fee, true
			}

			for _, start := range bridgedStarts {
				if cfg.MaxRings > 0 && len(res.Rings) >= cfg.MaxRings {
					break
				}
				if cfg.MaxSteps > 0 && res.Stats.Steps >= cfg.MaxSteps {
					hitMaxSteps = true
					markTruncated(&res.Stats, "max_steps")
					break
				}

				path[0] = start
				owners[0] = offers[start].Owner
				givenItemCount = 0
				if offers[start].Give.Kind == KindItem {
					givenItems[0] = itemKey{offers[start].Give.Key, offers[start].Give.ID}
					givenItemCount = 1
				}

				startSteps := 0
				startRings := 0
				startHitPerStart := false
				startHitMaxRings := false
				ringsStartIdx := len(res.Rings)
				var dfsBridged func(depth int)
				dfsBridged = func(depth int) {
					if (cfg.MaxRings > 0 && len(res.Rings) >= cfg.MaxRings) ||
						(cfg.MaxRingsPerStart > 0 && startRings >= cfg.MaxRingsPerStart) {
						return
					}
					u := path[depth-1]
					for _, v := range adj[u] {
						if bridgedPerStart > 0 && startSteps >= bridgedPerStart {
							startHitPerStart = true
							hitMaxStepsPerStart = true
							markTruncated(&res.Stats, "max_steps_per_start")
							return
						}
						if cfg.MaxSteps > 0 && res.Stats.Steps >= cfg.MaxSteps {
							hitMaxSteps = true
							markTruncated(&res.Stats, "max_steps")
							return
						}
						if !canAppend(offers, path[:depth], owners[:depth], givenItems[:givenItemCount], v) {
							continue
						}

						before := startSteps
						startSteps++
						res.Stats.Steps++

						path[depth] = v
						owners[depth] = offers[v].Owner
						addedItem := false
						if offers[v].Give.Kind == KindItem {
							givenItems[givenItemCount] = itemKey{offers[v].Give.Key, offers[v].Give.ID}
							givenItemCount++
							addedItem = true
						}

						nextDepth := depth + 1
						hitRings := false
						// Closing hop (v -> start) is the unique bridged hop.
						if nextDepth >= MinLegs &&
							offers[v].Give.Kind == KindFungible &&
							offers[v].Give.Key != offers[start].Want.Key {
							if out, fee, ok := getQuote(offers[v].Give.Key, offers[start].Want.Key, offers[v].Give.Amount, path[:nextDepth]); ok && out >= offers[start].Want.Amount {
								r := canonicalizeRing(offers, path[:nextDepth], nextDepth-1, out, fee)
								added, hitGlobal := addRing(r)
								if added {
									startRings++
									if cfg.MaxRingsPerStart > 0 && startRings >= cfg.MaxRingsPerStart {
										startHitMaxRings = true
										hitMaxRingsPerStart = true
										markTruncated(&res.Stats, "max_rings_per_start")
									}
								}
								hitRings = hitGlobal || startHitMaxRings
							}
						}

						if !hitRings && nextDepth < MaxLegs {
							dfsBridged(nextDepth)
						}
						if addedItem {
							givenItemCount--
						}
						delta := startSteps - before
						if startBlame[v] == 0 {
							touched = append(touched, v)
						}
						startBlame[v] += delta
						if hitRings || startHitMaxRings || (cfg.MaxRings > 0 && len(res.Rings) >= cfg.MaxRings) {
							return
						}
					}
				}
				dfsBridged(1)

				if startHitMaxRings {
					if perStartRingCounts == nil {
						perStartRingCounts = make(map[uint64]int)
					}
					for _, r := range res.Rings[ringsStartIdx:] {
						for _, id := range r.IDs {
							perStartRingCounts[id]++
						}
					}
				}

				allStepBlame[start] += startSteps
				for _, idx := range touched {
					allStepBlame[idx] += startBlame[idx]
					if startHitPerStart {
						truncStartBlame[idx] += startBlame[idx]
					}
					startBlame[idx] = 0
				}
				touched = touched[:0]
			}
		}
	}

	sortRingsCanonical(res.Rings)
	if res.Stats.Truncated {
		res.BlockingOffers = collectBlockingOffers(
			offers,
			adjRes,
			hitMaxStepsPerStart, truncStartBlame,
			hitMaxSteps, allStepBlame,
			hitMaxRingsPerStart, perStartRingCounts,
			hitMaxRings, res.Rings,
			hitMaxQuotes, quoteBlame,
		)
	}
	return res
}

// FindBridgedCandidateOffers performs a zero-RPC structural scan of Phase 2
// (1-bridged) direct paths and returns up to maxOffers unique offer IDs (not
// present in skipIDs) that participate in at least one structurally bridgeable
// ring (where the closing hop gives a fungible token different from the start
// offer's wanted fungible token). It follows the same distinct-owner priority
// order as FindRings so callers can batch-screen deliverability before spending
// GnoSwap quote RPCs.
func FindBridgedCandidateOffers(g Graph, opts Options, skipIDs map[uint64]bool, maxOffers int) []uint64 {
	return ScanBridgedCandidates(g, opts, skipIDs, maxOffers).Offers
}

// ScanBridgedCandidates performs the same zero-RPC structural scan as
// FindBridgedCandidateOffers and also reports whether any search bound was hit
// along with prioritized blocking offer IDs.
func ScanBridgedCandidates(g Graph, opts Options, skipIDs map[uint64]bool, maxOffers int) BridgedScanResult {
	var res BridgedScanResult
	cfg := opts.resolved()
	offers, _, _ := filterEligibleOffers(g, cfg.IgnoreExpiry, cfg.ExpiryMargin, cfg.OfficialOnly)
	if len(offers) < MinLegs {
		return res
	}
	adjRes := buildDirectAdjacency(offers, cfg.MaxFanout, cfg.MaxPerOwner)
	adj := adjRes.adj
	markScanTrunc := func(reason string) {
		if !res.Truncated {
			res.Truncated = true
			res.TruncatedReason = reason
		}
	}
	if adjRes.fanoutTruncated {
		markScanTrunc("max_fanout")
	} else if adjRes.perOwnerTruncated {
		markScanTrunc("max_per_owner")
	}

	fungibleGiveKeys := make(map[string]struct{})
	for i := range offers {
		if offers[i].Give.Kind == KindFungible {
			fungibleGiveKeys[offers[i].Give.Key] = struct{}{}
		}
	}
	if len(fungibleGiveKeys) == 0 {
		if res.Truncated {
			res.BlockingOffers = collectBlockingOffers(offers, adjRes, false, nil, false, nil, false, nil, false, nil, false, nil)
		}
		return res
	}
	var bridgedStarts []int
	for i := range offers {
		if offers[i].Want.Kind != KindFungible {
			continue
		}
		if len(fungibleGiveKeys) == 1 {
			if _, onlySelf := fungibleGiveKeys[offers[i].Want.Key]; onlySelf {
				continue
			}
		}
		bridgedStarts = append(bridgedStarts, i)
	}
	if len(bridgedStarts) == 0 {
		if res.Truncated {
			res.BlockingOffers = collectBlockingOffers(offers, adjRes, false, nil, false, nil, false, nil, false, nil, false, nil)
		}
		return res
	}
	bridgedStarts = roundRobinByOwner(offers, bridgedStarts)

	stepLimit := cfg.MaxSteps
	if stepLimit > 0 {
		stepLimit = stepLimit / 2
		if stepLimit < 1 {
			stepLimit = 1
		}
	}
	perStart := fairPerStart(cfg.MaxStepsPerStart, stepLimit, len(bridgedStarts))

	allStepBlame := make([]int, len(offers))
	truncStartBlame := make([]int, len(offers))
	startBlame := make([]int, len(offers))
	touched := make([]int, 0, 64)
	hitMaxStepsPerStart := false
	hitMaxSteps := false

	var out []uint64
	added := make(map[uint64]struct{})
	var path [MaxLegs]int
	var owners [MaxLegs]string
	var givenItems [MaxLegs]itemKey
	var givenItemCount int
	totalSteps := 0

	for _, start := range bridgedStarts {
		if maxOffers > 0 && len(out) >= maxOffers {
			break
		}
		if stepLimit > 0 && totalSteps >= stepLimit {
			hitMaxSteps = true
			markScanTrunc("max_steps")
			break
		}

		path[0] = start
		owners[0] = offers[start].Owner
		givenItemCount = 0
		if offers[start].Give.Kind == KindItem {
			givenItems[0] = itemKey{offers[start].Give.Key, offers[start].Give.ID}
			givenItemCount = 1
		}

		startSteps := 0
		startHitPerStart := false
		var dfs func(depth int)
		dfs = func(depth int) {
			if maxOffers > 0 && len(out) >= maxOffers {
				return
			}
			u := path[depth-1]
			for _, v := range adj[u] {
				if perStart > 0 && startSteps >= perStart {
					startHitPerStart = true
					hitMaxStepsPerStart = true
					markScanTrunc("max_steps_per_start")
					return
				}
				if stepLimit > 0 && totalSteps >= stepLimit {
					hitMaxSteps = true
					markScanTrunc("max_steps")
					return
				}
				if !canAppend(offers, path[:depth], owners[:depth], givenItems[:givenItemCount], v) {
					continue
				}

				before := startSteps
				startSteps++
				totalSteps++

				path[depth] = v
				owners[depth] = offers[v].Owner
				addedItem := false
				if offers[v].Give.Kind == KindItem {
					givenItems[givenItemCount] = itemKey{offers[v].Give.Key, offers[v].Give.ID}
					givenItemCount++
					addedItem = true
				}

				nextDepth := depth + 1
				if nextDepth >= MinLegs &&
					offers[v].Give.Kind == KindFungible &&
					offers[v].Give.Key != offers[start].Want.Key {
					for i := 0; i < nextDepth; i++ {
						id := offers[path[i]].ID
						if skipIDs[id] {
							continue
						}
						if _, ok := added[id]; ok {
							continue
						}
						added[id] = struct{}{}
						out = append(out, id)
						if maxOffers > 0 && len(out) >= maxOffers {
							break
						}
					}
				}

				if nextDepth < MaxLegs && !(maxOffers > 0 && len(out) >= maxOffers) {
					dfs(nextDepth)
				}
				if addedItem {
					givenItemCount--
				}
				delta := startSteps - before
				if startBlame[v] == 0 {
					touched = append(touched, v)
				}
				startBlame[v] += delta
				if maxOffers > 0 && len(out) >= maxOffers {
					return
				}
			}
		}
		dfs(1)

		allStepBlame[start] += startSteps
		for _, idx := range touched {
			allStepBlame[idx] += startBlame[idx]
			if startHitPerStart {
				truncStartBlame[idx] += startBlame[idx]
			}
			startBlame[idx] = 0
		}
		touched = touched[:0]
	}

	res.Offers = out
	if res.Truncated {
		res.BlockingOffers = collectBlockingOffers(
			offers,
			adjRes,
			hitMaxStepsPerStart, truncStartBlame,
			hitMaxSteps, allStepBlame,
			false, nil,
			false, nil,
			false, nil,
		)
	}
	return res
}

func isExpiredOrNear(height, expiry, margin int64) bool {
	if height <= 0 || expiry <= 0 {
		return false
	}
	if margin < 0 {
		margin = 0
	}
	if height > expiry {
		return true
	}
	// Here 0 < height <= expiry, so expiry - height >= 0 cannot overflow int64.
	return expiry-height < margin
}

func filterEligibleOffers(g Graph, ignoreExpiry bool, expiryMargin int64, officialOnly bool) ([]Offer, int, int) {
	if expiryMargin < 0 {
		expiryMargin = 0
	}
	var cols map[string]Collection
	if officialOnly {
		cols = IndexCollections(g.Collections)
	}
	seenID := make(map[uint64]struct{}, len(g.Offers))
	out := make([]Offer, 0, len(g.Offers))
	skippedExpiry := 0
	skippedUnofficial := 0
	for _, o := range g.Offers {
		if o.ID == 0 || o.Owner == "" {
			continue
		}
		if _, dup := seenID[o.ID]; dup {
			continue
		}
		if !ignoreExpiry && isExpiredOrNear(g.Height, o.Expiry, expiryMargin) {
			skippedExpiry++
			continue
		}
		if o.Give.Validate() != nil || o.Want.Validate() != nil {
			continue
		}
		if o.Give.SameAs(o.Want) {
			continue
		}
		if officialOnly && OfferTouchesUnofficial(o, cols) {
			skippedUnofficial++
			continue
		}
		seenID[o.ID] = struct{}{}
		out = append(out, o)
	}
	sort.Slice(out, func(i, j int) bool {
		return out[i].ID < out[j].ID
	})
	return out, skippedExpiry, skippedUnofficial
}

// capPerOwner keeps at most maxPerOwner indices per offer owner in idxs,
// preserving existing order. Returns the kept slice, whether any index was
// dropped, and the kept indices belonging to owners who had at least one offer
// dropped.
func capPerOwner(offers []Offer, idxs []int, maxPerOwner int) ([]int, bool, []int) {
	if maxPerOwner <= 0 || len(idxs) <= maxPerOwner {
		return idxs, false, nil
	}
	counts := make(map[string]int)
	kept := make([]int, 0, len(idxs))
	var droppedOwners map[string]bool
	for _, idx := range idxs {
		owner := offers[idx].Owner
		if counts[owner] >= maxPerOwner {
			if droppedOwners == nil {
				droppedOwners = make(map[string]bool)
			}
			droppedOwners[owner] = true
			continue
		}
		counts[owner]++
		kept = append(kept, idx)
	}
	if len(droppedOwners) == 0 {
		return kept, false, nil
	}
	var blockers []int
	for _, idx := range kept {
		if droppedOwners[offers[idx].Owner] {
			blockers = append(blockers, idx)
		}
	}
	return kept, true, blockers
}

// roundRobinByOwner reorders idxs into strata by per-owner occurrence count:
// first the 1st offer from each distinct owner (in original order), then the
// 2nd offer from each distinct owner, and so on. This ensures distinct owners
// are always preferred before truncating at MaxFanout or spending quotes.
func roundRobinByOwner(offers []Offer, idxs []int) []int {
	if len(idxs) <= 1 {
		return idxs
	}
	ownerCount := make(map[string]int)
	var rounds [][]int
	for _, idx := range idxs {
		owner := offers[idx].Owner
		r := ownerCount[owner]
		ownerCount[owner] = r + 1
		if r >= len(rounds) {
			rounds = append(rounds, nil)
		}
		rounds[r] = append(rounds[r], idx)
	}
	if len(rounds) <= 1 {
		return idxs
	}
	out := make([]int, 0, len(idxs))
	for _, bucket := range rounds {
		out = append(out, bucket...)
	}
	return out
}

type adjacencyResult struct {
	adj               [][]int
	fanoutTruncated   bool
	perOwnerTruncated bool
	fanoutBlockers    []uint64
	perOwnerBlockers  []uint64
}

func assetBucketKey(a Asset) string {
	if a.Kind == KindItem {
		return "i:" + a.Key + "#" + a.ID
	}
	return "f:" + a.Key
}

func buildDirectAdjacency(offers []Offer, maxFanout, maxPerOwner int) adjacencyResult {
	wantItems := make(map[itemKey][]int)
	wantFungible := make(map[string][]int)

	for i, o := range offers {
		switch o.Want.Kind {
		case KindItem:
			k := itemKey{o.Want.Key, o.Want.ID}
			wantItems[k] = append(wantItems[k], i)
		case KindFungible:
			wantFungible[o.Want.Key] = append(wantFungible[o.Want.Key], i)
		}
	}

	perOwnerTruncated := false
	var perOwnerBlockerSet map[uint64]struct{}
	addPerOwnerBlockers := func(idxs []int) {
		if len(idxs) == 0 {
			return
		}
		if perOwnerBlockerSet == nil {
			perOwnerBlockerSet = make(map[uint64]struct{}, len(idxs))
		}
		for _, idx := range idxs {
			perOwnerBlockerSet[offers[idx].ID] = struct{}{}
		}
	}

	for k, idxs := range wantItems {
		kept, dropped, blockers := capPerOwner(offers, idxs, maxPerOwner)
		wantItems[k] = kept
		if dropped {
			perOwnerTruncated = true
			addPerOwnerBlockers(blockers)
		}
	}
	for k, idxs := range wantFungible {
		sort.Slice(idxs, func(a, b int) bool {
			wa, wb := offers[idxs[a]].Want.Amount, offers[idxs[b]].Want.Amount
			if wa != wb {
				return wa < wb
			}
			return idxs[a] < idxs[b]
		})
		kept, dropped, blockers := capPerOwner(offers, idxs, maxPerOwner)
		wantFungible[k] = kept
		if dropped {
			perOwnerTruncated = true
			addPerOwnerBlockers(blockers)
		}
	}

	adj := make([][]int, len(offers))
	fanoutTruncated := false
	var fanoutByAsset map[string][]uint64
	var fanoutSeen map[string]map[uint64]struct{}
	for u, o := range offers {
		var candidates []int
		switch o.Give.Kind {
		case KindItem:
			candidates = wantItems[itemKey{o.Give.Key, o.Give.ID}]
		case KindFungible:
			list := wantFungible[o.Give.Key]
			cut := sort.Search(len(list), func(i int) bool {
				return offers[list[i]].Want.Amount > o.Give.Amount
			})
			candidates = list[:cut]
		}
		if len(candidates) == 0 {
			continue
		}

		neighbors := make([]int, 0, len(candidates))
		for _, v := range candidates {
			if v == u || offers[v].Owner == o.Owner {
				continue
			}
			if o.Give.Kind == KindItem && offers[v].Give.Kind == KindItem && offers[v].Give.SameAs(o.Give) {
				continue
			}
			neighbors = append(neighbors, v)
		}
		// Keep oldest matching offers first within each owner round, preferring
		// distinct owners before truncating at maxFanout.
		if o.Give.Kind == KindFungible && len(neighbors) > 1 {
			sort.Ints(neighbors)
		}
		neighbors = roundRobinByOwner(offers, neighbors)
		if maxFanout > 0 && len(neighbors) > maxFanout {
			neighbors = neighbors[:maxFanout]
			fanoutTruncated = true
			if fanoutByAsset == nil {
				fanoutByAsset = make(map[string][]uint64)
				fanoutSeen = make(map[string]map[uint64]struct{})
			}
			ak := assetBucketKey(o.Give)
			seenSet := fanoutSeen[ak]
			if seenSet == nil {
				seenSet = make(map[uint64]struct{}, len(neighbors))
				fanoutSeen[ak] = seenSet
			}
			for _, v := range neighbors {
				id := offers[v].ID
				if _, ok := seenSet[id]; !ok {
					seenSet[id] = struct{}{}
					fanoutByAsset[ak] = append(fanoutByAsset[ak], id)
				}
			}
		}
		adj[u] = neighbors
	}

	var fanoutBlockers []uint64
	if len(fanoutByAsset) > 0 {
		// Interleave across distinct blocked asset buckets so spamming many
		// dummy offers on one fake token cannot starve screening on another.
		keys := make([]string, 0, len(fanoutByAsset))
		total := 0
		for ak, ids := range fanoutByAsset {
			keys = append(keys, ak)
			total += len(ids)
		}
		sort.Strings(keys)
		fanoutBlockers = make([]uint64, 0, total)
		emitted := make(map[uint64]struct{}, total)
		for pos := 0; ; pos++ {
			progressed := false
			for _, ak := range keys {
				ids := fanoutByAsset[ak]
				if pos >= len(ids) {
					continue
				}
				progressed = true
				id := ids[pos]
				if _, dup := emitted[id]; !dup {
					emitted[id] = struct{}{}
					fanoutBlockers = append(fanoutBlockers, id)
				}
			}
			if !progressed {
				break
			}
		}
	}

	var perOwnerBlockers []uint64
	if len(perOwnerBlockerSet) > 0 {
		perOwnerBlockers = make([]uint64, 0, len(perOwnerBlockerSet))
		for id := range perOwnerBlockerSet {
			perOwnerBlockers = append(perOwnerBlockers, id)
		}
		sort.Slice(perOwnerBlockers, func(i, j int) bool { return perOwnerBlockers[i] < perOwnerBlockers[j] })
	}

	return adjacencyResult{
		adj:               adj,
		fanoutTruncated:   fanoutTruncated,
		perOwnerTruncated: perOwnerTruncated,
		fanoutBlockers:    fanoutBlockers,
		perOwnerBlockers:  perOwnerBlockers,
	}
}

func collectBlockingOffers(
	offers []Offer,
	adjRes adjacencyResult,
	hitMaxStepsPerStart bool, truncStartBlame []int,
	hitMaxSteps bool, allStepBlame []int,
	hitMaxRingsPerStart bool, perStartRingCounts map[uint64]int,
	hitMaxRings bool, rings []Ring,
	hitMaxQuotes bool, quoteBlame []int,
) []uint64 {
	var out []uint64
	seen := make(map[uint64]struct{})
	addIDs := func(ids []uint64) {
		for _, id := range ids {
			if id == 0 {
				continue
			}
			if _, ok := seen[id]; ok {
				continue
			}
			seen[id] = struct{}{}
			out = append(out, id)
		}
	}

	if adjRes.fanoutTruncated {
		addIDs(adjRes.fanoutBlockers)
	}
	if adjRes.perOwnerTruncated {
		addIDs(adjRes.perOwnerBlockers)
	}
	if hitMaxStepsPerStart {
		addIDs(rankOffersByWeight(offers, truncStartBlame))
	}
	if hitMaxSteps {
		addIDs(rankOffersByWeight(offers, allStepBlame))
	}
	if hitMaxRingsPerStart && len(perStartRingCounts) > 0 {
		addIDs(rankIDCounts(perStartRingCounts))
	}
	if hitMaxRings && len(rings) > 0 {
		counts := make(map[uint64]int)
		for _, r := range rings {
			for _, id := range r.IDs {
				counts[id]++
			}
		}
		addIDs(rankIDCounts(counts))
	}
	if hitMaxQuotes && len(quoteBlame) > 0 {
		addIDs(rankOffersByWeight(offers, quoteBlame))
	}
	return out
}

func rankIDCounts(counts map[uint64]int) []uint64 {
	type idCount struct {
		id    uint64
		count int
	}
	ranked := make([]idCount, 0, len(counts))
	for id, c := range counts {
		if c > 0 {
			ranked = append(ranked, idCount{id: id, count: c})
		}
	}
	sort.Slice(ranked, func(i, j int) bool {
		if ranked[i].count != ranked[j].count {
			return ranked[i].count > ranked[j].count
		}
		return ranked[i].id < ranked[j].id
	})
	ids := make([]uint64, len(ranked))
	for i, rc := range ranked {
		ids[i] = rc.id
	}
	return ids
}

func rankOffersByWeight(offers []Offer, weights []int) []uint64 {
	type weighted struct {
		id     uint64
		weight int
	}
	var items []weighted
	for i, w := range weights {
		if w > 0 && i < len(offers) {
			items = append(items, weighted{id: offers[i].ID, weight: w})
		}
	}
	if len(items) == 0 {
		return nil
	}
	sort.Slice(items, func(i, j int) bool {
		if items[i].weight != items[j].weight {
			return items[i].weight > items[j].weight
		}
		return items[i].id < items[j].id
	})
	out := make([]uint64, len(items))
	for i, it := range items {
		out[i] = it.id
	}
	return out
}

func canAppend(offers []Offer, path []int, owners []string, givenItems []itemKey, v int) bool {
	for _, idx := range path {
		if idx == v {
			return false
		}
	}
	owner := offers[v].Owner
	for _, existing := range owners {
		if existing == owner {
			return false
		}
	}
	if offers[v].Give.Kind == KindItem {
		k := itemKey{offers[v].Give.Key, offers[v].Give.ID}
		for _, existing := range givenItems {
			if existing == k {
				return false
			}
		}
	}
	return true
}

func satisfiesDirect(give, want Asset) bool {
	if give.Kind != want.Kind || give.Key != want.Key {
		return false
	}
	if give.Kind == KindItem {
		return give.ID == want.ID
	}
	return give.Amount >= want.Amount
}

// canonicalizeRing rotates path so the offer with the smallest ID is at index 0
// and adjusts bridgedHop accordingly.
func canonicalizeRing(offers []Offer, path []int, bridgedHop int, expectedOut int64, fee uint32) Ring {
	n := len(path)
	minPos := 0
	for i := 1; i < n; i++ {
		if offers[path[i]].ID < offers[path[minPos]].ID {
			minPos = i
		}
	}
	ids := make([]uint64, n)
	for i := 0; i < n; i++ {
		ids[i] = offers[path[(minPos+i)%n]].ID
	}

	r := Ring{
		IDs:        ids,
		BridgedHop: NoBridge,
	}
	if bridgedHop != NoBridge {
		rotBridge := (bridgedHop - minPos + n) % n
		fromOffer := offers[path[bridgedHop]]
		toOffer := offers[path[(bridgedHop+1)%n]]
		r.BridgedHop = rotBridge
		r.Bridge = &BridgeInfo{
			FromOffer:   fromOffer.ID,
			ToOffer:     toOffer.ID,
			TokenIn:     fromOffer.Give.Key,
			TokenOut:    toOffer.Want.Key,
			AmountIn:    fromOffer.Give.Amount,
			WantMin:     toOffer.Want.Amount,
			ExpectedOut: expectedOut,
			Fee:         fee,
		}
	}
	return r
}

func canonicalRingKey(ids []uint64) string {
	return FormatOfferIDs(ids)
}

func fairPerStart(perStart, totalBudget, numStarts int) int {
	if totalBudget <= 0 || numStarts <= 0 {
		return perStart
	}
	share := totalBudget / numStarts
	if share < 32 {
		share = 32
	}
	if perStart <= 0 || share < perStart {
		return share
	}
	return perStart
}

func markTruncated(s *Stats, reason string) {
	if !s.Truncated {
		s.Truncated = true
		s.TruncatedReason = reason
	}
}

func sortRingsCanonical(rings []Ring) {
	sort.Slice(rings, func(i, j int) bool {
		return compareIDSeq(rings[i].IDs, rings[j].IDs) < 0
	})
}

func compareIDSeq(a, b []uint64) int {
	n := len(a)
	if len(b) < n {
		n = len(b)
	}
	for i := 0; i < n; i++ {
		if a[i] != b[i] {
			if a[i] < b[i] {
				return -1
			}
			return 1
		}
	}
	switch {
	case len(a) < len(b):
		return -1
	case len(a) > len(b):
		return 1
	default:
		return 0
	}
}

// String formats a concise summary of a Ring for logs and debugging.
func (r Ring) String() string {
	if r.IsBridged() {
		if r.Bridge != nil && r.Bridge.Fee > 0 {
			return fmt.Sprintf("[%s] (bridged hop %d, fee %d)", r.FormatIDs(), r.BridgedHop, r.Bridge.Fee)
		}
		return fmt.Sprintf("[%s] (bridged hop %d)", r.FormatIDs(), r.BridgedHop)
	}
	return fmt.Sprintf("[%s] (direct)", r.FormatIDs())
}
