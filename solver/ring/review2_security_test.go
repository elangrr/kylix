package ring

import (
	"fmt"
	"math"
	"testing"
)

// Inverted from security review 2 (N5): a single attacker posting
// DefaultMaxFanout (64) cheap dust offers wanting tokA must NOT blind newer
// honest offers because per-owner caps and distinct-owner fan-out ordering
// preserve honest counterparties.
func TestReview2_MaxFanoutSingleAttackerDoesNotBlindSolver(t *testing.T) {
	const (
		tokA    = "gno.land/r/gnoland/wugnot.wugnot"
		tokB    = "gno.land/r/gnoswap/gns.GNS"
		tokJunk = "gno.land/r/attacker/junk.JUNK"
	)
	var offers []Offer
	for i := 1; i <= DefaultMaxFanout; i++ {
		offers = append(offers, offer(uint64(i), "g1attacker", fungible(tokJunk, 1), fungible(tokA, 1)))
	}
	// Honest 2-ring posted after the 64 spam offers.
	offers = append(offers,
		offer(100, "g1alice", fungible(tokA, 1000), fungible(tokB, 1000)),
		offer(101, "g1bob", fungible(tokB, 1000), fungible(tokA, 1000)),
	)

	res := FindRings(Graph{Height: 100, Offers: offers}, nil, Options{})
	foundHonest := false
	for _, r := range res.Rings {
		if r.FormatIDs() == "100,101" {
			foundHonest = true
			break
		}
	}
	if !foundHonest {
		t.Fatalf("expected honest ring [100,101] to be found despite 64 spam offers from one owner, got %+v (stats=%+v)", res.Rings, res.Stats)
	}
}

// Verifies that distinct owners are preferred before truncating at MaxFanout:
// 32 owners each posting 2 offers (64 total) must not crowd out owner #33..#64
// when MaxFanout is 64.
func TestReview2_DistinctOwnersPreferredBeforeMaxFanout(t *testing.T) {
	const (
		tokA    = "gno.land/r/gnoland/wugnot.wugnot"
		tokB    = "gno.land/r/gnoswap/gns.GNS"
		tokJunk = "gno.land/r/attacker/junk.JUNK"
	)
	var offers []Offer
	id := uint64(1)
	// 32 owners each post 2 offers wanting tokA (64 offers total, IDs 1..64).
	for o := 0; o < 32; o++ {
		owner := fmt.Sprintf("g1spam%02d", o)
		offers = append(offers,
			offer(id, owner, fungible(tokJunk, 1), fungible(tokA, 1)),
			offer(id+1, owner, fungible(tokJunk, 1), fungible(tokA, 1)),
		)
		id += 2
	}
	// Honest owner #33 posts offer 201 wanting tokA, paired with offer 200.
	offers = append(offers,
		offer(200, "g1alice", fungible(tokA, 1000), fungible(tokB, 1000)),
		offer(201, "g1bob", fungible(tokB, 1000), fungible(tokA, 1000)),
	)

	res := FindRings(Graph{Height: 100, Offers: offers}, nil, Options{MaxFanout: 64, MaxPerOwner: 4})
	foundHonest := false
	for _, r := range res.Rings {
		if r.FormatIDs() == "200,201" {
			foundHonest = true
			break
		}
	}
	if !foundHonest {
		t.Fatalf("expected distinct owner g1bob to be included ahead of 2nd offers from 32 earlier owners, got %+v", res.Rings)
	}
}

// Inverted from security review 2 (N5): 200 dust bridged pairs from the same
// attacker owners must NOT exhaust MaxQuotes (200) before an honest bridged
// ring at higher IDs is quoted.
func TestReview2_MaxQuotesExhaustionDoesNotBlindBridgedRings(t *testing.T) {
	const (
		tokA          = "gno.land/r/gnoland/wugnot.wugnot"
		tokB          = "gno.land/r/gnoswap/gns.GNS"
		col           = "gno.land/r/nym-kylix000/kylixdemo"
		cliDefaultCap = 200 // main.go default --max-quotes
	)
	var offers []Offer
	for i := 1; i <= cliDefaultCap; i++ {
		itemID := fmt.Sprintf("spam-%d", i)
		offers = append(offers,
			offer(uint64(2*i-1), "g1spam1", fungible(tokA, int64(i)), item(col, itemID)),
			offer(uint64(2*i), "g1spam2", item(col, itemID), fungible(tokB, 999_999_999)),
		)
	}
	// Honest bridged 2-ring at IDs 1000, 1001.
	offers = append(offers,
		offer(1000, "g1alice", fungible(tokA, 5000), item(col, "honest-1")),
		offer(1001, "g1bob", item(col, "honest-1"), fungible(tokB, 4000)),
	)

	quote := func(in, out string, amt int64) (int64, uint32, bool, error) {
		if in == tokA && out == tokB {
			return amt, 3000, true, nil
		}
		return 0, 0, false, nil
	}

	res := FindRings(Graph{Height: 100, Offers: offers}, quote, Options{MaxQuotes: cliDefaultCap})
	foundHonest := false
	for _, r := range res.Rings {
		if r.FormatIDs() == "1000,1001" && r.IsBridged() {
			foundHonest = true
			break
		}
	}
	if !foundHonest {
		t.Fatalf("expected honest bridged ring [1000,1001] to be found despite 200 dust pairs, got %+v (stats=%+v)", res.Rings, res.Stats)
	}
}

