package ring

import (
	"fmt"
	"math/rand"
	"reflect"
	"sort"
	"testing"
	"time"
)

func fungible(key string, amount int64) Asset {
	return Asset{Kind: KindFungible, Key: key, Amount: amount}
}

func item(collection, id string) Asset {
	return Asset{Kind: KindItem, Key: collection, ID: id}
}

func offer(id uint64, owner string, give, want Asset) Offer {
	return Offer{ID: id, Owner: owner, Give: give, Want: want}
}

func ringsAsStrings(rings []Ring) []string {
	out := make([]string, len(rings))
	for i, r := range rings {
		if r.IsBridged() {
			out[i] = fmt.Sprintf("%s@b%d", r.FormatIDs(), r.BridgedHop)
		} else {
			out[i] = r.FormatIDs()
		}
	}
	sort.Strings(out)
	return out
}

func TestFindRings_TableDriven(t *testing.T) {
	const (
		tokA = "gno.land/r/demo/a.AAA"
		tokB = "gno.land/r/demo/b.BBB"
		tokC = "gno.land/r/demo/c.CCC"
		tokD = "gno.land/r/demo/d.DDD"
		tokE = "gno.land/r/demo/e.EEE"
		tokF = "gno.land/r/demo/f.FFF"
		tokG = "gno.land/r/demo/g.GGG"
		col1 = "gno.land/r/kylixdemo/relics"
		col2 = "gno.land/r/other/cards"
	)

	// Quote function: 1:1 with 1% fee for pairs in pools map.
	makeQuoter := func(rates map[string]float64) QuoteFunc {
		return func(tokenIn, tokenOut string, amountIn int64) (int64, uint32, bool, error) {
			rate, ok := rates[tokenIn+"->"+tokenOut]
			if !ok {
				return 0, 0, false, nil
			}
			return int64(float64(amountIn) * rate), 3000, true, nil
		}
	}

	tests := []struct {
		name      string
		graph     Graph
		quote     QuoteFunc
		wantRings []string // "id1,id2" for direct, "id1,id2@b<hop>" for bridged
	}{
		{
			name: "no ring",
			graph: Graph{Offers: []Offer{
				offer(1, "alice", fungible(tokA, 100), fungible(tokB, 100)),
				offer(2, "bob", fungible(tokB, 100), fungible(tokC, 100)),
			}},
			wantRings: []string{},
		},
		{
			name: "2-ring fungible exact and surplus",
			graph: Graph{Offers: []Offer{
				offer(10, "alice", fungible(tokA, 120), fungible(tokB, 90)),
				offer(5, "bob", fungible(tokB, 100), fungible(tokA, 100)),
			}},
			// Canonical rotation starts at smallest offer ID (5).
			wantRings: []string{"5,10"},
		},
		{
			name: "2-ring item for fungible",
			graph: Graph{Offers: []Offer{
				offer(1, "alice", item(col1, "relic-7"), fungible(tokA, 50)),
				offer(2, "bob", fungible(tokA, 50), item(col1, "relic-7")),
			}},
			wantRings: []string{"1,2"},
		},
		{
			name: "6-ring accepted",
			graph: Graph{Offers: []Offer{
				offer(1, "u1", fungible(tokA, 10), fungible(tokF, 10)),
				offer(2, "u2", fungible(tokB, 10), fungible(tokA, 10)),
				offer(3, "u3", fungible(tokC, 10), fungible(tokB, 10)),
				offer(4, "u4", fungible(tokD, 10), fungible(tokC, 10)),
				offer(5, "u5", fungible(tokE, 10), fungible(tokD, 10)),
				offer(6, "u6", fungible(tokF, 10), fungible(tokE, 10)),
			}},
			wantRings: []string{"1,2,3,4,5,6"},
		},
		{
			name: "7-cycle must be refused",
			graph: Graph{Offers: []Offer{
				offer(1, "u1", fungible(tokA, 10), fungible(tokG, 10)),
				offer(2, "u2", fungible(tokB, 10), fungible(tokA, 10)),
				offer(3, "u3", fungible(tokC, 10), fungible(tokB, 10)),
				offer(4, "u4", fungible(tokD, 10), fungible(tokC, 10)),
				offer(5, "u5", fungible(tokE, 10), fungible(tokD, 10)),
				offer(6, "u6", fungible(tokF, 10), fungible(tokE, 10)),
				offer(7, "u7", fungible(tokG, 10), fungible(tokF, 10)),
			}},
			wantRings: []string{},
		},
		{
			name: "same owner twice refused",
			graph: Graph{Offers: []Offer{
				offer(1, "alice", fungible(tokA, 10), fungible(tokC, 10)),
				offer(2, "bob", fungible(tokB, 10), fungible(tokA, 10)),
				offer(3, "alice", fungible(tokC, 10), fungible(tokB, 10)),
			}},
			wantRings: []string{},
		},
		{
			name: "amount below minimum refused",
			graph: Graph{Offers: []Offer{
				offer(1, "alice", fungible(tokA, 99), fungible(tokB, 100)),
				offer(2, "bob", fungible(tokB, 100), fungible(tokA, 100)),
			}},
			wantRings: []string{},
		},
		{
			name: "item id mismatch refused",
			graph: Graph{Offers: []Offer{
				offer(1, "alice", item(col1, "relic-7"), fungible(tokA, 50)),
				offer(2, "bob", fungible(tokA, 50), item(col1, "relic-8")),
			}},
			wantRings: []string{},
		},
		{
			name: "collection key mismatch refused",
			graph: Graph{Offers: []Offer{
				offer(1, "alice", item(col1, "relic-7"), fungible(tokA, 50)),
				offer(2, "bob", fungible(tokA, 50), item(col2, "relic-7")),
			}},
			wantRings: []string{},
		},
		{
			name: "duplicate given item refused",
			graph: Graph{Offers: []Offer{
				offer(1, "alice", item(col1, "relic-1"), fungible(tokA, 10)),
				offer(2, "bob", fungible(tokA, 10), item(col1, "relic-1")),
				offer(3, "carol", item(col1, "relic-1"), fungible(tokB, 10)),
				offer(4, "dave", fungible(tokB, 10), item(col1, "relic-1")),
			}},
			// Only 2-rings (1,2) and (3,4) are valid; no 4-ring combining 1 and 3.
			wantRings: []string{"1,2", "3,4"},
		},
		{
			name: "expired offer skipped",
			graph: Graph{
				Height: 500,
				Offers: []Offer{
					{ID: 1, Owner: "alice", Give: fungible(tokA, 10), Want: fungible(tokB, 10), Expiry: 499},
					{ID: 2, Owner: "bob", Give: fungible(tokB, 10), Want: fungible(tokA, 10), Expiry: 500},
				},
			},
			wantRings: []string{},
		},
		{
			name: "offer expiring at current height still valid",
			graph: Graph{
				Height: 500,
				Offers: []Offer{
					{ID: 1, Owner: "alice", Give: fungible(tokA, 10), Want: fungible(tokB, 10), Expiry: 500},
					{ID: 2, Owner: "bob", Give: fungible(tokB, 10), Want: fungible(tokA, 10), Expiry: 0},
				},
			},
			wantRings: []string{"1,2"},
		},
		{
			name: "one bridged hop accepted in 2-ring",
			graph: Graph{Offers: []Offer{
				// Offer 10 gives item relic-1, wants 100 tokB
				offer(10, "alice", item(col1, "relic-1"), fungible(tokB, 100)),
				// Offer 3 gives 200 tokA, wants item relic-1 (10 -> 3 direct, 3 -> 10 bridged tokA->tokB)
				offer(3, "bob", fungible(tokA, 200), item(col1, "relic-1")),
			}},
			quote: makeQuoter(map[string]float64{tokA + "->" + tokB: 0.6}), // 200*0.6 = 120 >= 100
			// Canonical rotation: [3, 10], bridged hop is 3 -> 10 (index 0).
			wantRings: []string{"3,10@b0"},
		},
		{
			name: "one bridged hop accepted in 3-ring",
			graph: Graph{Offers: []Offer{
				offer(1, "alice", item(col1, "relic-1"), fungible(tokC, 90)),
				offer(2, "bob", fungible(tokA, 100), item(col1, "relic-1")),
				offer(3, "carol", fungible(tokB, 100), fungible(tokA, 100)),
			}},
			// Direct: 1 -> 2 (relic-1), 2 -> 3 (tokA). Bridged: 3 -> 1 (tokB -> tokC).
			// Wait: 3 gives tokB, 1 wants tokC; 2 gives tokA, 3 wants tokA.
			// Direct path is 1 -> 2 -> 3, closed by bridged 3 -> 1 (hop index 2).
			quote:     makeQuoter(map[string]float64{tokB + "->" + tokC: 0.95}), // 95 >= 90
			wantRings: []string{"1,2,3@b2"},
		},
		{
			name: "bridged hop output below want minimum refused",
			graph: Graph{Offers: []Offer{
				offer(1, "alice", item(col1, "relic-1"), fungible(tokB, 100)),
				offer(2, "bob", fungible(tokA, 100), item(col1, "relic-1")),
			}},
			quote:     makeQuoter(map[string]float64{tokA + "->" + tokB: 0.99}), // 99 < 100
			wantRings: []string{},
		},
		{
			name: "bridged hop refused when no pool",
			graph: Graph{Offers: []Offer{
				offer(1, "alice", item(col1, "relic-1"), fungible(tokB, 100)),
				offer(2, "bob", fungible(tokA, 100), item(col1, "relic-1")),
			}},
			quote:     makeQuoter(map[string]float64{}),
			wantRings: []string{},
		},
		{
			name: "same token insufficient amount cannot be bridged",
			graph: Graph{Offers: []Offer{
				offer(1, "alice", fungible(tokA, 100), fungible(tokB, 100)),
				offer(2, "bob", fungible(tokB, 50), fungible(tokA, 100)),
			}},
			// Even with a generous quoter on tokB->tokB, bridging identical keys is forbidden.
			quote:     makeQuoter(map[string]float64{tokB + "->" + tokB: 10.0}),
			wantRings: []string{},
		},
		{
			name: "two bridged hops refused (2-ring)",
			graph: Graph{Offers: []Offer{
				offer(1, "alice", fungible(tokA, 100), fungible(tokD, 50)),
				offer(2, "bob", fungible(tokC, 100), fungible(tokB, 50)),
			}},
			quote: makeQuoter(map[string]float64{
				tokA + "->" + tokB: 1.0,
				tokC + "->" + tokD: 1.0,
			}),
			wantRings: []string{},
		},
		{
			name: "two bridged hops refused (3-ring)",
			graph: Graph{Offers: []Offer{
				// 1 -> 2 would need tokA -> tokB (bridge #1)
				// 2 -> 3 is direct (relic-1)
				// 3 -> 1 would need tokC -> tokD (bridge #2)
				offer(1, "alice", fungible(tokA, 100), fungible(tokD, 50)),
				offer(2, "bob", item(col1, "relic-1"), fungible(tokB, 50)),
				offer(3, "carol", fungible(tokC, 100), item(col1, "relic-1")),
			}},
			quote: makeQuoter(map[string]float64{
				tokA + "->" + tokB: 1.0,
				tokC + "->" + tokD: 1.0,
			}),
			wantRings: []string{},
		},
		{
			name: "rotation deduplication across 3-ring",
			graph: Graph{Offers: []Offer{
				offer(30, "carol", fungible(tokC, 10), fungible(tokB, 10)),
				offer(10, "alice", fungible(tokA, 10), fungible(tokC, 10)),
				offer(20, "bob", fungible(tokB, 10), fungible(tokA, 10)),
			}},
			wantRings: []string{"10,20,30"},
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			res := FindRings(tc.graph, tc.quote, Options{})
			got := ringsAsStrings(res.Rings)
			if !reflect.DeepEqual(got, tc.wantRings) {
				t.Fatalf("FindRings() = %v, want %v", got, tc.wantRings)
			}
			for _, r := range res.Rings {
				if err := VerifyRing(tc.graph, r, tc.quote); err != nil {
					t.Errorf("VerifyRing(%v) failed: %v", r, err)
				}
				for i := 1; i < len(r.IDs); i++ {
					if r.IDs[i] <= r.IDs[0] {
						t.Errorf("ring %v is not in canonical min-ID-first rotation", r.IDs)
					}
				}
			}
		})
	}
}

