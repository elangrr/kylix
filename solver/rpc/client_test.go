package rpc

import (
	"context"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

// abciOK builds a Tendermint/TM2 /abci_query JSON response matching onyx-1's shape.
func abciOK(t *testing.T, data string) []byte {
	t.Helper()
	payload := map[string]any{
		"jsonrpc": "2.0",
		"result": map[string]any{
			"response": map[string]any{
				"ResponseBase": map[string]any{
					"Error": nil,
					"Data":  base64.StdEncoding.EncodeToString([]byte(data)),
					"Log":   "",
				},
			},
		},
	}
	b, err := json.Marshal(payload)
	if err != nil {
		t.Fatal(err)
	}
	return b
}

func abciErr(t *testing.T, errVal, logMsg string) []byte {
	t.Helper()
	payload := map[string]any{
		"jsonrpc": "2.0",
		"result": map[string]any{
			"response": map[string]any{
				"ResponseBase": map[string]any{
					"Error": map[string]any{"@type": "/abci.StringError", "value": errVal},
					"Data":  "",
					"Log":   logMsg,
				},
			},
		},
	}
	b, err := json.Marshal(payload)
	if err != nil {
		t.Fatal(err)
	}
	return b
}

func decodeQueryData(t *testing.T, r *http.Request) (path, data string) {
	t.Helper()
	path = strings.Trim(r.URL.Query().Get("path"), `"`)
	hexData := strings.TrimPrefix(r.URL.Query().Get("data"), "0x")
	b, err := hex.DecodeString(hexData)
	if err != nil {
		t.Fatalf("invalid hex data %q: %v", hexData, err)
	}
	return path, string(b)
}

func TestFetchGraph_FakeRPC(t *testing.T) {
	graphJSON := `{"realm":"gno.land/r/nym-kylix000/kylix","height":12345,` +
		`"collections":[{"key":"gno.land/r/nym-kylix000/kylixdemo","name":"Relics","adapter":false,"target":"","official":true,"approvalCheck":true}],` +
		`"offers":[` +
		`{"id":1,"owner":"g1alice","nonce":1,"slot":"g1slot1",` +
		`"give":{"kind":"fungible","key":"gno.land/r/gnoland/wugnot.wugnot","id":"","amount":"1000000"},` +
		`"want":{"kind":"item","key":"gno.land/r/nym-kylix000/kylixdemo","id":"relic-7","amount":"0"},` +
		`"expiry":20000,"viaSession":false},` +
		`{"id":2,"owner":"g1bob","nonce":1,"slot":"g1slot2",` +
		`"give":{"kind":"item","key":"gno.land/r/nym-kylix000/kylixdemo","id":"relic-7","amount":"0"},` +
		`"want":{"kind":"fungible","key":"gno.land/r/gnoswap/gns.GNS","id":"","amount":"4000000"},` +
		`"expiry":20000,"viaSession":false}]}`

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/abci_query" {
			http.NotFound(w, r)
			return
		}
		path, data := decodeQueryData(t, r)
		if path != "vm/qeval" {
			t.Errorf("unexpected abci path %q", path)
		}
		if data != "gno.land/r/nym-kylix000/kylix.ExportGraphJSONPage(0, 500)" {
			t.Errorf("unexpected qeval data %q", data)
		}
		qevalOut := "(" + strconv.Quote(graphJSON) + " string)"
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write(abciOK(t, qevalOut))
	}))
	defer srv.Close()

	client := NewClient(srv.URL)
	g, err := FetchGraph(context.Background(), client, "gno.land/r/nym-kylix000/kylix")
	if err != nil {
		t.Fatalf("FetchGraph failed: %v", err)
	}
	if g.Height != 12345 || len(g.Offers) != 2 || len(g.Collections) != 1 || !g.Collections[0].Official {
		t.Fatalf("unexpected graph: %+v", g)
	}
	if g.Offers[0].Give.Amount != 1000000 || g.Offers[1].Want.Amount != 4000000 {
		t.Fatalf("unexpected offer amounts: %+v", g.Offers)
	}
}

