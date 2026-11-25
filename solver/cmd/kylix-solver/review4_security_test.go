package main

import (
	"bytes"
	"context"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"

	"kylix/solver/ring"
	"kylix/solver/rpc"
)

// Inverted from security review 4 (R4-4):
// When live offers fill DefaultMaxFanout (64) and hide an honest ring, the
// screening budget is NOT exhausted, yet the final search IS truncated. Both
// JSON and text output MUST say the result may be incomplete and name the bound
// ("max_fanout").
func TestReview4_LiveFanoutTruncationReportsMayBeIncomplete(t *testing.T) {
	const (
		tokA = "gno.land/r/gnoland/wugnot.wugnot"
		tokB = "gno.land/r/gnoswap/gns.GNS"
		tokJ = "gno.land/r/evil/junk.JUNK"
	)
	offers := make([]map[string]any, 0, 66)
	id := 1
	for acc := 0; acc < 64; acc++ {
		offers = append(offers, map[string]any{
			"id": id, "owner": fmt.Sprintf("g1live%03d", acc), "nonce": 1, "slot": "g1s",
			"give":   map[string]any{"kind": "fungible", "key": tokJ, "id": "", "amount": "1"},
			"want":   map[string]any{"kind": "fungible", "key": tokA, "id": "", "amount": "1"},
			"expiry": 1000,
		})
		id++
	}
	offers = append(offers,
		map[string]any{
			"id": 100, "owner": "g1alice", "nonce": 1, "slot": "g1s",
			"give":   map[string]any{"kind": "fungible", "key": tokA, "id": "", "amount": "1000"},
			"want":   map[string]any{"kind": "fungible", "key": tokB, "id": "", "amount": "1000"},
			"expiry": 1000,
		},
		map[string]any{
			"id": 101, "owner": "g1bob", "nonce": 1, "slot": "g1s",
			"give":   map[string]any{"kind": "fungible", "key": tokB, "id": "", "amount": "1000"},
			"want":   map[string]any{"kind": "fungible", "key": tokA, "id": "", "amount": "1000"},
			"expiry": 1000,
		},
	)

	graphObj := map[string]any{
		"realm": rpc.DefaultRealmPath, "height": 500, "collections": []any{},
		"offers": offers, "hasMore": false, "next": 0, "total": len(offers),
	}
	var delivCalls atomic.Int32
	srv := startDeliverableTestServer(t, graphObj, func(uint64) bool { return true }, &delivCalls, nil)
	defer srv.Close()

	// JSON mode
	var stdout, stderr bytes.Buffer
	if err := run(context.Background(), []string{"--rpc", srv.URL, "--bridge=false", "--json"}, nil, &stdout, &stderr); err != nil {
		t.Fatalf("json run failed: %v", err)
	}
	var parsed solverOutput
	if err := json.Unmarshal(stdout.Bytes(), &parsed); err != nil {
		t.Fatal(err)
	}
	if len(parsed.Selected) != 0 {
		t.Fatalf("expected honest ring hidden by 64 live offers, got %+v", parsed.Selected)
	}
	if !parsed.Stats.Truncated || parsed.Stats.TruncatedReason != "max_fanout" {
		t.Fatalf("expected max_fanout truncation, got %+v", parsed.Stats)
	}
	if !parsed.MayBeIncomplete {
		t.Fatalf("expected MayBeIncomplete=true when live offers fill max_fanout")
	}
	if !strings.Contains(parsed.IncompleteReason, "may be incomplete") || !strings.Contains(parsed.IncompleteReason, "max_fanout") {
		t.Fatalf("expected IncompleteReason naming max_fanout and 'may be incomplete', got %q", parsed.IncompleteReason)
	}
	if !strings.Contains(stderr.String(), "may be incomplete") || !strings.Contains(stderr.String(), "max_fanout") {
		t.Fatalf("expected stderr warning naming max_fanout in --json mode, got %q", stderr.String())
	}
	if delivCalls.Load() != 2 || parsed.ScreenQueries != 2 {
		t.Fatalf("expected 2 queries (not full budget), got rpc=%d reported=%d", delivCalls.Load(), parsed.ScreenQueries)
	}

	// Text mode
	delivCalls.Store(0)
	stdout.Reset()
	stderr.Reset()
	if err := run(context.Background(), []string{"--rpc", srv.URL, "--bridge=false"}, nil, &stdout, &stderr); err != nil {
		t.Fatalf("text run failed: %v", err)
	}
	text := stdout.String()
	if !strings.Contains(text, "may be incomplete") || !strings.Contains(text, "max_fanout") {
		t.Fatalf("expected text output to say 'may be incomplete' and name max_fanout:\n%s", text)
	}
	if strings.Contains(text, "screening budget was exhausted") {
		t.Fatalf("text output must not falsely blame screening budget exhaustion:\n%s", text)
	}
}