func TestSelectRings_Overlapping(t *testing.T) {
	const (
		tokA = "gno.land/r/demo/a.AAA"
		tokB = "gno.land/r/demo/b.BBB"
		tokC = "gno.land/r/demo/c.CCC"
		tokD = "gno.land/r/demo/d.DDD"
		tokE = "gno.land/r/demo/e.EEE"
		col  = "gno.land/r/kylixdemo/relics"
	)

	t.Run("longer ring beats overlapping shorter ring", func(t *testing.T) {
		// Offer 1 is shared between a 2-ring [1,2] and a 3-ring [1,3,4].
		// Offers [5,6] form a disjoint 2-ring that must also be selected.
		g := Graph{Offers: []Offer{
			offer(1, "u1", fungible(tokA, 10), fungible(tokB, 10)),
			offer(2, "u2", fungible(tokB, 10), fungible(tokA, 10)),
			offer(3, "u3", fungible(tokC, 10), fungible(tokA, 10)),
			offer(4, "u4", fungible(tokB, 10), fungible(tokC, 10)),
			offer(5, "u5", fungible(tokD, 10), fungible(tokE, 10)),
			offer(6, "u6", fungible(tokE, 10), fungible(tokD, 10)),
		}}
		res := FindRings(g, nil, Options{})
		if len(res.Rings) != 3 {
			t.Fatalf("expected 3 candidate rings, got %d: %v", len(res.Rings), res.Rings)
		}
		sel := SelectRings(res.Rings)
		got := ringsAsStrings(sel)
		want := []string{"1,3,4", "5,6"}
		if !reflect.DeepEqual(got, want) {
			t.Fatalf("SelectRings() = %v, want %v", got, want)
		}
	})

	t.Run("direct beats bridged on equal length", func(t *testing.T) {
		// Offer 1 (relic-1 -> tokB) can settle with 2 (tokA -> relic-1, bridged)
		// or with 3 (tokB -> relic-1, direct). Both are 2-rings; direct wins even
		// though offer 2 is older than offer 3.
		g := Graph{Offers: []Offer{
			offer(1, "u1", item(col, "r1"), fungible(tokB, 100)),
			offer(2, "u2", fungible(tokA, 200), item(col, "r1")),
			offer(3, "u3", fungible(tokB, 100), item(col, "r1")),
		}}
		quote := func(in, out string, amt int64) (int64, uint32, bool, error) {
			if in == tokA && out == tokB {
				return amt, 3000, true, nil
			}
			return 0, 0, false, nil
		}
		res := FindRings(g, quote, Options{})
		sel := SelectRings(res.Rings)
		if len(sel) != 1 || sel[0].IsBridged() || sel[0].FormatIDs() != "1,3" {
			t.Fatalf("SelectRings() = %v, want direct [1,3]", sel)
		}
	})

	t.Run("oldest offers break ties on equal length and kind", func(t *testing.T) {
		g := Graph{Offers: []Offer{
			offer(1, "u1", fungible(tokA, 10), fungible(tokB, 10)),
			offer(5, "u2", fungible(tokB, 10), fungible(tokA, 10)),
			offer(2, "u3", fungible(tokB, 10), fungible(tokA, 10)),
		}}
		res := FindRings(g, nil, Options{})
		sel := SelectRings(res.Rings)
		if len(sel) != 1 || sel[0].FormatIDs() != "1,2" {
			t.Fatalf("SelectRings() = %v, want [1,2]", sel)
		}
	})
}

