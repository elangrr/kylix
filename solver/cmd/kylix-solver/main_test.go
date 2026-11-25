package main

import (
	"bytes"
	"context"
	"encoding/base64"
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

	"kylix/solver/rpc"
)

func abciWrap(s string) []byte {
	b, _ := json.Marshal(map[string]any{
		"jsonrpc": "2.0",
		"result": map[string]any{
			"response": map[string]any{
				"ResponseBase": map[string]any{
					"Error": nil,
					"Data":  base64.StdEncoding.EncodeToString([]byte(s)),
					"Log":   "",
				},
			},
		},
	})
	return b
}

func abciErrorWrap(msg string) []byte {
	b, _ := json.Marshal(map[string]any{
		"jsonrpc": "2.0",
		"result": map[string]any{
			"response": map[string]any{
				"ResponseBase": map[string]any{
					"Error": map[string]any{"@type": "/abci.StringError", "value": msg},
					"Data":  "",
					"Log":   "VM panic: " + msg,
				},
			},
		},
	})
	return b
}

func TestCLI_GraphFileTextAndJSON(t *testing.T) {
	graphJSON := `{
		"realm": "gno.land/r/nym-kylix000/kylix",
		"height": 777,
		"collections": [
			{"key": "gno.land/r/nym-kylix000/kylixdemo", "name": "Relics", "adapter": false, "target": "", "official": true, "approvalCheck": true}
		],
		"offers": [
			{"id": 3, "owner": "g1alice", "nonce": 1, "slot": "g1s1",
			 "give": {"kind": "fungible", "key": "gno.land/r/demo/a.AAA", "id": "", "amount": "100"},
			 "want": {"kind": "item", "key": "gno.land/r/nym-kylix000/kylixdemo", "id": "r-1", "amount": "0"},
			 "expiry": 1000, "viaSession": false},
			{"id": 7, "owner": "g1bob", "nonce": 1, "slot": "g1s2",
			 "give": {"kind": "item", "key": "gno.land/r/nym-kylix000/kylixdemo", "id": "r-1", "amount": "0"},
			 "want": {"kind": "fungible", "key": "gno.land/r/demo/a.AAA", "id": "", "amount": "90"},
			 "expiry": 1000, "viaSession": false}
		]
	}`
	dir := t.TempDir()
	path := filepath.Join(dir, "graph.json")
	if err := os.WriteFile(path, []byte(graphJSON), 0o600); err != nil {
		t.Fatal(err)
	}

	// Text mode
	var stdout, stderr bytes.Buffer
	err := run(context.Background(), []string{"--graph", path, "--key", "alice"}, nil, &stdout, &stderr)
	if err != nil {
		t.Fatalf("text mode failed: %v (stderr=%s)", err, stderr.String())
	}
	text := stdout.String()
	if !strings.Contains(text, "Ring 1: [3,7]") {
		t.Fatalf("expected Ring 1: [3,7] in output:\n%s", text)
	}
	if !strings.Contains(text, "gnokey maketx call -pkgpath 'gno.land/r/nym-kylix000/kylix' -func SettleRing -args '3,7'") {
		t.Fatalf("expected exact SettleRing command in output:\n%s", text)
	}
	if !strings.Contains(text, "-max-deposit '350000ugnot'") {
		t.Fatalf("expected explicit per-ring -max-deposit (1 token + 1 item = 350000ugnot) in output:\n%s", text)
	}
	if !strings.Contains(text, "-chainid 'onyx-1'") || !strings.Contains(text, "alice") {
		t.Fatalf("expected chainid and key in output:\n%s", text)
	}

	// JSON mode with custom --max-deposit
	stdout.Reset()
	stderr.Reset()
	err = run(context.Background(), []string{"--graph", path, "--max-deposit", "250000", "--json"}, nil, &stdout, &stderr)
	if err != nil {
		t.Fatalf("json mode failed: %v", err)
	}
	var parsed solverOutput
	if err := json.Unmarshal(stdout.Bytes(), &parsed); err != nil {
		t.Fatalf("invalid json output: %v\n%s", err, stdout.String())
	}
	if parsed.Height != 777 || parsed.MaxDeposit != 250000 || len(parsed.Selected) != 1 || parsed.Selected[0].IDsArg != "3,7" {
		t.Fatalf("unexpected json output: %+v", parsed)
	}
	if parsed.Selected[0].Func != "SettleRing" {
		t.Fatalf("expected Func=SettleRing, got %q", parsed.Selected[0].Func)
	}
	if !strings.Contains(parsed.Selected[0].GnokeyCommand, "-max-deposit '250000ugnot'") {
		t.Fatalf("expected custom -max-deposit in command: %s", parsed.Selected[0].GnokeyCommand)
	}
	if parsed.RPCCalls != 0 {
		t.Fatalf("offline --graph mode must make 0 RPC calls (deliverable off automatically), got %d", parsed.RPCCalls)
	}

	// Zero --max-deposit must be rejected (since 0 falls back to chain default_deposit).
	stdout.Reset()
	stderr.Reset()
	if err := run(context.Background(), []string{"--graph", path, "--max-deposit", "0"}, nil, &stdout, &stderr); err == nil {
		t.Fatal("expected error for --max-deposit 0, got nil")
	}
}