// Inverted from security review 4 (R4-2a):
// Two 5-layer live junk-token DAGs (37 offers each) plus 66 dead starts (60+6)
// previously exhausted DefaultMaxRings after ~5 starts/round and burned all 10
// screening rounds, hiding unrelated honest ring [1000, 1001]. With the
// per-start ring cap (100), the search reaches [1000, 1001], screens and drops
// the dead starts within budget, and selects [1000, 1001] cleanly.
func TestReview4_MaxRingsPerStartPreventsRoundExhaustionAttack(t *testing.T) {
	const (
		tokA = "gno.land/r/gnoland/wugnot.wugnot"
		tokB = "gno.land/r/gnoswap/gns.GNS"
	)

	var offers []map[string]any
	liveIDs := make(map[uint64]bool)
	id := uint64(1)

	addDAG := func(tag string, numDead int) {
		dt1 := "gno.land/r/evil/" + tag + "1.T1"
		dt2 := "gno.land/r/evil/" + tag + "2.T2"
		dt3 := "gno.land/r/evil/" + tag + "3.T3"
		dt4 := "gno.land/r/evil/" + tag + "4.T4"
		dt5 := "gno.land/r/evil/" + tag + "5.T5"
		dt6 := "gno.land/r/evil/" + tag + "6.T6"
		for i := 0; i < numDead; i++ {
			offers = append(offers, map[string]any{
				"id": id, "owner": fmt.Sprintf("g1d%s%02d", tag, i/4), "nonce": (i % 4) + 1, "slot": "g1s",
				"give":   map[string]any{"kind": "fungible", "key": dt1, "id": "", "amount": "1"},
				"want":   map[string]any{"kind": "fungible", "key": dt6, "id": "", "amount": "1"},
				"expiry": 1000,
			})
			id++
		}
		addL := func(count int, prefix, giveTok, wantTok string) {
			for i := 0; i < count; i++ {
				offers = append(offers, map[string]any{
					"id": id, "owner": fmt.Sprintf("%s_%s_%02d", prefix, tag, i), "nonce": 1, "slot": "g1s",
					"give":   map[string]any{"kind": "fungible", "key": giveTok, "id": "", "amount": "1"},
					"want":   map[string]any{"kind": "fungible", "key": wantTok, "id": "", "amount": "1"},
					"expiry": 1000,
				})
				liveIDs[id] = true
				id++
			}
		}
		addL(1, "g1l2", dt2, dt1)
		addL(2, "g1l3", dt3, dt2)
		addL(6, "g1l4", dt4, dt3)
		addL(12, "g1l5", dt5, dt4)
		addL(16, "g1l6", dt6, dt5)
	}
	addDAG("a", 60)
	addDAG("b", 6)

	// Unrelated honest ring [1000, 1001] on wugnot <-> GNS.
	offers = append(offers,
		map[string]any{
			"id": 1000, "owner": "g1alice", "nonce": 1, "slot": "g1s",
			"give":   map[string]any{"kind": "fungible", "key": tokA, "id": "", "amount": "1000"},
			"want":   map[string]any{"kind": "fungible", "key": tokB, "id": "", "amount": "1000"},
			"expiry": 1000,
		},
		map[string]any{
			"id": 1001, "owner": "g1bob", "nonce": 1, "slot": "g1s",
			"give":   map[string]any{"kind": "fungible", "key": tokB, "id": "", "amount": "1000"},
			"want":   map[string]any{"kind": "fungible", "key": tokA, "id": "", "amount": "1000"},
			"expiry": 1000,
		},
	)
	liveIDs[1000] = true
	liveIDs[1001] = true

	graphObj := map[string]any{
		"realm": rpc.DefaultRealmPath, "height": 500, "collections": []any{},
		"offers": offers, "hasMore": false, "next": 0, "total": len(offers),
	}

	var delivCalls atomic.Int32
	srv := startDeliverableTestServer(t, graphObj, func(oid uint64) bool {
		return liveIDs[oid]
	}, &delivCalls, nil)
	defer srv.Close()

	var stdout, stderr bytes.Buffer
	if err := run(context.Background(), []string{"--rpc", srv.URL, "--bridge=false", "--json"}, nil, &stdout, &stderr); err != nil {
		t.Fatalf("run failed: %v", err)
	}
	var parsed solverOutput
	if err := json.Unmarshal(stdout.Bytes(), &parsed); err != nil {
		t.Fatal(err)
	}

	if len(parsed.Selected) != 1 || parsed.Selected[0].IDsArg != "1000,1001" {
		t.Fatalf("expected honest ring [1000,1001] selected, got %+v (stats=%+v rounds=%d queries=%d)",
			parsed.Selected, parsed.Stats, parsed.ScreenRounds, parsed.ScreenQueries)
	}
	if parsed.ScreenRounds >= defaultMaxScreenRounds {
		t.Fatalf("expected screening to finish well within %d rounds, got %d", defaultMaxScreenRounds, parsed.ScreenRounds)
	}
	if parsed.ScreenQueries != int(delivCalls.Load()) {
		t.Fatalf("reported ScreenQueries=%d != actual Deliverable RPCs=%d", parsed.ScreenQueries, delivCalls.Load())
	}
	if parsed.ScreenQueries > defaultMaxScreenQueries {
		t.Fatalf("exceeded defaultMaxScreenQueries (%d): got %d", defaultMaxScreenQueries, parsed.ScreenQueries)
	}
	// All 66 dead starts are cleared so ring limits are no longer hit; the 74
	// remaining live relay offers still exceed DefaultMaxStepsPerStart (2,462 >
	// 2,000 steps from live L2), which R4-4 must report as max_steps_per_start
	// without falsely claiming the screening budget was exhausted.
	if !parsed.Stats.Truncated || parsed.Stats.TruncatedReason != "max_steps_per_start" {
		t.Fatalf("expected only live-DAG max_steps_per_start after dead starts cleared, got stats=%+v", parsed.Stats)
	}
	if !parsed.MayBeIncomplete || !strings.Contains(parsed.IncompleteReason, "max_steps_per_start") || strings.Contains(parsed.IncompleteReason, "exhausted its budget") {
		t.Fatalf("expected MayBeIncomplete naming max_steps_per_start (not budget exhaustion), got incomplete=%v reason=%q",
			parsed.MayBeIncomplete, parsed.IncompleteReason)
	}
}

