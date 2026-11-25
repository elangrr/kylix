package main

import (
	"bytes"
	"context"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"

	"kylix/solver/rpc"
)

// Helper that serves ExportGraphJSONPage and Deliverable(ids) for an in-memory
// graph where liveFn(id) reports whether offer id is deliverable.
func startDeliverableTestServer(
	t *testing.T,
	graphObj map[string]any,
	liveFn func(id uint64) bool,
	delivCalls *atomic.Int32,
	queriedIDs *[]uint64,
) *httptest.Server {
	t.Helper()
	graphBytes, err := json.Marshal(graphObj)
	if err != nil {
		t.Fatal(err)
	}
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
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
			if delivCalls != nil {
				delivCalls.Add(1)
			}
			start := strings.Index(q, `("`)
			end := strings.LastIndex(q, `")`)
			idsArg, _ := strconv.Unquote(q[start+1 : end+1])
			parts := strings.Split(idsArg, ",")
			if len(parts) > rpc.MaxDeliverableBatch {
				t.Errorf("Deliverable batch exceeded %d IDs: got %d", rpc.MaxDeliverableBatch, len(parts))
			}
			resOffers := make([]map[string]any, 0, len(parts))
			for _, p := range parts {
				id, _ := strconv.ParseUint(p, 10, 64)
				if queriedIDs != nil {
					*queriedIDs = append(*queriedIDs, id)
				}
				ok := liveFn(id)
				reason := ""
				if !ok {
					reason = "owner no longer holds item"
				}
				resOffers = append(resOffers, map[string]any{"id": id, "deliverable": ok, "reason": reason})
			}
			rb, _ := json.Marshal(map[string]any{"height": 500, "offers": resOffers})
			_, _ = w.Write(abciWrap("(" + strconv.Quote(string(rb)) + " string)"))
		default:
			t.Errorf("unexpected query: %s", q)
		}
	}))
}

// Inverted from security review 3 (R3-3 / N5):
// 64 distinct Sybil accounts each posting 1 undeliverable offer giving a
// non-existent official item and wanting 1 wugnot fill DefaultMaxFanout (64)
// on honest offer #100. The solver MUST screen the offers occupying the
// truncated fan-out list via Deliverable, drop the dead ones, retry, and find
// the honest [100, 101] ring.
func TestReview3_SybilItemOffersBypassPreScreenAndBlindSolver(t *testing.T) {
	const (
		tokA = "gno.land/r/gnoland/wugnot.wugnot"
		tokB = "gno.land/r/gnoswap/gns.GNS"
		col  = "gno.land/r/nym-kylix000/kylixdemo"
	)

	offers := make([]map[string]any, 0, 66)
	for i := 1; i <= 64; i++ {
		offers = append(offers, map[string]any{
			"id": i, "owner": fmt.Sprintf("g1sybil%03d", i), "nonce": 1, "slot": "g1s",
			"give":   map[string]any{"kind": "item", "key": col, "id": fmt.Sprintf("fake-%d", i), "amount": "0"},
			"want":   map[string]any{"kind": "fungible", "key": tokA, "id": "", "amount": "1"},
			"expiry": 1000,
		})
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
		"realm":       rpc.DefaultRealmPath,
		"height":      500,
		"collections": []map[string]any{{"key": col, "name": "Kylix Relics", "official": true, "approvalCheck": true}},
		"offers":      offers,
		"hasMore":     false,
		"next":        0,
		"total":       len(offers),
	}

	var delivCalls atomic.Int32
	srv := startDeliverableTestServer(t, graphObj, func(id uint64) bool {
		return id >= 100
	}, &delivCalls, nil)
	defer srv.Close()

	var stdout, stderr bytes.Buffer
	err := run(context.Background(), []string{"--rpc", srv.URL, "--json"}, nil, &stdout, &stderr)
	if err != nil {
		t.Fatalf("run failed: %v (stderr=%s)", err, stderr.String())
	}
	var parsed solverOutput
	if err := json.Unmarshal(stdout.Bytes(), &parsed); err != nil {
		t.Fatalf("invalid json: %v", err)
	}
	if delivCalls.Load() != 3 {
		t.Fatalf("expected 3 Deliverable queries (2 for 64 Sybils + 1 for honest [100,101]), got %d", delivCalls.Load())
	}
	if len(parsed.Selected) != 1 || parsed.Selected[0].IDsArg != "100,101" {
		t.Fatalf("expected honest ring [100,101] to be found, got %+v", parsed.Selected)
	}
	if parsed.Stats.Truncated {
		t.Fatalf("expected final search after dropping dead Sybils not to be truncated, got %+v", parsed.Stats)
	}
	if parsed.MayBeIncomplete {
		t.Fatalf("expected MayBeIncomplete=false when all dead blockers were cleared, got reason=%q", parsed.IncompleteReason)
	}
}