func TestCLI_OldFormatExportStillParses(t *testing.T) {
	// Old export: expiry=0 ("never"), flaggedAt present, no collections field, pure fungible ring.
	oldJSON := `{
		"realm": "gno.land/r/nym-kylix000/kylix",
		"height": 500,
		"offers": [
			{"id": 1, "owner": "g1alice", "nonce": 1, "slot": "g1s1",
			 "give": {"kind": "fungible", "key": "gno.land/r/demo/a.AAA", "id": "", "amount": "100"},
			 "want": {"kind": "fungible", "key": "gno.land/r/demo/b.BBB", "id": "", "amount": "50"},
			 "expiry": 0, "flaggedAt": 420, "viaSession": false},
			{"id": 2, "owner": "g1bob", "nonce": 1, "slot": "g1s2",
			 "give": {"kind": "fungible", "key": "gno.land/r/demo/b.BBB", "id": "", "amount": "50"},
			 "want": {"kind": "fungible", "key": "gno.land/r/demo/a.AAA", "id": "", "amount": "100"},
			 "expiry": 0, "flaggedAt": 0, "viaSession": false}
		]
	}`
	dir := t.TempDir()
	path := filepath.Join(dir, "old.json")
	if err := os.WriteFile(path, []byte(oldJSON), 0o600); err != nil {
		t.Fatal(err)
	}

	var stdout, stderr bytes.Buffer
	if err := run(context.Background(), []string{"--graph", path, "--json"}, nil, &stdout, &stderr); err != nil {
		t.Fatalf("old export failed to parse: %v", err)
	}
	var parsed solverOutput
	if err := json.Unmarshal(stdout.Bytes(), &parsed); err != nil {
		t.Fatalf("decode json: %v", err)
	}
	if len(parsed.Selected) != 1 || parsed.Selected[0].IDsArg != "1,2" {
		t.Fatalf("expected ring [1,2] from old export, got %+v", parsed)
	}
}