func TestParseGraphJSON_Lenient(t *testing.T) {
	raw := []byte(`{
		"realm": "gno.land/r/nym-kylix000/kylix",
		"height": 4242,
		"next": 77,
		"hasMore": true,
		"unknownTopLevel": {"nested": [1, 2, 3]},
		"offers": [
			{
				"id": 1,
				"owner": "g1alice",
				"nonce": 1,
				"slot": "g1slot1",
				"give": {"kind": "fungible", "key": "gno.land/r/x.FOO", "id": "", "amount": "1000", "decimals": 6},
				"want": {"kind": "item", "key": "gno.land/r/y", "id": "relic-7", "amount": "0", "collectionName": "Relics"},
				"expiry": 0,
				"flaggedAt": 0,
				"viaSession": false,
				"futureField": "ignored"
			},
			{
				"id": "2",
				"owner": "g1bob",
				"nonce": "3",
				"slot": "g1slot2",
				"give": {"kind": "item", "key": "gno.land/r/y", "id": "relic-7", "amount": ""},
				"want": {"kind": "fungible", "key": "gno.land/r/x.FOO", "amount": 900},
				"expiry": "5000",
				"flaggedAt": null
			}
		]
	}`)

	g, err := ParseGraphJSON(raw)
	if err != nil {
		t.Fatalf("ParseGraphJSON failed: %v", err)
	}
	if g.Height != 4242 || g.Next != 77 || !g.HasMore || len(g.Offers) != 2 {
		t.Fatalf("unexpected graph metadata: %+v", g)
	}
	if g.Offers[0].Give.Amount != 1000 || g.Offers[1].Want.Amount != 900 || g.Offers[1].ID != 2 {
		t.Fatalf("unexpected parsed offers: %+v", g.Offers)
	}
	res := FindRings(g, nil, Options{})
	if len(res.Rings) != 1 || res.Rings[0].FormatIDs() != "1,2" {
		t.Fatalf("expected ring [1,2], got %v", res.Rings)
	}
}