// Verifies that the query and round budgets are strictly respected when an
// attacker posts more dead offers than the budget can clear, and that both
// JSON and text output plainly warn that the result may be incomplete.
func TestReview3_QueryBudgetExhaustedReportsIncomplete(t *testing.T) {
	const (
		tokA = "gno.land/r/gnoland/wugnot.wugnot"
		tokB = "gno.land/r/gnoswap/gns.GNS"
		col  = "gno.land/r/nym-kylix000/kylixdemo"
	)

	makeGraph := func(numSybils int) map[string]any {
		offers := make([]map[string]any, 0, numSybils+2)
		for i := 1; i <= numSybils; i++ {
			offers = append(offers, map[string]any{
				"id": i, "owner": fmt.Sprintf("g1sybil%04d", i), "nonce": 1, "slot": "g1s",
				"give":   map[string]any{"kind": "item", "key": col, "id": fmt.Sprintf("fake-%d", i), "amount": "0"},
				"want":   map[string]any{"kind": "fungible", "key": tokA, "id": "", "amount": "1"},
				"expiry": 1000,
			})
		}
		offers = append(offers,
			map[string]any{
				"id": 10000, "owner": "g1alice", "nonce": 1, "slot": "g1s",
				"give":   map[string]any{"kind": "fungible", "key": tokA, "id": "", "amount": "1000"},
				"want":   map[string]any{"kind": "fungible", "key": tokB, "id": "", "amount": "1000"},
				"expiry": 1000,
			},
			map[string]any{
				"id": 10001, "owner": "g1bob", "nonce": 1, "slot": "g1s",
				"give":   map[string]any{"kind": "fungible", "key": tokB, "id": "", "amount": "1000"},
				"want":   map[string]any{"kind": "fungible", "key": tokA, "id": "", "amount": "1000"},
				"expiry": 1000,
			},
		)
		return map[string]any{
			"realm":       rpc.DefaultRealmPath,
			"height":      500,
			"collections": []map[string]any{{"key": col, "name": "Kylix Relics", "official": true, "approvalCheck": true}},
			"offers":      offers,
			"hasMore":     false,
			"next":        0,
			"total":       len(offers),
		}
	}

	t.Run("default budget (10 rounds, 20 queries) exhausted in JSON and text", func(t *testing.T) {
		// 800 dead Sybils > 10 rounds * 64 = 640 cleared in 20 Deliverable queries.
		graphObj := makeGraph(800)

		var delivCalls atomic.Int32
		srv := startDeliverableTestServer(t, graphObj, func(id uint64) bool {
			return id >= 10000
		}, &delivCalls, nil)
		defer srv.Close()

		// JSON mode
		var stdout, stderr bytes.Buffer
		if err := run(context.Background(), []string{"--rpc", srv.URL, "--bridge=false", "--json"}, nil, &stdout, &stderr); err != nil {
			t.Fatalf("json run failed: %v (stderr=%s)", err, stderr.String())
		}
		if got := delivCalls.Load(); got != defaultMaxScreenQueries {
			t.Fatalf("expected exactly %d Deliverable queries (default budget), got %d", defaultMaxScreenQueries, got)
		}
		var parsed solverOutput
		if err := json.Unmarshal(stdout.Bytes(), &parsed); err != nil {
			t.Fatalf("invalid json: %v", err)
		}
		if parsed.ScreenRounds != defaultMaxScreenRounds || parsed.ScreenQueries != defaultMaxScreenQueries {
			t.Fatalf("expected screenRounds=%d screenQueries=%d, got %d/%d",
				defaultMaxScreenRounds, defaultMaxScreenQueries, parsed.ScreenRounds, parsed.ScreenQueries)
		}
		if !parsed.MayBeIncomplete {
			t.Fatalf("expected mayBeIncomplete=true when budget exhausted with full lists")
		}
		if !strings.Contains(parsed.IncompleteReason, "may be incomplete") {
			t.Fatalf("expected plain incompleteReason, got %q", parsed.IncompleteReason)
		}
		foundWarn := false
		for _, w := range parsed.Warnings {
			if strings.Contains(w, "may be incomplete") {
				foundWarn = true
			}
		}
		if !foundWarn {
			t.Fatalf("expected 'may be incomplete' in Warnings, got %+v", parsed.Warnings)
		}
		if !strings.Contains(stderr.String(), "may be incomplete") {
			t.Fatalf("expected 'may be incomplete' warning on stderr in --json mode, got %q", stderr.String())
		}

		// Text mode
		delivCalls.Store(0)
		stdout.Reset()
		stderr.Reset()
		if err := run(context.Background(), []string{"--rpc", srv.URL, "--bridge=false"}, nil, &stdout, &stderr); err != nil {
			t.Fatalf("text run failed: %v", err)
		}
		if got := delivCalls.Load(); got != defaultMaxScreenQueries {
			t.Fatalf("expected %d Deliverable queries in text mode, got %d", defaultMaxScreenQueries, got)
		}
		text := stdout.String()
		if !strings.Contains(text, "Warning:") || !strings.Contains(text, "may be incomplete") {
			t.Fatalf("expected plain 'may be incomplete' warning in text output:\n%s", text)
		}
	})

	t.Run("custom round bound stops before query budget and reports incomplete", func(t *testing.T) {
		graphObj := makeGraph(50)
		var delivCalls atomic.Int32
		srv := startDeliverableTestServer(t, graphObj, func(id uint64) bool {
			return id >= 10000
		}, &delivCalls, nil)
		defer srv.Close()

		var stdout, stderr bytes.Buffer
		err := run(context.Background(), []string{
			"--rpc", srv.URL,
			"--bridge=false",
			"--max-fanout", "10",
			"--max-screen-rounds", "3",
			"--max-screen-queries", "20",
			"--json",
		}, nil, &stdout, &stderr)
		if err != nil {
			t.Fatalf("run failed: %v", err)
		}
		if got := delivCalls.Load(); got != 3 {
			t.Fatalf("expected 3 Deliverable queries (3 rounds of 10), got %d", got)
		}
		var parsed solverOutput
		if err := json.Unmarshal(stdout.Bytes(), &parsed); err != nil {
			t.Fatal(err)
		}
		if !parsed.MayBeIncomplete || parsed.ScreenRounds != 3 || parsed.ScreenQueries != 3 {
			t.Fatalf("expected MayBeIncomplete=true, rounds=3, queries=3; got %+v", parsed)
		}
	})
}