// Inverted from security review 4 (R4-2b):
// selectDeliverableRings must share --max-screen-queries with screening, count
// its Deliverable queries in ScreenQueries, fail closed by dropping any
// unconfirmed rings when the budget runs out, and mark MayBeIncomplete.
func TestReview4_SelectDeliverableRingsRespectsMaxScreenQueries(t *testing.T) {
	t.Run("26 disjoint live rings with --max-screen-queries 1 drops unconfirmed ring and marks incomplete", func(t *testing.T) {
		var offers []map[string]any
		id := 1
		for r := 0; r < 26; r++ {
			ta := fmt.Sprintf("gno.land/r/d/a%d.A%d", r, r)
			tb := fmt.Sprintf("gno.land/r/d/b%d.B%d", r, r)
			offers = append(offers,
				map[string]any{
					"id": id, "owner": fmt.Sprintf("g1u%da", r), "nonce": 1, "slot": "g1s",
					"give":   map[string]any{"kind": "fungible", "key": ta, "id": "", "amount": "10"},
					"want":   map[string]any{"kind": "fungible", "key": tb, "id": "", "amount": "10"},
					"expiry": 1000,
				},
				map[string]any{
					"id": id + 1, "owner": fmt.Sprintf("g1u%db", r), "nonce": 1, "slot": "g1s",
					"give":   map[string]any{"kind": "fungible", "key": tb, "id": "", "amount": "10"},
					"want":   map[string]any{"kind": "fungible", "key": ta, "id": "", "amount": "10"},
					"expiry": 1000,
				},
			)
			id += 2
		}

		graphObj := map[string]any{
			"realm": rpc.DefaultRealmPath, "height": 500, "collections": []any{},
			"offers": offers, "hasMore": false, "next": 0, "total": len(offers),
		}
		var delivCalls atomic.Int32
		srv := startDeliverableTestServer(t, graphObj, func(uint64) bool { return true }, &delivCalls, nil)
		defer srv.Close()

		// JSON mode
		var stdout, stderr bytes.Buffer
		err := run(context.Background(), []string{
			"--rpc", srv.URL, "--bridge=false", "--max-screen-queries", "1", "--json",
		}, nil, &stdout, &stderr)
		if err != nil {
			t.Fatalf("json run failed: %v", err)
		}
		var parsed solverOutput
		if err := json.Unmarshal(stdout.Bytes(), &parsed); err != nil {
			t.Fatal(err)
		}
		if delivCalls.Load() != 1 || parsed.ScreenQueries != 1 {
			t.Fatalf("expected exactly 1 Deliverable query (within --max-screen-queries 1), got rpc=%d reported=%d",
				delivCalls.Load(), parsed.ScreenQueries)
		}
		if len(parsed.Selected) != 25 {
			t.Fatalf("expected 25 confirmed rings selected (unconfirmed 26th dropped), got %d", len(parsed.Selected))
		}
		for _, sel := range parsed.Selected {
			if sel.IDsArg == "51,52" {
				t.Fatalf("unconfirmed ring [51,52] must fail closed and not be selected")
			}
		}
		if len(parsed.DroppedUndeliverable) != 1 || parsed.DroppedUndeliverable[0].IDsArg != "51,52" {
			t.Fatalf("expected unconfirmed ring [51,52] recorded in DroppedUndeliverable, got %+v", parsed.DroppedUndeliverable)
		}
		if !parsed.MayBeIncomplete || !strings.Contains(parsed.IncompleteReason, "may be incomplete") {
			t.Fatalf("expected MayBeIncomplete=true with reason, got %+v", parsed)
		}

		// Text mode
		delivCalls.Store(0)
		stdout.Reset()
		stderr.Reset()
		err = run(context.Background(), []string{
			"--rpc", srv.URL, "--bridge=false", "--max-screen-queries", "1",
		}, nil, &stdout, &stderr)
		if err != nil {
			t.Fatalf("text run failed: %v", err)
		}
		if delivCalls.Load() != 1 {
			t.Fatalf("expected 1 Deliverable query in text mode, got %d", delivCalls.Load())
		}
		if !strings.Contains(stdout.String(), "may be incomplete") {
			t.Fatalf("expected 'may be incomplete' in text output:\n%s", stdout.String())
		}
	})

	t.Run("query budget shared and counted across screening and final check", func(t *testing.T) {
		const (
			tokA = "gno.land/r/gnoland/wugnot.wugnot"
			tokB = "gno.land/r/gnoswap/gns.GNS"
		)
		// Overlapping rings: [1,2] (offer 2 dead) hides [1,3] (both live) during
		// Round 1. With --max-screen-rounds 1, Round 1 spends 1 query on [1,2],
		// drops offer 2, and stops. Phase B then finds [1,3] (offer 3 unchecked),
		// so selectDeliverableRings needs 1 more query.
		graphObj := map[string]any{
			"realm": rpc.DefaultRealmPath, "height": 500, "collections": []any{},
			"offers": []map[string]any{
				{"id": 1, "owner": "g1alice", "nonce": 1, "slot": "g1s",
					"give": map[string]any{"kind": "fungible", "key": tokA, "id": "", "amount": "100"},
					"want": map[string]any{"kind": "fungible", "key": tokB, "id": "", "amount": "100"}, "expiry": 1000},
				{"id": 2, "owner": "g1dead", "nonce": 1, "slot": "g1s",
					"give": map[string]any{"kind": "fungible", "key": tokB, "id": "", "amount": "100"},
					"want": map[string]any{"kind": "fungible", "key": tokA, "id": "", "amount": "100"}, "expiry": 1000},
				{"id": 3, "owner": "g1bob", "nonce": 1, "slot": "g1s",
					"give": map[string]any{"kind": "fungible", "key": tokB, "id": "", "amount": "100"},
					"want": map[string]any{"kind": "fungible", "key": tokA, "id": "", "amount": "100"}, "expiry": 1000},
			},
			"hasMore": false, "next": 0, "total": 3,
		}

		// With --max-screen-queries 2: screening spends 1 query, final check spends 1 query -> total 2, ring [1,3] confirmed.
		var delivCalls atomic.Int32
		srv := startDeliverableTestServer(t, graphObj, func(id uint64) bool { return id != 2 }, &delivCalls, nil)
		defer srv.Close()

		var stdout, stderr bytes.Buffer
		err := run(context.Background(), []string{
			"--rpc", srv.URL, "--bridge=false", "--max-screen-rounds", "1", "--max-screen-queries", "2", "--json",
		}, nil, &stdout, &stderr)
		if err != nil {
			t.Fatalf("run (2 queries) failed: %v", err)
		}
		var out2 solverOutput
		if err := json.Unmarshal(stdout.Bytes(), &out2); err != nil {
			t.Fatal(err)
		}
		if delivCalls.Load() != 2 || out2.ScreenQueries != 2 {
			t.Fatalf("expected 2 total queries (1 screening + 1 final check) reported in ScreenQueries, got rpc=%d reported=%d",
				delivCalls.Load(), out2.ScreenQueries)
		}
		if len(out2.Selected) != 1 || out2.Selected[0].IDsArg != "1,3" {
			t.Fatalf("expected ring [1,3] confirmed and selected, got %+v", out2.Selected)
		}
		if out2.MayBeIncomplete {
			t.Fatalf("expected MayBeIncomplete=false when all rings confirmed within budget, got %+v", out2)
		}

		// With --max-screen-queries 1: screening spends the 1 query on [1,2]; final check has 0 left -> fails closed on [1,3], marks incomplete.
		delivCalls.Store(0)
		stdout.Reset()
		stderr.Reset()
		err = run(context.Background(), []string{
			"--rpc", srv.URL, "--bridge=false", "--max-screen-rounds", "1", "--max-screen-queries", "1", "--json",
		}, nil, &stdout, &stderr)
		if err != nil {
			t.Fatalf("run (1 query) failed: %v", err)
		}
		var out1 solverOutput
		if err := json.Unmarshal(stdout.Bytes(), &out1); err != nil {
			t.Fatal(err)
		}
		if delivCalls.Load() != 1 || out1.ScreenQueries != 1 {
			t.Fatalf("expected 1 total query (budget capped at 1), got rpc=%d reported=%d",
				delivCalls.Load(), out1.ScreenQueries)
		}
		if len(out1.Selected) != 0 {
			t.Fatalf("expected unconfirmed ring [1,3] dropped (fail closed), got %+v", out1.Selected)
		}
		if !out1.MayBeIncomplete || !strings.Contains(out1.IncompleteReason, "may be incomplete") {
			t.Fatalf("expected MayBeIncomplete=true when final check ran out of query budget, got %+v", out1)
		}
	})
}