func TestFindRings_RandomizedAgainstIndependentVerifier(t *testing.T) {
	rng := rand.New(rand.NewSource(20261218))
	tokens := []string{"tok/A", "tok/B", "tok/C", "tok/D", "tok/E"}
	owners := []string{"u1", "u2", "u3", "u4", "u5", "u6", "u7", "u8", "u9", "u10"}
	col := "col/relics"

	randomAsset := func(r *rand.Rand) Asset {
		if r.Intn(4) == 0 {
			return item(col, fmt.Sprintf("item-%d", r.Intn(5)))
		}
		return fungible(tokens[r.Intn(len(tokens))], int64(1+r.Intn(5))*10)
	}

	makeRandomGraph := func(r *rand.Rand, n int) (Graph, QuoteFunc) {
		offers := make([]Offer, 0, n)
		for i := 1; i <= n; i++ {
			give := randomAsset(r)
			want := randomAsset(r)
			for give.SameAs(want) {
				want = randomAsset(r)
			}
			offers = append(offers, Offer{
				ID:    uint64(i * 3), // non-contiguous IDs
				Owner: owners[r.Intn(len(owners))],
				Give:  give,
				Want:  want,
			})
		}
		// Shuffle offer slice order to test order-independence.
		r.Shuffle(len(offers), func(i, j int) { offers[i], offers[j] = offers[j], offers[i] })

		// Deterministic random pool rates on a subset of pairs.
		rates := make(map[string]float64)
		for _, a := range tokens {
			for _, b := range tokens {
				if a != b && r.Intn(3) == 0 {
					rates[a+"->"+b] = 0.5 + float64(r.Intn(15))/10.0
				}
			}
		}
		quote := func(in, out string, amt int64) (int64, uint32, bool, error) {
			rate, ok := rates[in+"->"+out]
			if !ok {
				return 0, 0, false, nil
			}
			return int64(float64(amt) * rate), 3000, true, nil
		}
		return Graph{Height: 100, Offers: offers}, quote
	}

	// 1) Small graphs: check soundness (VerifyRing) AND completeness against brute-force enumeration.
	for trial := 0; trial < 40; trial++ {
		n := 6 + rng.Intn(4) // 6..9 offers
		g, quote := makeRandomGraph(rng, n)
		res := FindRings(g, quote, Options{
			MaxFanout:        -1,
			MaxSteps:         -1,
			MaxStepsPerStart: -1,
			MaxRings:         -1,
		})
		if res.Stats.Truncated {
			t.Fatalf("trial %d: unexpected truncation with unlimited bounds", trial)
		}

		seen := make(map[string]bool)
		for _, r := range res.Rings {
			if err := VerifyRing(g, r, quote); err != nil {
				t.Fatalf("trial %d: VerifyRing(%v) failed: %v", trial, r, err)
			}
			for i := 1; i < len(r.IDs); i++ {
				if r.IDs[i] <= r.IDs[0] {
					t.Fatalf("trial %d: ring %v not canonical", trial, r.IDs)
				}
			}
			k := r.FormatIDs()
			if seen[k] {
				t.Fatalf("trial %d: duplicate ring %s", trial, k)
			}
			seen[k] = true
		}

		// Brute-force enumerate all valid rings of length 2..6 to prove completeness.
		wantBrute := bruteForceRings(g, quote)
		got := ringsAsStrings(res.Rings)
		want := ringsAsStrings(wantBrute)
		if !reflect.DeepEqual(got, want) {
			t.Fatalf("trial %d: mismatch vs brute force:\ngot:  %v\nwant: %v", trial, got, want)
		}
	}

	// 2) Medium graphs with default bounds: verify every returned and selected ring.
	for trial := 0; trial < 25; trial++ {
		n := 40 + rng.Intn(40)
		g, quote := makeRandomGraph(rng, n)
		byID := IndexOffers(g.Offers)
		res := FindRings(g, quote, Options{})
		for _, r := range res.Rings {
			if err := VerifyRingIndexed(byID, g.Height, r, quote); err != nil {
				t.Fatalf("medium trial %d: VerifyRing(%v) failed: %v", trial, r, err)
			}
		}
		sel := SelectRings(res.Rings)
		used := make(map[uint64]bool)
		for _, r := range sel {
			if err := VerifyRingIndexed(byID, g.Height, r, quote); err != nil {
				t.Fatalf("medium trial %d: selected ring %v invalid: %v", trial, r, err)
			}
			for _, id := range r.IDs {
				if used[id] {
					t.Fatalf("medium trial %d: offer %d used in two selected rings", trial, id)
				}
				used[id] = true
			}
		}
	}
}