// Verifies that a clean book with no dead offers and no search truncation
// spends zero extra Deliverable queries compared to pre-fix behavior.
func TestReview3_CleanBookNoDeadOffersCostsNoExtraQueries(t *testing.T) {
	const (
		tokA = "gno.land/r/gnoland/wugnot.wugnot"
		tokB = "gno.land/r/gnoswap/gns.GNS"
		col  = "gno.land/r/nym-kylix000/kylixdemo"
	)

	t.Run("book with 1 live ring and 30 unrelated live offers only queries the 2 ring offers", func(t *testing.T) {
		offers := []map[string]any{
			{
				"id": 1, "owner": "g1alice", "nonce": 1, "slot": "g1s",
				"give":   map[string]any{"kind": "fungible", "key": tokA, "id": "", "amount": "100"},
				"want":   map[string]any{"kind": "fungible", "key": tokB, "id": "", "amount": "100"},
				"expiry": 1000,
			},
			{
				"id": 2, "owner": "g1bob", "nonce": 1, "slot": "g1s",
				"give":   map[string]any{"kind": "fungible", "key": tokB, "id": "", "amount": "100"},
				"want":   map[string]any{"kind": "fungible", "key": tokA, "id": "", "amount": "100"},
				"expiry": 1000,
			},
		}
		// 30 live dead-end item offers wanting tokA (< MaxFanout = 64, so no truncation).
		for i := 10; i < 40; i++ {
			offers = append(offers, map[string]any{
				"id": i, "owner": fmt.Sprintf("g1user%02d", i), "nonce": 1, "slot": "g1s",
				"give":   map[string]any{"kind": "item", "key": col, "id": fmt.Sprintf("item-%d", i), "amount": "0"},
				"want":   map[string]any{"kind": "fungible", "key": tokA, "id": "", "amount": "1"},
				"expiry": 1000,
			})
		}

		graphObj := map[string]any{
			"realm":       rpc.DefaultRealmPath,
			"height":      500,
			"collections": []map[string]any{{"key": col, "name": "Relics", "official": true, "approvalCheck": true}},
			"offers":      offers,
			"hasMore":     false,
			"next":        0,
			"total":       len(offers),
		}

		var delivCalls atomic.Int32
		var queried []uint64
		srv := startDeliverableTestServer(t, graphObj, func(uint64) bool { return true }, &delivCalls, &queried)
		defer srv.Close()

		var stdout, stderr bytes.Buffer
		if err := run(context.Background(), []string{"--rpc", srv.URL, "--bridge=false", "--json"}, nil, &stdout, &stderr); err != nil {
			t.Fatalf("run failed: %v", err)
		}
		if delivCalls.Load() != 1 {
			t.Fatalf("expected exactly 1 Deliverable query on clean book, got %d", delivCalls.Load())
		}
		if len(queried) != 2 || queried[0] != 1 || queried[1] != 2 {
			t.Fatalf("expected only ring offers [1 2] to be queried, got %v", queried)
		}
		var parsed solverOutput
		if err := json.Unmarshal(stdout.Bytes(), &parsed); err != nil {
			t.Fatal(err)
		}
		if len(parsed.Selected) != 1 || parsed.Selected[0].IDsArg != "1,2" || parsed.MayBeIncomplete {
			t.Fatalf("unexpected output: %+v", parsed)
		}
	})

	t.Run("no-ring clean book makes 0 Deliverable queries", func(t *testing.T) {
		offers := make([]map[string]any, 0, 20)
		for i := 1; i <= 20; i++ {
			offers = append(offers, map[string]any{
				"id": i, "owner": fmt.Sprintf("g1u%02d", i), "nonce": 1, "slot": "g1s",
				"give":   map[string]any{"kind": "item", "key": col, "id": fmt.Sprintf("item-%d", i), "amount": "0"},
				"want":   map[string]any{"kind": "fungible", "key": tokA, "id": "", "amount": "1"},
				"expiry": 1000,
			})
		}
		graphObj := map[string]any{
			"realm":       rpc.DefaultRealmPath,
			"height":      500,
			"collections": []map[string]any{{"key": col, "name": "Relics", "official": true, "approvalCheck": true}},
			"offers":      offers,
			"hasMore":     false,
			"next":        0,
			"total":       len(offers),
		}
		var delivCalls atomic.Int32
		srv := startDeliverableTestServer(t, graphObj, func(uint64) bool { return true }, &delivCalls, nil)
		defer srv.Close()

		var stdout, stderr bytes.Buffer
		if err := run(context.Background(), []string{"--rpc", srv.URL, "--bridge=false", "--json"}, nil, &stdout, &stderr); err != nil {
			t.Fatalf("run failed: %v", err)
		}
		if delivCalls.Load() != 0 {
			t.Fatalf("expected 0 Deliverable queries on non-truncated no-ring book, got %d", delivCalls.Load())
		}
	})
}