func TestFetchGraph_MultiPagePreservesPageOneCollections(t *testing.T) {
	page0 := `{"realm":"gno.land/r/nym-kylix000/kylix","height":100,"hasMore":true,"next":1,` +
		`"collections":[{"key":"gno.land/r/nym-kylix000/kylixdemo","name":"Relics","adapter":false,"target":"","official":true,"approvalCheck":true}],` +
		`"offers":[{"id":1,"owner":"g1a","nonce":1,"slot":"g1s1",` +
		`"give":{"kind":"fungible","key":"tokA","id":"","amount":"10"},"want":{"kind":"item","key":"gno.land/r/nym-kylix000/kylixdemo","id":"r1","amount":"0"},"expiry":500}]}`
	// Second page omits "collections", matching the realm's paged export.
	page1 := `{"realm":"gno.land/r/nym-kylix000/kylix","height":101,"hasMore":false,"next":0,` +
		`"offers":[{"id":2,"owner":"g1b","nonce":1,"slot":"g1s2",` +
		`"give":{"kind":"item","key":"gno.land/r/nym-kylix000/kylixdemo","id":"r1","amount":"0"},"want":{"kind":"fungible","key":"tokA","id":"","amount":"10"},"expiry":500}]}`

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, data := decodeQueryData(t, r)
		w.Header().Set("Content-Type", "application/json")
		switch data {
		case "gno.land/r/nym-kylix000/kylix.ExportGraphJSONPage(0, 500)":
			_, _ = w.Write(abciOK(t, "("+strconv.Quote(page0)+" string)"))
		case "gno.land/r/nym-kylix000/kylix.ExportGraphJSONPage(1, 500)":
			_, _ = w.Write(abciOK(t, "("+strconv.Quote(page1)+" string)"))
		default:
			http.Error(w, "unexpected: "+data, http.StatusBadRequest)
		}
	}))
	defer srv.Close()

	client := NewClient(srv.URL)
	g, err := FetchGraph(context.Background(), client, "gno.land/r/nym-kylix000/kylix")
	if err != nil {
		t.Fatalf("FetchGraph failed: %v", err)
	}
	if len(g.Offers) != 2 || g.Height != 101 {
		t.Fatalf("expected 2 offers at height 101, got %+v", g)
	}
	if len(g.Collections) != 1 || g.Collections[0].Key != "gno.land/r/nym-kylix000/kylixdemo" || !g.Collections[0].Official {
		t.Fatalf("expected page 0 collections preserved, got %+v", g.Collections)
	}
}

func TestClient_RetriesOn429WithBackoff(t *testing.T) {
	var attempts atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		n := attempts.Add(1)
		if n <= 2 {
			w.Header().Set("Retry-After", "1")
			w.WriteHeader(http.StatusTooManyRequests)
			_, _ = w.Write([]byte("rate limited"))
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write(abciOK(t, `(true bool)`))
	}))
	defer srv.Close()

	var slept []time.Duration
	client := NewClient(srv.URL)
	client.Sleep = func(_ context.Context, d time.Duration) error {
		slept = append(slept, d)
		return nil
	}

	raw, err := client.QueryEval(context.Background(), "gno.land/r/demo/test", "Ping()")
	if err != nil {
		t.Fatalf("expected retry to succeed, got err: %v", err)
	}
	if ok, err := ParseEvalBool(raw); err != nil || !ok {
		t.Fatalf("ParseEvalBool(%q) = (%v, %v), want (true, nil)", raw, ok, err)
	}
	if got := attempts.Load(); got != 3 {
		t.Fatalf("attempts = %d, want 3", got)
	}
	if len(slept) != 2 || slept[0] != time.Second || slept[1] != time.Second {
		t.Fatalf("unexpected sleep durations: %v", slept)
	}
}

func TestClient_ABCIErrorReported(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write(abciErr(t, "package not found", "VM panic: package not found\nstack..."))
	}))
	defer srv.Close()

	client := NewClient(srv.URL)
	_, err := client.QueryEval(context.Background(), "gno.land/r/missing/pkg", "ExportGraphJSON()")
	if err == nil || !strings.Contains(err.Error(), "package not found") {
		t.Fatalf("expected abci error mentioning package not found, got %v", err)
	}
}