// bruteForceRings independently enumerates every canonical 2..6 ring by testing
// all ordered tuples against VerifyRing directly. Only used on small test graphs.
func bruteForceRings(g Graph, quote QuoteFunc) []Ring {
	offers := make([]Offer, len(g.Offers))
	copy(offers, g.Offers)
	sort.Slice(offers, func(i, j int) bool { return offers[i].ID < offers[j].ID })
	byID := IndexOffers(offers)

	var found []Ring
	seen := make(map[string]bool)

	var perm []uint64
	used := make([]bool, len(offers))
	var dfs func(startIdx int)
	dfs = func(startIdx int) {
		if len(perm) >= MinLegs {
			// Try direct and each possible single bridged hop.
			for b := NoBridge; b < len(perm); b++ {
				cand := Ring{
					IDs:        append([]uint64(nil), perm...),
					BridgedHop: b,
				}
				if err := VerifyRingIndexed(byID, g.Height, cand, quote); err == nil {
					k := cand.FormatIDs()
					if !seen[k] {
						seen[k] = true
						found = append(found, cand)
					}
					break
				}
			}
		}
		if len(perm) == MaxLegs {
			return
		}
		for i := startIdx + 1; i < len(offers); i++ {
			if used[i] {
				continue
			}
			used[i] = true
			perm = append(perm, offers[i].ID)
			dfs(startIdx)
			perm = perm[:len(perm)-1]
			used[i] = false
		}
	}

	for s := 0; s < len(offers); s++ {
		used[s] = true
		perm = []uint64{offers[s].ID}
		dfs(s)
		used[s] = false
	}
	return found
}