// Verifies recovery when dead offers exhaust the other search bounds:
//   - max_steps_per_start (3-layer dead tree < MaxFanout)
//   - max_steps (total step limit)
//   - max_rings (dead offers exploding ring count alongside a live ring)
//   - max_per_owner (owner's own dead offers blocking their newer live offer)
func TestReview3_OtherBoundsRecoveredByScreening(t *testing.T) {
	const (
		tokA  = "gno.land/r/gnoland/wugnot.wugnot"
		tokB  = "gno.land/r/gnoswap/gns.GNS"
		tokX1 = "gno.land/r/demo/x1.X1"
		tokX2 = "gno.land/r/demo/x2.X2"
		col   = "gno.land/r/nym-kylix000/kylixdemo"
	)

	t.Run("max_steps_per_start dead tree", func(t *testing.T) {
		// Honest offer #10 gives tokA, wants tokB; honest #200 gives tokB, wants tokA.
		// Dead 3-layer tree (10 -> 10 -> 10 = 1,000+ steps) has fanout 11 << 64,
		// so max_fanout is NOT hit, only max_steps_per_start (200).
		offers := []map[string]any{
			{
				"id": 10, "owner": "g1alice", "nonce": 1, "slot": "g1s",
				"give":   map[string]any{"kind": "fungible", "key": tokA, "id": "", "amount": "100"},
				"want":   map[string]any{"kind": "fungible", "key": tokB, "id": "", "amount": "100"},
				"expiry": 1000,
			},
		}
		id := 11
		for i := 0; i < 10; i++ {
			offers = append(offers, map[string]any{
				"id": id, "owner": fmt.Sprintf("g1l1_%02d", i), "nonce": 1, "slot": "g1s",
				"give":   map[string]any{"kind": "fungible", "key": tokX1, "id": "", "amount": "10"},
				"want":   map[string]any{"kind": "fungible", "key": tokA, "id": "", "amount": "1"},
				"expiry": 1000,
			})
			id++
		}
		for i := 0; i < 10; i++ {
			offers = append(offers, map[string]any{
				"id": id, "owner": fmt.Sprintf("g1l2_%02d", i), "nonce": 1, "slot": "g1s",
				"give":   map[string]any{"kind": "fungible", "key": tokX2, "id": "", "amount": "10"},
				"want":   map[string]any{"kind": "fungible", "key": tokX1, "id": "", "amount": "1"},
				"expiry": 1000,
			})
			id++
		}
		for i := 0; i < 10; i++ {
			offers = append(offers, map[string]any{
				"id": id, "owner": fmt.Sprintf("g1l3_%02d", i), "nonce": 1, "slot": "g1s",
				"give":   map[string]any{"kind": "item", "key": col, "id": fmt.Sprintf("dead-%d", i), "amount": "0"},
				"want":   map[string]any{"kind": "fungible", "key": tokX2, "id": "", "amount": "1"},
				"expiry": 1000,
			})
			id++
		}
		offers = append(offers, map[string]any{
			"id": 200, "owner": "g1bob", "nonce": 1, "slot": "g1s",
			"give":   map[string]any{"kind": "fungible", "key": tokB, "id": "", "amount": "100"},
			"want":   map[string]any{"kind": "fungible", "key": tokA, "id": "", "amount": "100"},
			"expiry": 1000,
		})

		graphObj := map[string]any{
			"realm":       rpc.DefaultRealmPath,
			"height":      500,
			"collections": []map[string]any{{"key": col, "name": "Relics", "official": true, "approvalCheck": true}},
			"offers":      offers,
			"hasMore":     false,
			"next":        0,
			"total":       len(offers),
		}

		var delivCalls atomic.Int32
		srv := startDeliverableTestServer(t, graphObj, func(id uint64) bool {
			return id == 10 || id == 200
		}, &delivCalls, nil)
		defer srv.Close()

		var stdout, stderr bytes.Buffer
		err := run(context.Background(), []string{
			"--rpc", srv.URL,
			"--bridge=false",
			"--max-steps-per-start", "200",
			"--json",
		}, nil, &stdout, &stderr)
		if err != nil {
			t.Fatalf("run failed: %v", err)
		}
		var parsed solverOutput
		if err := json.Unmarshal(stdout.Bytes(), &parsed); err != nil {
			t.Fatal(err)
		}
		if len(parsed.Selected) != 1 || parsed.Selected[0].IDsArg != "10,200" {
			t.Fatalf("expected honest ring [10,200] recovered from dead step tree, got %+v (stats=%+v)", parsed.Selected, parsed.Stats)
		}
		if parsed.Stats.Truncated || parsed.MayBeIncomplete {
			t.Fatalf("expected clean untruncated final result, got stats=%+v incomplete=%v", parsed.Stats, parsed.MayBeIncomplete)
		}
	})

	t.Run("max_steps total exhausted by dead starts", func(t *testing.T) {
		// 6 dead starts (1..6) feeding into a 10x10 dead core (11..30) burn > 400
		// total steps before honest offers 200,201 are visited.
		offers := make([]map[string]any, 0, 32)
		for i := 1; i <= 6; i++ {
			offers = append(offers, map[string]any{
				"id": i, "owner": fmt.Sprintf("g1ds%02d", i), "nonce": 1, "slot": "g1s",
				"give":   map[string]any{"kind": "fungible", "key": tokX1, "id": "", "amount": "10"},
				"want":   map[string]any{"kind": "item", "key": col, "id": fmt.Sprintf("none-%d", i), "amount": "0"},
				"expiry": 1000,
			})
		}
		for i := 0; i < 10; i++ {
			offers = append(offers, map[string]any{
				"id": 11 + i, "owner": fmt.Sprintf("g1c1_%02d", i), "nonce": 1, "slot": "g1s",
				"give":   map[string]any{"kind": "fungible", "key": tokX2, "id": "", "amount": "10"},
				"want":   map[string]any{"kind": "fungible", "key": tokX1, "id": "", "amount": "1"},
				"expiry": 1000,
			})
		}
		for i := 0; i < 10; i++ {
			offers = append(offers, map[string]any{
				"id": 21 + i, "owner": fmt.Sprintf("g1c2_%02d", i), "nonce": 1, "slot": "g1s",
				"give":   map[string]any{"kind": "item", "key": col, "id": fmt.Sprintf("leaf-%d", i), "amount": "0"},
				"want":   map[string]any{"kind": "fungible", "key": tokX2, "id": "", "amount": "1"},
				"expiry": 1000,
			})
		}
		offers = append(offers,
			map[string]any{
				"id": 200, "owner": "g1alice", "nonce": 1, "slot": "g1s",
				"give":   map[string]any{"kind": "fungible", "key": tokA, "id": "", "amount": "100"},
				"want":   map[string]any{"kind": "fungible", "key": tokB, "id": "", "amount": "100"},
				"expiry": 1000,
			},
			map[string]any{
				"id": 201, "owner": "g1bob", "nonce": 1, "slot": "g1s",
				"give":   map[string]any{"kind": "fungible", "key": tokB, "id": "", "amount": "100"},
				"want":   map[string]any{"kind": "fungible", "key": tokA, "id": "", "amount": "100"},
				"expiry": 1000,
			},
		)

		graphObj := map[string]any{
			"realm":       rpc.DefaultRealmPath,
			"height":      500,
			"collections": []map[string]any{{"key": col, "name": "Relics", "official": true, "approvalCheck": true}},
			"offers":      offers,
			"hasMore":     false,
			"next":        0,
			"total":       len(offers),
		}

		srv := startDeliverableTestServer(t, graphObj, func(id uint64) bool {
			return id >= 200
		}, nil, nil)
		defer srv.Close()

		var stdout, stderr bytes.Buffer
		err := run(context.Background(), []string{
			"--rpc", srv.URL,
			"--bridge=false",
			"--max-steps", "400",
			"--max-steps-per-start", "150",
			"--json",
		}, nil, &stdout, &stderr)
		if err != nil {
			t.Fatalf("run failed: %v", err)
		}
		var parsed solverOutput
		if err := json.Unmarshal(stdout.Bytes(), &parsed); err != nil {
			t.Fatal(err)
		}
		if len(parsed.Selected) != 1 || parsed.Selected[0].IDsArg != "200,201" {
			t.Fatalf("expected honest ring [200,201] recovered after max_steps screening, got %+v (stats=%+v)", parsed.Selected, parsed.Stats)
		}
	})

	t.Run("max_rings exploded by dead offers alongside 1 live ring", func(t *testing.T) {
		// 1 live 3-ring [1,2,3] on t1->t2->t3->t1, PLUS 8 dead offers on t2->t3
		// and 8 dead offers on t3->t1 creating 1*9*9 = 81 > 50 rings!
		// SelectRings only picks [1,2,3] (all live), so without max_rings
		// blocker screening the solver would stop and hide [1000,1001].
		t1, t2, t3 := "gno.land/r/d/t1.T1", "gno.land/r/d/t2.T2", "gno.land/r/d/t3.T3"
		offers := []map[string]any{
			{"id": 1, "owner": "g1live1", "nonce": 1, "slot": "g1s",
				"give": map[string]any{"kind": "fungible", "key": t1, "id": "", "amount": "10"},
				"want": map[string]any{"kind": "fungible", "key": t3, "id": "", "amount": "10"}, "expiry": 1000},
			{"id": 2, "owner": "g1live2", "nonce": 1, "slot": "g1s",
				"give": map[string]any{"kind": "fungible", "key": t2, "id": "", "amount": "10"},
				"want": map[string]any{"kind": "fungible", "key": t1, "id": "", "amount": "10"}, "expiry": 1000},
			{"id": 3, "owner": "g1live3", "nonce": 1, "slot": "g1s",
				"give": map[string]any{"kind": "fungible", "key": t3, "id": "", "amount": "10"},
				"want": map[string]any{"kind": "fungible", "key": t2, "id": "", "amount": "10"}, "expiry": 1000},
		}
		for i := 0; i < 8; i++ {
			offers = append(offers,
				map[string]any{"id": 10 + i, "owner": fmt.Sprintf("g1d2_%d", i), "nonce": 1, "slot": "g1s",
					"give": map[string]any{"kind": "fungible", "key": t2, "id": "", "amount": "10"},
					"want": map[string]any{"kind": "fungible", "key": t1, "id": "", "amount": "10"}, "expiry": 1000},
				map[string]any{"id": 20 + i, "owner": fmt.Sprintf("g1d3_%d", i), "nonce": 1, "slot": "g1s",
					"give": map[string]any{"kind": "fungible", "key": t3, "id": "", "amount": "10"},
					"want": map[string]any{"kind": "fungible", "key": t2, "id": "", "amount": "10"}, "expiry": 1000},
			)
		}
		offers = append(offers,
			map[string]any{"id": 1000, "owner": "g1alice", "nonce": 1, "slot": "g1s",
				"give": map[string]any{"kind": "fungible", "key": tokA, "id": "", "amount": "100"},
				"want": map[string]any{"kind": "fungible", "key": tokB, "id": "", "amount": "100"}, "expiry": 1000},
			map[string]any{"id": 1001, "owner": "g1bob", "nonce": 1, "slot": "g1s",
				"give": map[string]any{"kind": "fungible", "key": tokB, "id": "", "amount": "100"},
				"want": map[string]any{"kind": "fungible", "key": tokA, "id": "", "amount": "100"}, "expiry": 1000},
		)

		graphObj := map[string]any{
			"realm": rpc.DefaultRealmPath, "height": 500, "collections": []any{},
			"offers": offers, "hasMore": false, "next": 0, "total": len(offers),
		}
		srv := startDeliverableTestServer(t, graphObj, func(id uint64) bool {
			return id <= 3 || id >= 1000
		}, nil, nil)
		defer srv.Close()

		var stdout, stderr bytes.Buffer
		err := run(context.Background(), []string{
			"--rpc", srv.URL,
			"--bridge=false",
			"--max-rings", "50",
			"--json",
		}, nil, &stdout, &stderr)
		if err != nil {
			t.Fatalf("run failed: %v", err)
		}
		var parsed solverOutput
		if err := json.Unmarshal(stdout.Bytes(), &parsed); err != nil {
			t.Fatal(err)
		}
		if len(parsed.Selected) != 2 {
			t.Fatalf("expected both [1,2,3] and [1000,1001] selected, got %+v (stats=%+v)", parsed.Selected, parsed.Stats)
		}
		if parsed.Selected[0].IDsArg != "1,2,3" || parsed.Selected[1].IDsArg != "1000,1001" {
			t.Fatalf("unexpected selected rings: %+v", parsed.Selected)
		}
	})

	t.Run("max_per_owner dead offers hiding same owner's live offer", func(t *testing.T) {
		offers := []map[string]any{
			{"id": 1, "owner": "g1bob", "nonce": 1, "slot": "g1s",
				"give": map[string]any{"kind": "item", "key": col, "id": "d1", "amount": "0"},
				"want": map[string]any{"kind": "fungible", "key": tokA, "id": "", "amount": "1"}, "expiry": 1000},
			{"id": 2, "owner": "g1bob", "nonce": 2, "slot": "g1s",
				"give": map[string]any{"kind": "item", "key": col, "id": "d2", "amount": "0"},
				"want": map[string]any{"kind": "fungible", "key": tokA, "id": "", "amount": "1"}, "expiry": 1000},
			{"id": 3, "owner": "g1bob", "nonce": 3, "slot": "g1s",
				"give": map[string]any{"kind": "item", "key": col, "id": "d3", "amount": "0"},
				"want": map[string]any{"kind": "fungible", "key": tokA, "id": "", "amount": "1"}, "expiry": 1000},
			{"id": 4, "owner": "g1bob", "nonce": 4, "slot": "g1s",
				"give": map[string]any{"kind": "item", "key": col, "id": "d4", "amount": "0"},
				"want": map[string]any{"kind": "fungible", "key": tokA, "id": "", "amount": "1"}, "expiry": 1000},
			{"id": 10, "owner": "g1bob", "nonce": 5, "slot": "g1s",
				"give": map[string]any{"kind": "fungible", "key": tokB, "id": "", "amount": "100"},
				"want": map[string]any{"kind": "fungible", "key": tokA, "id": "", "amount": "100"}, "expiry": 1000},
			{"id": 11, "owner": "g1alice", "nonce": 1, "slot": "g1s",
				"give": map[string]any{"kind": "fungible", "key": tokA, "id": "", "amount": "100"},
				"want": map[string]any{"kind": "fungible", "key": tokB, "id": "", "amount": "100"}, "expiry": 1000},
		}
		graphObj := map[string]any{
			"realm":       rpc.DefaultRealmPath,
			"height":      500,
			"collections": []map[string]any{{"key": col, "name": "Relics", "official": true, "approvalCheck": true}},
			"offers":      offers,
			"hasMore":     false,
			"next":        0,
			"total":       len(offers),
		}
		srv := startDeliverableTestServer(t, graphObj, func(id uint64) bool {
			return id >= 10
		}, nil, nil)
		defer srv.Close()

		var stdout, stderr bytes.Buffer
		if err := run(context.Background(), []string{"--rpc", srv.URL, "--bridge=false", "--json"}, nil, &stdout, &stderr); err != nil {
			t.Fatalf("run failed: %v", err)
		}
		var parsed solverOutput
		if err := json.Unmarshal(stdout.Bytes(), &parsed); err != nil {
			t.Fatal(err)
		}
		if len(parsed.Selected) != 1 || parsed.Selected[0].IDsArg != "10,11" {
			t.Fatalf("expected honest ring [10,11] recovered after max_per_owner screening, got %+v", parsed.Selected)
		}
	})
}