func TestCLI_UnofficialCollectionsSkippedAndAllowed(t *testing.T) {
	graphJSON := `{
		"realm": "gno.land/r/nym-kylix000/kylix",
		"height": 100,
		"collections": [
			{"key": "gno.land/r/nym-kylix000/kylixdemo", "name": "Relics", "adapter": false, "target": "", "official": true, "approvalCheck": true},
			{"key": "gno.land/r/evil/bomb", "name": "Bomb", "adapter": false, "target": "", "official": false, "approvalCheck": false}
		],
		"offers": [
			{"id": 1, "owner": "g1a", "nonce": 1, "slot": "g1s1",
			 "give": {"kind": "item", "key": "gno.land/r/nym-kylix000/kylixdemo", "id": "r1", "amount": "0"},
			 "want": {"kind": "fungible", "key": "tokA", "id": "", "amount": "10"}, "expiry": 500},
			{"id": 2, "owner": "g1b", "nonce": 1, "slot": "g1s2",
			 "give": {"kind": "fungible", "key": "tokA", "id": "", "amount": "10"},
			 "want": {"kind": "item", "key": "gno.land/r/nym-kylix000/kylixdemo", "id": "r1", "amount": "0"}, "expiry": 500},
			{"id": 3, "owner": "g1c", "nonce": 1, "slot": "g1s3",
			 "give": {"kind": "item", "key": "gno.land/r/evil/bomb", "id": "b1", "amount": "0"},
			 "want": {"kind": "fungible", "key": "tokB", "id": "", "amount": "10"}, "expiry": 500},
			{"id": 4, "owner": "g1d", "nonce": 1, "slot": "g1s4",
			 "give": {"kind": "fungible", "key": "tokB", "id": "", "amount": "10"},
			 "want": {"kind": "item", "key": "gno.land/r/evil/bomb", "id": "b1", "amount": "0"}, "expiry": 500},
			{"id": 5, "owner": "g1e", "nonce": 1, "slot": "g1s5",
			 "give": {"kind": "item", "key": "gno.land/r/unlisted/col", "id": "u1", "amount": "0"},
			 "want": {"kind": "fungible", "key": "tokC", "id": "", "amount": "10"}, "expiry": 500},
			{"id": 6, "owner": "g1f", "nonce": 1, "slot": "g1s6",
			 "give": {"kind": "fungible", "key": "tokC", "id": "", "amount": "10"},
			 "want": {"kind": "item", "key": "gno.land/r/unlisted/col", "id": "u1", "amount": "0"}, "expiry": 500}
		]
	}`
	dir := t.TempDir()
	path := filepath.Join(dir, "graph.json")
	if err := os.WriteFile(path, []byte(graphJSON), 0o600); err != nil {
		t.Fatal(err)
	}

	// Default: unofficial (both official=false and missing from collections) skipped and counted.
	var stdout, stderr bytes.Buffer
	if err := run(context.Background(), []string{"--graph", path}, nil, &stdout, &stderr); err != nil {
		t.Fatalf("default run failed: %v", err)
	}
	text := stdout.String()
	if !strings.Contains(text, "Skipped 4 offer(s) touching unofficial collection(s)") {
		t.Fatalf("expected skipped unofficial report in text output:\n%s", text)
	}
	if strings.Contains(text, "[3,4]") || strings.Contains(text, "[5,6]") {
		t.Fatalf("unofficial rings must not appear by default:\n%s", text)
	}
	if !strings.Contains(text, "Ring 1: [1,2]") {
		t.Fatalf("official ring [1,2] must appear:\n%s", text)
	}

	// JSON default check.
	stdout.Reset()
	if err := run(context.Background(), []string{"--graph", path, "--json"}, nil, &stdout, &stderr); err != nil {
		t.Fatalf("default json failed: %v", err)
	}
	var defOut solverOutput
	if err := json.Unmarshal(stdout.Bytes(), &defOut); err != nil {
		t.Fatal(err)
	}
	if defOut.SkippedUnofficial != 4 || len(defOut.Selected) != 1 || defOut.Selected[0].IDsArg != "1,2" {
		t.Fatalf("unexpected default json output: %+v", defOut)
	}

	// With --allow-unofficial: all 3 rings included, warning printed next to each unofficial ring.
	stdout.Reset()
	if err := run(context.Background(), []string{"--graph", path, "--allow-unofficial"}, nil, &stdout, &stderr); err != nil {
		t.Fatalf("--allow-unofficial run failed: %v", err)
	}
	allowText := stdout.String()
	if !strings.Contains(allowText, "[3,4]") || !strings.Contains(allowText, "[5,6]") {
		t.Fatalf("expected unofficial rings included:\n%s", allowText)
	}
	if !strings.Contains(allowText, "WARNING: touches unofficial collection(s): gno.land/r/evil/bomb") {
		t.Fatalf("expected warning for gno.land/r/evil/bomb:\n%s", allowText)
	}
	if !strings.Contains(allowText, "WARNING: touches unofficial collection(s): gno.land/r/unlisted/col") {
		t.Fatalf("expected warning for gno.land/r/unlisted/col:\n%s", allowText)
	}
}