func TestGnoSwapQuoter_FakeRPCAndCaching(t *testing.T) {
	const (
		wugnot = "gno.land/r/gnoland/wugnot.wugnot"
		gns    = "gno.land/r/gnoswap/gns.GNS"
		dead   = "gno.land/r/demo/nopool.NO"
	)

	var poolQueries, routeQueries atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, data := decodeQueryData(t, r)
		w.Header().Set("Content-Type", "application/json")
		switch {
		case strings.HasPrefix(data, DefaultGnoSwapPoolPath+".ExistsPoolPath("):
			poolQueries.Add(1)
			// Only wugnot/gns at fee 3000 exists.
			exists := strings.Contains(data, wugnot) && strings.Contains(data, gns) && strings.Contains(data, ",3000)")
			_, _ = w.Write(abciOK(t, fmt.Sprintf("(%v bool)", exists)))
		case strings.HasPrefix(data, DefaultGnoSwapRouterPath+".DrySwapRoute("):
			routeQueries.Add(1)
			if strings.Contains(data, wugnot+":"+gns+":3000") {
				out := "(\"1000000\" string)\n(\"4556245\" string)\n(undefined)\n"
				_, _ = w.Write(abciOK(t, out))
				return
			}
			errOut := "(\"0\" string)\n(\"0\" string)\n(&(struct{(\"[GNOSWAP-ROUTER-004] pool does not exist\" string)} gno.land/p/nt/ufmt/v0.errMsg) *gno.land/p/nt/ufmt/v0.errMsg)\n"
			_, _ = w.Write(abciOK(t, errOut))
		default:
			t.Errorf("unexpected query data: %s", data)
			http.Error(w, "unexpected", http.StatusBadRequest)
		}
	}))
	defer srv.Close()

	client := NewClient(srv.URL)
	quoter := NewGnoSwapQuoter(client)
	ctx := context.Background()

	// 1. Live pair quote returns output and winning fee tier.
	out, fee, ok, err := quoter.Quote(ctx, wugnot, gns, 1000000)
	if err != nil || !ok || out != 4556245 || fee != 3000 {
		t.Fatalf("Quote(wugnot->gns) = (%d, %d, %v, %v), want (4556245, 3000, true, nil)", out, fee, ok, err)
	}
	if poolQueries.Load() != 4 || routeQueries.Load() != 1 {
		t.Fatalf("expected 4 pool queries and 1 route query, got pool=%d route=%d", poolQueries.Load(), routeQueries.Load())
	}

	// 2. Repeated identical quote must hit cache (0 additional RPC calls) and preserve fee.
	out2, fee2, ok2, err2 := quoter.Quote(ctx, wugnot, gns, 1000000)
	if err2 != nil || !ok2 || out2 != 4556245 || fee2 != 3000 {
		t.Fatalf("cached Quote() = (%d, %d, %v, %v), want (4556245, 3000, true, nil)", out2, fee2, ok2, err2)
	}
	if poolQueries.Load() != 4 || routeQueries.Load() != 1 {
		t.Fatalf("cache miss: pool=%d route=%d", poolQueries.Load(), routeQueries.Load())
	}

	// 3. Pair with no pool must return ok=false with 0 DrySwapRoute calls,
	// and reverse direction must reuse the unordered pair cache!
	out3, fee3, ok3, err3 := quoter.Quote(ctx, wugnot, dead, 100)
	if err3 != nil || ok3 || out3 != 0 || fee3 != 0 {
		t.Fatalf("Quote(no pool) = (%d, %d, %v, %v), want (0, 0, false, nil)", out3, fee3, ok3, err3)
	}
	out4, fee4, ok4, err4 := quoter.Quote(ctx, dead, wugnot, 500)
	if err4 != nil || ok4 || out4 != 0 || fee4 != 0 {
		t.Fatalf("Quote(reverse no pool) = (%d, %d, %v, %v), want (0, 0, false, nil)", out4, fee4, ok4, err4)
	}
	if poolQueries.Load() != 8 || routeQueries.Load() != 1 {
		t.Fatalf("expected unordered pair cache to skip reverse probes: pool=%d route=%d", poolQueries.Load(), routeQueries.Load())
	}
}