// Review 4 (R4-4): Every search bound (fan-out, per-owner, steps-per-start,
// steps, rings-per-start, rings, quotes) must mark the output as possibly
// incomplete in both JSON and text with a reason naming the bound, while a
// clean small book must NOT show the marking.
func TestReview4_MayBeIncompleteForEveryBoundAndAbsentOnCleanBook(t *testing.T) {
	const (
		tokA = "gno.land/r/gnoland/wugnot.wugnot"
		tokB = "gno.land/r/gnoswap/gns.GNS"
		tokC = "gno.land/r/demo/c.CCC"
		tokD = "gno.land/r/demo/d.DDD"
		col  = "gno.land/r/nym-kylix000/kylixdemo"
	)

	makeOffer := func(id int, owner, giveKey, wantKey string, giveAmt, wantAmt int) map[string]any {
		return map[string]any{
			"id": id, "owner": owner, "nonce": 1, "slot": "g1s",
			"give":   map[string]any{"kind": "fungible", "key": giveKey, "id": "", "amount": strconv.Itoa(giveAmt)},
			"want":   map[string]any{"kind": "fungible", "key": wantKey, "id": "", "amount": strconv.Itoa(wantAmt)},
			"expiry": 1000,
		}
	}

	assertBoundMarked := func(t *testing.T, graphObj map[string]any, extraArgs []string, wantBound string, withBridge bool) {
		t.Helper()
		graphBytes, err := json.Marshal(graphObj)
		if err != nil {
			t.Fatal(err)
		}
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if r.URL.Path == "/status" {
				_, _ = w.Write(statusJSON("onyx-1"))
				return
			}
			hexData := strings.TrimPrefix(r.URL.Query().Get("data"), "0x")
			b, _ := hex.DecodeString(hexData)
			q := string(b)
			switch {
			case strings.Contains(q, "ExportGraphJSONPage"):
				_, _ = w.Write(abciWrap("(" + strconv.Quote(string(graphBytes)) + " string)"))
			case strings.Contains(q, ".Deliverable("):
				start := strings.Index(q, `("`)
				end := strings.LastIndex(q, `")`)
				idsArg, _ := strconv.Unquote(q[start+1 : end+1])
				parts := strings.Split(idsArg, ",")
				resOffers := make([]map[string]any, 0, len(parts))
				for _, p := range parts {
					id, _ := strconv.ParseUint(p, 10, 64)
					resOffers = append(resOffers, map[string]any{"id": id, "deliverable": true, "reason": ""})
				}
				rb, _ := json.Marshal(map[string]any{"height": 500, "offers": resOffers})
				_, _ = w.Write(abciWrap("(" + strconv.Quote(string(rb)) + " string)"))
			case strings.Contains(q, ".ExistsPoolPath("):
				exists := strings.Contains(q, ",3000)")
				_, _ = w.Write(abciWrap(fmt.Sprintf("(%v bool)", exists)))
			case strings.Contains(q, ".DrySwapRoute("):
				_, _ = w.Write(abciWrap("(\"10\" string)\n(\"10\" string)\n(undefined)\n"))
			default:
				t.Errorf("unexpected query: %s", q)
			}
		}))
		defer srv.Close()

		baseArgs := []string{"--rpc", srv.URL}
		if !withBridge {
			baseArgs = append(baseArgs, "--bridge=false")
		} else {
			baseArgs = append(baseArgs, "--fee-tiers", "3000")
		}
		baseArgs = append(baseArgs, extraArgs...)

		// JSON mode
		var stdout, stderr bytes.Buffer
		if err := run(context.Background(), append(append([]string(nil), baseArgs...), "--json"), nil, &stdout, &stderr); err != nil {
			t.Fatalf("json run failed: %v (stderr=%s)", err, stderr.String())
		}
		var parsed solverOutput
		if err := json.Unmarshal(stdout.Bytes(), &parsed); err != nil {
			t.Fatalf("decode json: %v", err)
		}
		if !parsed.Stats.Truncated || parsed.Stats.TruncatedReason != wantBound {
			t.Fatalf("expected TruncatedReason=%q, got %+v", wantBound, parsed.Stats)
		}
		if !parsed.MayBeIncomplete {
			t.Fatalf("expected MayBeIncomplete=true for bound %q", wantBound)
		}
		if !strings.Contains(parsed.IncompleteReason, "may be incomplete") || !strings.Contains(parsed.IncompleteReason, wantBound) {
			t.Fatalf("expected IncompleteReason naming %q and 'may be incomplete', got %q", wantBound, parsed.IncompleteReason)
		}

		// Text mode
		stdout.Reset()
		stderr.Reset()
		if err := run(context.Background(), baseArgs, nil, &stdout, &stderr); err != nil {
			t.Fatalf("text run failed: %v", err)
		}
		text := stdout.String()
		if !strings.Contains(text, "may be incomplete") || !strings.Contains(text, wantBound) {
			t.Fatalf("expected text output naming %q and 'may be incomplete':\n%s", wantBound, text)
		}
	}

	t.Run("max_fanout", func(t *testing.T) {
		offers := []map[string]any{
			makeOffer(1, "g1alice", tokA, tokB, 100, 100),
			makeOffer(2, "g1u1", tokC, tokA, 10, 1),
			makeOffer(3, "g1u2", tokC, tokA, 10, 1),
			makeOffer(4, "g1u3", tokC, tokA, 10, 1),
			makeOffer(5, "g1bob", tokB, tokA, 100, 100),
		}
		g := map[string]any{"realm": rpc.DefaultRealmPath, "height": 500, "collections": []any{}, "offers": offers}
		assertBoundMarked(t, g, []string{"--max-fanout", "3"}, "max_fanout", false)
	})

	t.Run("max_per_owner", func(t *testing.T) {
		offers := []map[string]any{
			makeOffer(1, "g1bob", tokC, tokA, 10, 1),
			makeOffer(2, "g1bob", tokC, tokA, 10, 1),
			makeOffer(3, "g1bob", tokB, tokA, 100, 100),
			makeOffer(4, "g1alice", tokA, tokB, 100, 100),
		}
		g := map[string]any{"realm": rpc.DefaultRealmPath, "height": 500, "collections": []any{}, "offers": offers}
		assertBoundMarked(t, g, []string{"--max-per-owner", "2"}, "max_per_owner", false)
	})

	t.Run("max_steps_per_start", func(t *testing.T) {
		offers := []map[string]any{makeOffer(1, "g1start", tokA, tokD, 10, 10)}
		id := 2
		for i := 0; i < 4; i++ {
			offers = append(offers, makeOffer(id, fmt.Sprintf("g1l1_%d", i), tokB, tokA, 10, 1))
			id++
		}
		for i := 0; i < 4; i++ {
			offers = append(offers, makeOffer(id, fmt.Sprintf("g1l2_%d", i), tokC, tokB, 10, 1))
			id++
		}
		g := map[string]any{"realm": rpc.DefaultRealmPath, "height": 500, "collections": []any{}, "offers": offers}
		assertBoundMarked(t, g, []string{"--max-steps-per-start", "5"}, "max_steps_per_start", false)
	})

	t.Run("max_steps", func(t *testing.T) {
		offers := []map[string]any{
			makeOffer(1, "g1s1", tokA, tokD, 10, 10),
			makeOffer(2, "g1s2", tokA, tokD, 10, 10),
		}
		id := 3
		for i := 0; i < 5; i++ {
			offers = append(offers, makeOffer(id, fmt.Sprintf("g1l1_%d", i), tokB, tokA, 10, 1))
			id++
		}
		for i := 0; i < 5; i++ {
			offers = append(offers, makeOffer(id, fmt.Sprintf("g1l2_%d", i), tokC, tokB, 10, 1))
			id++
		}
		g := map[string]any{"realm": rpc.DefaultRealmPath, "height": 500, "collections": []any{}, "offers": offers}
		assertBoundMarked(t, g, []string{"--max-steps", "10", "--max-steps-per-start", "100"}, "max_steps", false)
	})

	t.Run("max_rings_per_start", func(t *testing.T) {
		offers := []map[string]any{makeOffer(1, "g1start", tokA, tokC, 10, 10)}
		id := 2
		for i := 0; i < 3; i++ {
			offers = append(offers, makeOffer(id, fmt.Sprintf("g1m1_%d", i), tokB, tokA, 10, 10))
			id++
		}
		for i := 0; i < 3; i++ {
			offers = append(offers, makeOffer(id, fmt.Sprintf("g1m2_%d", i), tokC, tokB, 10, 10))
			id++
		}
		g := map[string]any{"realm": rpc.DefaultRealmPath, "height": 500, "collections": []any{}, "offers": offers}
		assertBoundMarked(t, g, []string{"--max-rings-per-start", "3", "--max-rings", "100"}, "max_rings_per_start", false)
	})

	t.Run("max_rings", func(t *testing.T) {
		offers := []map[string]any{
			makeOffer(1, "g1s1", tokA, tokC, 10, 10),
			makeOffer(2, "g1s2", tokA, tokC, 10, 10),
		}
		id := 3
		for i := 0; i < 3; i++ {
			offers = append(offers, makeOffer(id, fmt.Sprintf("g1m1_%d", i), tokB, tokA, 10, 10))
			id++
		}
		for i := 0; i < 3; i++ {
			offers = append(offers, makeOffer(id, fmt.Sprintf("g1m2_%d", i), tokC, tokB, 10, 10))
			id++
		}
		g := map[string]any{"realm": rpc.DefaultRealmPath, "height": 500, "collections": []any{}, "offers": offers}
		assertBoundMarked(t, g, []string{"--max-rings", "4", "--max-rings-per-start", "10"}, "max_rings", false)
	})

	t.Run("max_quotes", func(t *testing.T) {
		offers := []map[string]any{
			{"id": 1, "owner": "g1a", "nonce": 1, "slot": "g1s",
				"give": map[string]any{"kind": "fungible", "key": tokA, "id": "", "amount": "10"},
				"want": map[string]any{"kind": "item", "key": col, "id": "i1", "amount": "0"}, "expiry": 1000},
			{"id": 2, "owner": "g1b", "nonce": 1, "slot": "g1s",
				"give": map[string]any{"kind": "item", "key": col, "id": "i1", "amount": "0"},
				"want": map[string]any{"kind": "fungible", "key": tokB, "id": "", "amount": "999999"}, "expiry": 1000},
			{"id": 3, "owner": "g1c", "nonce": 1, "slot": "g1s",
				"give": map[string]any{"kind": "fungible", "key": tokA, "id": "", "amount": "20"},
				"want": map[string]any{"kind": "item", "key": col, "id": "i2", "amount": "0"}, "expiry": 1000},
			{"id": 4, "owner": "g1d", "nonce": 1, "slot": "g1s",
				"give": map[string]any{"kind": "item", "key": col, "id": "i2", "amount": "0"},
				"want": map[string]any{"kind": "fungible", "key": tokB, "id": "", "amount": "999999"}, "expiry": 1000},
		}
		g := map[string]any{
			"realm": rpc.DefaultRealmPath, "height": 500,
			"collections": []map[string]any{{"key": col, "name": "Relics", "official": true, "approvalCheck": true}},
			"offers":      offers,
		}
		assertBoundMarked(t, g, []string{"--max-quotes", "1"}, "max_quotes", true)
	})

	t.Run("clean small book has no incomplete marking in RPC or graph mode", func(t *testing.T) {
		graphObj := map[string]any{
			"realm": rpc.DefaultRealmPath, "height": 500, "collections": []any{},
			"offers": []map[string]any{
				makeOffer(1, "g1alice", tokA, tokB, 100, 100),
				makeOffer(2, "g1bob", tokB, tokA, 100, 100),
			},
			"hasMore": false, "next": 0, "total": 2,
		}
		srv := startDeliverableTestServer(t, graphObj, func(uint64) bool { return true }, nil, nil)
		defer srv.Close()

		// RPC JSON + text
		var stdout, stderr bytes.Buffer
		if err := run(context.Background(), []string{"--rpc", srv.URL, "--bridge=false", "--json"}, nil, &stdout, &stderr); err != nil {
			t.Fatalf("rpc json failed: %v", err)
		}
		if strings.Contains(stdout.String(), "mayBeIncomplete") || strings.Contains(stdout.String(), "incompleteReason") {
			t.Fatalf("clean book JSON must omit mayBeIncomplete/incompleteReason:\n%s", stdout.String())
		}
		stdout.Reset()
		stderr.Reset()
		if err := run(context.Background(), []string{"--rpc", srv.URL, "--bridge=false"}, nil, &stdout, &stderr); err != nil {
			t.Fatalf("rpc text failed: %v", err)
		}
		if strings.Contains(stdout.String(), "may be incomplete") || strings.Contains(stdout.String(), "Warning:") {
			t.Fatalf("clean book text must not show incomplete marking:\n%s", stdout.String())
		}

		// Offline --graph mode (also verify truncated offline --graph marks incomplete)
		raw, _ := json.Marshal(graphObj)
		p := filepath.Join(t.TempDir(), "clean.json")
		if err := os.WriteFile(p, raw, 0o600); err != nil {
			t.Fatal(err)
		}
		stdout.Reset()
		stderr.Reset()
		if err := run(context.Background(), []string{"--graph", p, "--json"}, nil, &stdout, &stderr); err != nil {
			t.Fatalf("graph json failed: %v", err)
		}
		if strings.Contains(stdout.String(), "mayBeIncomplete") {
			t.Fatalf("clean --graph JSON must omit mayBeIncomplete:\n%s", stdout.String())
		}
	})
}