func TestFindRings_LargeBookBoundedFast(t *testing.T) {
	rng := rand.New(rand.NewSource(99))
	const totalOffers = 3000

	tokens := make([]string, 20)
	for i := range tokens {
		tokens[i] = fmt.Sprintf("gno.land/r/tok%d.T%d", i, i)
	}

	offers := make([]Offer, 0, totalOffers+3)
	// 1..3000: dense fungible book across 20 tokens and 1000 owners.
	for i := 1; i <= totalOffers; i++ {
		a := rng.Intn(len(tokens))
		b := rng.Intn(len(tokens))
		for b == a {
			b = rng.Intn(len(tokens))
		}
		offers = append(offers, Offer{
			ID:    uint64(i),
			Owner: fmt.Sprintf("g1owner%04d", rng.Intn(1000)),
			Give:  fungible(tokens[a], int64(10+rng.Intn(100))),
			Want:  fungible(tokens[b], int64(10+rng.Intn(100))),
		})
	}
	// Append an isolated 3-ring of items at the very end to verify fairness
	// across start offers even when earlier clusters hit per-start bounds.
	offers = append(offers,
		offer(5001, "g1special1", item("gno.land/r/relics", "r1"), item("gno.land/r/relics", "r3")),
		offer(5002, "g1special2", item("gno.land/r/relics", "r2"), item("gno.land/r/relics", "r1")),
		offer(5003, "g1special3", item("gno.land/r/relics", "r3"), item("gno.land/r/relics", "r2")),
	)

	g := Graph{Height: 1000, Offers: offers}
	quote := func(in, out string, amt int64) (int64, uint32, bool, error) {
		if in == tokens[0] && out == tokens[1] {
			return amt, 3000, true, nil
		}
		return 0, 0, false, nil
	}

	start := time.Now()
	res := FindRings(g, quote, Options{MaxQuotes: 100})
	elapsed := time.Since(start)

	if elapsed > 3*time.Second {
		t.Fatalf("large book search took too long: %v", elapsed)
	}
	if len(res.Rings) == 0 {
		t.Fatalf("expected rings in large book, got 0")
	}

	byID := IndexOffers(g.Offers)
	foundSpecial := false
	for _, r := range res.Rings {
		if r.FormatIDs() == "5001,5002,5003" {
			foundSpecial = true
		}
		if err := VerifyRingIndexed(byID, g.Height, r, quote); err != nil {
			t.Fatalf("invalid ring in large book: %v: %v", r, err)
		}
	}
	if !foundSpecial {
		t.Fatalf("expected fair per-start budget to find isolated ring [5001,5002,5003] (stats: %+v)", res.Stats)
	}
	sel := SelectRings(res.Rings)
	if len(sel) == 0 {
		t.Fatalf("expected selected rings, got 0")
	}
	t.Logf("3003 offers: found %d candidate rings, selected %d disjoint rings in %v (steps=%d truncated=%v reason=%s)",
		len(res.Rings), len(sel), elapsed, res.Stats.Steps, res.Stats.Truncated, res.Stats.TruncatedReason)
}