func TestCLI_NearExpiryOffersSkipped(t *testing.T) {
	graphJSON := `{
		"realm": "gno.land/r/nym-kylix000/kylix",
		"height": 1000,
		"offers": [
			{"id": 1, "owner": "g1a", "nonce": 1, "slot": "g1s1",
			 "give": {"kind": "fungible", "key": "tokA", "id": "", "amount": "10"},
			 "want": {"kind": "fungible", "key": "tokB", "id": "", "amount": "10"}, "expiry": 1005},
			{"id": 2, "owner": "g1b", "nonce": 1, "slot": "g1s2",
			 "give": {"kind": "fungible", "key": "tokB", "id": "", "amount": "10"},
			 "want": {"kind": "fungible", "key": "tokA", "id": "", "amount": "10"}, "expiry": 1050},
			{"id": 3, "owner": "g1c", "nonce": 1, "slot": "g1s3",
			 "give": {"kind": "fungible", "key": "tokA", "id": "", "amount": "10"},
			 "want": {"kind": "fungible", "key": "tokB", "id": "", "amount": "10"}, "expiry": 1010}
		]
	}`
	dir := t.TempDir()
	path := filepath.Join(dir, "expiry.json")
	if err := os.WriteFile(path, []byte(graphJSON), 0o600); err != nil {
		t.Fatal(err)
	}

	// Default --expiry-margin=10 skips offer 1 (expires at 1005), keeps offer 3 (expires at 1010).
	var stdout, stderr bytes.Buffer
	if err := run(context.Background(), []string{"--graph", path, "--json"}, nil, &stdout, &stderr); err != nil {
		t.Fatalf("run failed: %v", err)
	}
	var out solverOutput
	if err := json.Unmarshal(stdout.Bytes(), &out); err != nil {
		t.Fatal(err)
	}
	if out.Stats.OffersSkippedExpiry != 1 || len(out.Selected) != 1 || out.Selected[0].IDsArg != "2,3" {
		t.Fatalf("expected offer 1 skipped and ring [2,3] selected, got %+v", out)
	}

	// Larger --expiry-margin=20 skips offer 3 too, leaving 0 rings.
	stdout.Reset()
	if err := run(context.Background(), []string{"--graph", path, "--expiry-margin", "20", "--json"}, nil, &stdout, &stderr); err != nil {
		t.Fatalf("run with margin 20 failed: %v", err)
	}
	out = solverOutput{}
	if err := json.Unmarshal(stdout.Bytes(), &out); err != nil {
		t.Fatal(err)
	}
	if out.Stats.OffersSkippedExpiry != 2 || len(out.Selected) != 0 {
		t.Fatalf("expected 2 offers skipped and 0 rings, got %+v", out)
	}
}