// Review 4 (R4-6): Verify ringGasWanted uses 25M + 5M/token + 14M/item + 50M/GnoSwap hop.
func TestReview4_RingGasWantedFormula(t *testing.T) {
	const (
		tokA = "gno.land/r/gnoland/wugnot.wugnot"
		tokB = "gno.land/r/gnoswap/gns.GNS"
		col  = "gno.land/r/nym-kylix000/kylixdemo"
	)
	byID := map[uint64]ring.Offer{
		1: {ID: 1, Give: ring.Asset{Kind: ring.KindFungible, Key: tokA, Amount: 100}},
		2: {ID: 2, Give: ring.Asset{Kind: ring.KindFungible, Key: tokB, Amount: 100}},
		3: {ID: 3, Give: ring.Asset{Kind: ring.KindItem, Key: col, ID: "r1"}},
		4: {ID: 4, Give: ring.Asset{Kind: ring.KindItem, Key: col, ID: "r2"}},
	}

	cases := []struct {
		name string
		r    ring.Ring
		want int64
	}{
		{
			name: "2-token direct",
			r:    ring.Ring{IDs: []uint64{1, 2}, BridgedHop: ring.NoBridge},
			want: 35_000_000, // 25M + 2*5M
		},
		{
			name: "2-item direct",
			r:    ring.Ring{IDs: []uint64{3, 4}, BridgedHop: ring.NoBridge},
			want: 53_000_000, // 25M + 2*14M
		},
		{
			name: "2-token bridged",
			r:    ring.Ring{IDs: []uint64{1, 2}, BridgedHop: 0},
			want: 85_000_000, // 25M + 2*5M + 50M
		},
		{
			name: "token+item bridged",
			r:    ring.Ring{IDs: []uint64{1, 3}, BridgedHop: 0},
			want: 94_000_000, // 25M + 5M + 14M + 50M
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := ringGasWanted(byID, tc.r); got != tc.want {
				t.Fatalf("ringGasWanted(%s) = %d, want %d", tc.name, got, tc.want)
			}
		})
	}
}