// Inverted from security review 2 (N5): with OfficialOnly=true (the CLI
// default when --allow-unofficial is false), offers touching unofficial
// collections are removed BEFORE the search, so a dense unofficial clique
// cannot exhaust DefaultMaxRings and hide honest official rings.
func TestReview2_UnofficialCliquePreFilteredDoesNotExhaustMaxRings(t *testing.T) {
	const (
		tokA       = "gno.land/r/gnoland/wugnot.wugnot"
		tokB       = "gno.land/r/gnoswap/gns.GNS"
		unofficial = "gno.land/r/evil/unofficial"
	)
	toks := []string{
		"gno.land/r/evil/t.T1",
		"gno.land/r/evil/t.T2",
		"gno.land/r/evil/t.T3",
		"gno.land/r/evil/t.T4",
	}
	var offers []Offer
	id := uint64(1)
	for k := 0; k < 12; k++ {
		offers = append(offers, offer(id, "g1e0", item(unofficial, fmt.Sprintf("u-%d", k)), fungible(toks[3], 1)))
		id++
	}
	for k := 0; k < 12; k++ {
		offers = append(offers, offer(id, "g1e1", fungible(toks[0], 1), item(unofficial, fmt.Sprintf("u-%d", k))))
		id++
	}
	for j := 0; j < 10; j++ {
		offers = append(offers, offer(id, "g1e2", fungible(toks[1], 1), fungible(toks[0], 1)))
		id++
	}
	for j := 0; j < 10; j++ {
		offers = append(offers, offer(id, "g1e3", fungible(toks[2], 1), fungible(toks[1], 1)))
		id++
	}
	for j := 0; j < 10; j++ {
		offers = append(offers, offer(id, "g1e4", fungible(toks[3], 1), fungible(toks[2], 1)))
		id++
	}
	// Honest official 2-ring at IDs 1000, 1001.
	offers = append(offers,
		offer(1000, "g1alice", fungible(tokA, 100), fungible(tokB, 100)),
		offer(1001, "g1bob", fungible(tokB, 100), fungible(tokA, 100)),
	)

	g := Graph{
		Height: 100,
		Collections: []Collection{
			{Key: unofficial, Name: "Evil", Adapter: true, Official: false},
		},
		Offers: offers,
	}
	res := FindRings(g, nil, Options{OfficialOnly: true})
	if res.Stats.OffersSkippedUnofficial != 24 {
		t.Fatalf("expected 24 unofficial offers skipped before search, got %d", res.Stats.OffersSkippedUnofficial)
	}
	if len(res.Rings) != 1 || res.Rings[0].FormatIDs() != "1000,1001" {
		t.Fatalf("expected honest official ring [1000,1001], got %+v (stats=%+v)", res.Rings, res.Stats)
	}
}

// Inverted from security review 2 (N8): expiry comparison must not overflow
// int64 when Height or ExpiryMargin is near math.MaxInt64.
func TestReview2_HeightOverflowDoesNotBypassExpiry(t *testing.T) {
	const (
		tokA = "gno.land/r/demo/a.AAA"
		tokB = "gno.land/r/demo/b.BBB"
	)
	cases := []struct {
		name      string
		height    int64
		expiry    int64
		margin    int64
		wantRings int
	}{
		{
			name:      "height near MaxInt64 with expired offers",
			height:    math.MaxInt64 - 1,
			expiry:    100,
			margin:    10,
			wantRings: 0,
		},
		{
			name:      "height near MaxInt64 within margin of MaxInt64 expiry",
			height:    math.MaxInt64 - 5,
			expiry:    math.MaxInt64,
			margin:    10,
			wantRings: 0,
		},
		{
			name:      "height near MaxInt64 exactly at margin boundary",
			height:    math.MaxInt64 - 10,
			expiry:    math.MaxInt64,
			margin:    10,
			wantRings: 1,
		},
		{
			name:      "huge margin does not wrap",
			height:    100,
			expiry:    1000,
			margin:    math.MaxInt64,
			wantRings: 0,
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			g := Graph{
				Height: tc.height,
				Offers: []Offer{
					{ID: 1, Owner: "g1alice", Give: fungible(tokA, 10), Want: fungible(tokB, 10), Expiry: tc.expiry},
					{ID: 2, Owner: "g1bob", Give: fungible(tokB, 10), Want: fungible(tokA, 10), Expiry: tc.expiry},
				},
			}
			res := FindRings(g, nil, Options{ExpiryMargin: tc.margin})
			if len(res.Rings) != tc.wantRings {
				t.Fatalf("got %d rings (%+v), want %d (stats=%+v)", len(res.Rings), res.Rings, tc.wantRings, res.Stats)
			}
		})
	}
}