// TestGnoSwapQuoter_MultiPoolDecoyRejected mirrors security review finding 3:
// three fee tiers exist, including a decoy 10000-fee pool that would hold a
// larger out-of-range reserve but produces a far worse DrySwapRoute quote, plus
// a 500-fee pool that fails to quote. The quoter must quote every existing tier
// via DrySwapRoute (never GetBalances) and pick the highest-output tier (3000).
func TestGnoSwapQuoter_MultiPoolDecoyRejected(t *testing.T) {
	const (
		wugnot = "gno.land/r/gnoland/wugnot.wugnot"
		gns    = "gno.land/r/gnoswap/gns.GNS"
	)

	// Simulated reserves (not queried by solver; decoy 10000 has larger reserve
	// than healthy 3000 pool).
	reserves := map[uint32]int64{
		500:   100_000,
		3000:  41_785_087, // healthy pool
		10000: 51_785_087, // decoy out-of-range pool with larger reserve
	}
	if reserves[10000] <= reserves[3000] {
		t.Fatal("test setup error: decoy must have larger reserve")
	}

	var quotedTiers []uint32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, data := decodeQueryData(t, r)
		w.Header().Set("Content-Type", "application/json")
		switch {
		case strings.Contains(data, "GetBalances"):
			t.Errorf("solver must not use GetBalances for pool selection: %s", data)
			http.Error(w, "forbidden query", http.StatusBadRequest)
		case strings.HasPrefix(data, DefaultGnoSwapPoolPath+".ExistsPoolPath("):
			exists := strings.Contains(data, ",500)") ||
				strings.Contains(data, ",3000)") ||
				strings.Contains(data, ",10000)")
			_, _ = w.Write(abciOK(t, fmt.Sprintf("(%v bool)", exists)))
		case strings.HasPrefix(data, DefaultGnoSwapRouterPath+".DrySwapRoute("):
			switch {
			case strings.Contains(data, wugnot+":"+gns+":500"):
				quotedTiers = append(quotedTiers, 500)
				// Empty active liquidity -> domain error
				errOut := "(\"0\" string)\n(\"0\" string)\n(&(struct{(\"[GNOSWAP-ROUTER-004] insufficient liquidity\" string)} err) *err)\n"
				_, _ = w.Write(abciOK(t, errOut))
			case strings.Contains(data, wugnot+":"+gns+":3000"):
				quotedTiers = append(quotedTiers, 3000)
				_, _ = w.Write(abciOK(t, "(\"1000000\" string)\n(\"907629\" string)\n(undefined)\n"))
			case strings.Contains(data, wugnot+":"+gns+":10000"):
				quotedTiers = append(quotedTiers, 10000)
				// Decoy pool returns terrible output despite larger reserve.
				_, _ = w.Write(abciOK(t, "(\"1000000\" string)\n(\"18105\" string)\n(undefined)\n"))
			default:
				t.Errorf("unexpected DrySwapRoute query: %s", data)
				http.Error(w, "unexpected", http.StatusBadRequest)
			}
		default:
			t.Errorf("unexpected query: %s", data)
			http.Error(w, "unexpected", http.StatusBadRequest)
		}
	}))
	defer srv.Close()

	client := NewClient(srv.URL)
	quoter := NewGnoSwapQuoter(client)
	out, fee, ok, err := quoter.Quote(context.Background(), wugnot, gns, 1_000_000)
	if err != nil {
		t.Fatalf("Quote failed: %v", err)
	}
	if !ok || fee != 3000 || out != 907629 {
		t.Fatalf("Quote() = (out=%d, fee=%d, ok=%v), want (907629, 3000, true)", out, fee, ok)
	}
	if len(quotedTiers) != 3 {
		t.Fatalf("expected all 3 existing tiers quoted via DrySwapRoute, got %v", quotedTiers)
	}
}