func TestCLI_LiveFakeRPCWithMultiPoolBridgedRingAndDeliverableRetry(t *testing.T) {
	const (
		wugnot = "gno.land/r/gnoland/wugnot.wugnot"
		gns    = "gno.land/r/gnoswap/gns.GNS"
		tokX   = "gno.land/r/demo/x.XXX"
		tokY   = "gno.land/r/demo/y.YYY"
		col    = "gno.land/r/nym-kylix000/kylixdemo"
	)

	// Two disjoint candidate rings:
	// - [1,2]: bridged ring (wugnot -> GNS) touching official collection; both deliverable.
	// - [3,4]: direct ring (tokX <-> tokY) where offer 4 is undeliverable -> must be dropped.
	graphJSON := fmt.Sprintf(`{"realm":"gno.land/r/nym-kylix000/kylix","height":9001,`+
		`"collections":[{"key":%q,"name":"Relics","adapter":false,"target":"","official":true,"approvalCheck":true}],`+
		`"offers":[`+
		`{"id":1,"owner":"g1alice","nonce":1,"slot":"g1s1",`+
		`"give":{"kind":"fungible","key":%q,"id":"","amount":"1000000"},`+
		`"want":{"kind":"item","key":%q,"id":"relic-7","amount":"0"},`+
		`"expiry":9500,"viaSession":false},`+
		`{"id":2,"owner":"g1bob","nonce":1,"slot":"g1s2",`+
		`"give":{"kind":"item","key":%q,"id":"relic-7","amount":"0"},`+
		`"want":{"kind":"fungible","key":%q,"id":"","amount":"500000"},`+
		`"expiry":9500,"viaSession":false},`+
		`{"id":3,"owner":"g1carol","nonce":1,"slot":"g1s3",`+
		`"give":{"kind":"fungible","key":%q,"id":"","amount":"100"},`+
		`"want":{"kind":"fungible","key":%q,"id":"","amount":"100"},`+
		`"expiry":9500,"viaSession":false},`+
		`{"id":4,"owner":"g1dave","nonce":1,"slot":"g1s4",`+
		`"give":{"kind":"fungible","key":%q,"id":"","amount":"100"},`+
		`"want":{"kind":"fungible","key":%q,"id":"","amount":"100"},`+
		`"expiry":9500,"viaSession":false}]}`,
		col, wugnot, col, col, gns, tokX, tokY, tokY, tokX)

	var delivAttempts atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hexData := strings.TrimPrefix(r.URL.Query().Get("data"), "0x")
		b, _ := hex.DecodeString(hexData)
		q := string(b)
		w.Header().Set("Content-Type", "application/json")

		switch {
		case q == "gno.land/r/nym-kylix000/kylix.ExportGraphJSONPage(0, 500)":
			_, _ = w.Write(abciWrap("(" + strconv.Quote(graphJSON) + " string)"))
		case strings.HasPrefix(q, rpc.DefaultGnoSwapPoolPath+".ExistsPoolPath("):
			// Both 3000 (healthy) and 10000 (decoy with worse quote) exist.
			exists := strings.Contains(q, ",3000)") || strings.Contains(q, ",10000)")
			_, _ = w.Write(abciWrap(fmt.Sprintf("(%v bool)", exists)))
		case strings.HasPrefix(q, rpc.DefaultGnoSwapRouterPath+".DrySwapRoute("):
			if strings.Contains(q, wugnot+":"+gns+":3000") {
				_, _ = w.Write(abciWrap("(\"1000000\" string)\n(\"907629\" string)\n(undefined)\n"))
				return
			}
			if strings.Contains(q, wugnot+":"+gns+":10000") {
				// Decoy pool returns terrible quote.
				_, _ = w.Write(abciWrap("(\"1000000\" string)\n(\"18105\" string)\n(undefined)\n"))
				return
			}
			_, _ = w.Write(abciWrap("(\"0\" string)\n(\"0\" string)\n(&(struct{(\"no pool\" string)} err) *err)\n"))
		case strings.HasPrefix(q, "gno.land/r/nym-kylix000/kylix.Deliverable("):
			// First call fails (concurrent settlement), retry succeeds!
			if delivAttempts.Add(1) == 1 {
				_, _ = w.Write(abciErrorWrap("kylix: settlement in progress"))
				return
			}
			resp := `[{"id":1,"deliverable":true,"reason":""},{"id":2,"deliverable":true,"reason":""},{"id":3,"deliverable":true,"reason":""},{"id":4,"deliverable":false,"reason":"allowance revoked"}]`
			_, _ = w.Write(abciWrap("(" + strconv.Quote(resp) + " string)"))
		default:
			http.Error(w, "unexpected query: "+q, http.StatusBadRequest)
		}
	}))
	defer srv.Close()

	var stdout, stderr bytes.Buffer
	err := run(context.Background(), []string{
		"--rpc", srv.URL,
		"--realm", "gno.land/r/nym-kylix000/kylix",
		"--fee-tiers", "3000,10000",
		"--json",
	}, nil, &stdout, &stderr)
	if err != nil {
		t.Fatalf("fake-RPC run failed: %v (stderr=%s)", err, stderr.String())
	}

	var parsed solverOutput
	if err := json.Unmarshal(stdout.Bytes(), &parsed); err != nil {
		t.Fatalf("decode json: %v\n%s", err, stdout.String())
	}
	if delivAttempts.Load() != 2 {
		t.Fatalf("expected 2 Deliverable calls (fail + 1 retry), got %d", delivAttempts.Load())
	}
	if len(parsed.DroppedUndeliverable) != 1 || parsed.DroppedUndeliverable[0].IDsArg != "3,4" ||
		parsed.DroppedUndeliverable[0].OfferID != 4 || parsed.DroppedUndeliverable[0].Reason != "allowance revoked" {
		t.Fatalf("unexpected dropped undeliverable list: %+v", parsed.DroppedUndeliverable)
	}
	if len(parsed.Selected) != 1 {
		t.Fatalf("expected 1 deliverable bridged ring, got %d: %+v", len(parsed.Selected), parsed)
	}
	sel := parsed.Selected[0]
	if !sel.Bridged || sel.IDsArg != "1,2" || sel.BridgedHop != 0 || sel.Func != "SettleRingVia" || sel.Fee != 3000 {
		t.Fatalf("unexpected selected bridged ring: %+v", sel)
	}
	if sel.Bridge == nil || sel.Bridge.ExpectedOut != 907629 || sel.Bridge.Fee != 3000 {
		t.Fatalf("unexpected bridge info: %+v", sel.Bridge)
	}
	if len(sel.Hops) != 2 || sel.Hops[0].Fee != 3000 || sel.Hops[0].QuoteOut != 907629 {
		t.Fatalf("expected hop 0 to carry fee and quoteOut: %+v", sel.Hops)
	}
	if !strings.Contains(sel.GnokeyCommand, "-func SettleRingVia -args '1,2' -args '3000'") {
		t.Fatalf("expected SettleRingVia with fee arg in gnokey command: %s", sel.GnokeyCommand)
	}
	if !strings.Contains(sel.GnokeyCommand, "-gas-wanted 94000000") {
		t.Fatalf("expected bridged gas-wanted in gnokey command: %s", sel.GnokeyCommand)
	}
	if !strings.Contains(sel.GnokeyCommand, "-max-deposit '600000ugnot'") {
		t.Fatalf("expected per-ring bridged -max-deposit (1 token + 1 item + bridge = 600000ugnot) in gnokey command: %s", sel.GnokeyCommand)
	}

	// Verify --check-deliverable=false skips Deliverable RPC queries altogether.
	delivBefore := delivAttempts.Load()
	stdout.Reset()
	err = run(context.Background(), []string{
		"--rpc", srv.URL,
		"--realm", "gno.land/r/nym-kylix000/kylix",
		"--fee-tiers", "3000,10000",
		"--check-deliverable=false",
		"--json",
	}, nil, &stdout, &stderr)
	if err != nil {
		t.Fatalf("run with --check-deliverable=false failed: %v", err)
	}
	if delivAttempts.Load() != delivBefore {
		t.Fatalf("expected 0 Deliverable calls with --check-deliverable=false, got %d", delivAttempts.Load()-delivBefore)
	}
	var noCheck solverOutput
	if err := json.Unmarshal(stdout.Bytes(), &noCheck); err != nil {
		t.Fatal(err)
	}
	if len(noCheck.Selected) != 2 {
		t.Fatalf("expected both rings selected when deliverability check is off, got %d", len(noCheck.Selected))
	}
}