func TestFindRings_ExpiryMarginAndOldFormat(t *testing.T) {
	const (
		tokA = "gno.land/r/demo/a.AAA"
		tokB = "gno.land/r/demo/b.BBB"
	)

	g := Graph{
		Height: 1000,
		Offers: []Offer{
			// Expires in 5 blocks (1005 < 1000+10): skipped with margin 10.
			{ID: 1, Owner: "u1", Give: fungible(tokA, 10), Want: fungible(tokB, 10), Expiry: 1005},
			// Expires in 10 blocks (1010 >= 1000+10): kept with margin 10.
			{ID: 2, Owner: "u2", Give: fungible(tokB, 10), Want: fungible(tokA, 10), Expiry: 1010},
			// Old-format offer with Expiry == 0 ("never"): kept.
			{ID: 3, Owner: "u3", Give: fungible(tokA, 10), Want: fungible(tokB, 10), Expiry: 0},
			// Already expired (999 < 1000): skipped.
			{ID: 4, Owner: "u4", Give: fungible(tokB, 10), Want: fungible(tokA, 10), Expiry: 999},
		},
	}

	res := FindRings(g, nil, Options{ExpiryMargin: 10})
	if res.Stats.OffersSkippedExpiry != 2 {
		t.Fatalf("OffersSkippedExpiry = %d, want 2", res.Stats.OffersSkippedExpiry)
	}
	got := ringsAsStrings(res.Rings)
	want := []string{"2,3"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("FindRings(ExpiryMargin=10) = %v, want %v", got, want)
	}

	// With IgnoreExpiry=true, near-expiry and expired offers are included.
	resIgnore := FindRings(g, nil, Options{ExpiryMargin: 10, IgnoreExpiry: true})
	if resIgnore.Stats.OffersSkippedExpiry != 0 || resIgnore.Stats.OffersEligible != 4 {
		t.Fatalf("IgnoreExpiry stats unexpected: %+v", resIgnore.Stats)
	}
}