func TestCheckDeliverable_BatchingAndRetry(t *testing.T) {
	// Build 55 IDs -> should be split into 2 batches (50 + 5).
	ids := make([]uint64, 55)
	for i := range ids {
		ids[i] = uint64(i + 1)
	}

	var batch1Attempts atomic.Int32
	var batchesSeen []int

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, data := decodeQueryData(t, r)
		w.Header().Set("Content-Type", "application/json")
		prefix := DefaultRealmPath + ".Deliverable("
		if !strings.HasPrefix(data, prefix) || !strings.HasSuffix(data, ")") {
			t.Errorf("unexpected Deliverable query: %s", data)
			http.Error(w, "unexpected", http.StatusBadRequest)
			return
		}
		quotedArg := data[len(prefix) : len(data)-1]
		idsArg, err := strconv.Unquote(quotedArg)
		if err != nil {
			t.Errorf("bad quoted idsArg %q: %v", quotedArg, err)
			http.Error(w, "bad arg", http.StatusBadRequest)
			return
		}
		parts := strings.Split(idsArg, ",")
		if len(parts) > MaxDeliverableBatch {
			t.Errorf("batch size %d exceeded max %d", len(parts), MaxDeliverableBatch)
		}
		batchesSeen = append(batchesSeen, len(parts))

		// Fail first attempt on the first batch (simulating concurrent SettleRing lock),
		// then succeed on retry.
		if parts[0] == "1" && batch1Attempts.Add(1) == 1 {
			_, _ = w.Write(abciErr(t, "kylix: settlement in progress", "VM panic: kylix: settlement in progress"))
			return
		}

		items := make([]DeliverableStatus, 0, len(parts))
		for _, p := range parts {
			id, _ := strconv.ParseUint(p, 10, 64)
			st := DeliverableStatus{ID: id, Deliverable: true}
			if id == 12 {
				st.Deliverable = false
				st.Reason = "insufficient allowance"
			}
			items = append(items, st)
		}
		rawJSON, _ := json.Marshal(items)
		_, _ = w.Write(abciOK(t, "("+strconv.Quote(string(rawJSON))+" string)"))
	}))
	defer srv.Close()

	client := NewClient(srv.URL)
	client.Sleep = func(_ context.Context, _ time.Duration) error { return nil }

	res := CheckDeliverable(context.Background(), client, DefaultRealmPath, ids)
	if len(res.Warnings) != 0 || len(res.Unknown) != 0 {
		t.Fatalf("expected retry to recover cleanly, got unknown=%v warnings=%v", res.Unknown, res.Warnings)
	}
	if len(res.Statuses) != 55 {
		t.Fatalf("expected 55 statuses, got %d", len(res.Statuses))
	}
	if st := res.Statuses[12]; st.Deliverable || st.Reason != "insufficient allowance" {
		t.Fatalf("unexpected status for offer 12: %+v", st)
	}
	if !res.Statuses[55].Deliverable {
		t.Fatalf("expected offer 55 deliverable, got %+v", res.Statuses[55])
	}
	// Expect 3 calls total: batch1(50) fail, batch1(50) retry ok, batch2(5) ok.
	if len(batchesSeen) != 3 || batchesSeen[0] != 50 || batchesSeen[1] != 50 || batchesSeen[2] != 5 {
		t.Fatalf("unexpected batch sequence: %v", batchesSeen)
	}
}

func TestCheckDeliverable_DoubleFailureTreatedAsUnknown(t *testing.T) {
	var attempts atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		attempts.Add(1)
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write(abciErr(t, "kylix: settlement in progress", "VM panic"))
	}))
	defer srv.Close()

	client := NewClient(srv.URL)
	client.Sleep = func(_ context.Context, _ time.Duration) error { return nil }

	res := CheckDeliverable(context.Background(), client, DefaultRealmPath, []uint64{7, 3, 7})
	if attempts.Load() != 2 {
		t.Fatalf("expected 2 attempts (initial + 1 retry), got %d", attempts.Load())
	}
	if len(res.Statuses) != 0 {
		t.Fatalf("expected no confirmed statuses on double failure, got %+v", res.Statuses)
	}
	if len(res.Unknown) != 2 || res.Unknown[0] != 3 || res.Unknown[1] != 7 {
		t.Fatalf("expected unknown=[3,7], got %v", res.Unknown)
	}
	if len(res.Warnings) != 1 {
		t.Fatalf("expected 1 warning, got %v", res.Warnings)
	}
	if strings.Contains(res.Warnings[0], "settlement in progress") {
		t.Fatalf("safe Warnings must not include raw VM panic text, got %q", res.Warnings[0])
	}
	if len(res.VerboseWarnings) != 1 || !strings.Contains(res.VerboseWarnings[0], "settlement in progress") {
		t.Fatalf("VerboseWarnings should retain raw error detail, got %v", res.VerboseWarnings)
	}
}

func TestParseDeliverableJSON_ObjectAndArray(t *testing.T) {
	obj := []byte(`{"height":123,"offers":[{"id":7,"deliverable":true,"reason":""},{"id":9,"deliverable":false,"reason":"expired"}]}`)
	arr := []byte(`[{"id":7,"deliverable":true,"reason":""},{"id":9,"deliverable":false,"reason":"expired"}]`)
	for name, raw := range map[string][]byte{"object": obj, "array": arr} {
		items, err := ParseDeliverableJSON(raw)
		if err != nil {
			t.Fatalf("%s: %v", name, err)
		}
		if len(items) != 2 || items[0].ID != 7 || !items[0].Deliverable || items[1].ID != 9 || items[1].Deliverable || items[1].Reason != "expired" {
			t.Fatalf("%s: unexpected items %+v", name, items)
		}
	}
}