func TestFilterOfficialRings(t *testing.T) {
	const (
		tokA       = "gno.land/r/demo/a.AAA"
		tokB       = "gno.land/r/demo/b.BBB"
		tokC       = "gno.land/r/demo/c.CCC"
		tokD       = "gno.land/r/demo/d.DDD"
		tokE       = "gno.land/r/demo/e.EEE"
		colOff     = "gno.land/r/nym-kylix000/kylixdemo"
		colUnoff   = "gno.land/r/thirdparty/cards"
		colMissing = "gno.land/r/unknown/missing"
	)

	g := Graph{
		Height: 100,
		Collections: []Collection{
			{Key: colOff, Name: "Relics", Official: true, ApprovalCheck: true},
			{Key: colUnoff, Name: "Cards", Official: false, Adapter: true, Target: "gno.land/r/cards"},
		},
		Offers: []Offer{
			// Ring [1,2]: official item
			{ID: 1, Owner: "u1", Give: item(colOff, "r1"), Want: fungible(tokA, 10), Expiry: 200},
			{ID: 2, Owner: "u2", Give: fungible(tokA, 10), Want: item(colOff, "r1"), Expiry: 200},
			// Ring [3,4]: explicit official=false item
			{ID: 3, Owner: "u3", Give: item(colUnoff, "c1"), Want: fungible(tokB, 10), Expiry: 200},
			{ID: 4, Owner: "u4", Give: fungible(tokB, 10), Want: item(colUnoff, "c1"), Expiry: 200},
			// Ring [5,6]: missing from collections array -> counts as unofficial
			{ID: 5, Owner: "u5", Give: item(colMissing, "m1"), Want: fungible(tokC, 10), Expiry: 200},
			{ID: 6, Owner: "u6", Give: fungible(tokC, 10), Want: item(colMissing, "m1"), Expiry: 200},
			// Ring [7,8]: pure fungible -> always official
			{ID: 7, Owner: "u7", Give: fungible(tokD, 10), Want: fungible(tokE, 10), Expiry: 200},
			{ID: 8, Owner: "u8", Give: fungible(tokE, 10), Want: fungible(tokD, 10), Expiry: 200},
		},
	}

	res := FindRings(g, nil, Options{})
	byID := IndexOffers(g.Offers)
	cols := IndexCollections(g.Collections)
	official, unofficial := FilterOfficialRings(res.Rings, byID, cols)

	gotOff := ringsAsStrings(official)
	wantOff := []string{"1,2", "7,8"}
	if !reflect.DeepEqual(gotOff, wantOff) {
		t.Fatalf("official rings = %v, want %v", gotOff, wantOff)
	}
	gotUnoff := ringsAsStrings(unofficial)
	wantUnoff := []string{"3,4", "5,6"}
	if !reflect.DeepEqual(gotUnoff, wantUnoff) {
		t.Fatalf("unofficial rings = %v, want %v", gotUnoff, wantUnoff)
	}
}
