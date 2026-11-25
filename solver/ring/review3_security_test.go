package ring

import (
	"fmt"
	"testing"
)

// Verifies that FindRings reports prioritized BlockingOffers whenever any
// search bound truncates the search, and returns nil BlockingOffers when no
// bound is hit.
func TestReview3_BlockingOffersReportedForAllBounds(t *testing.T) {
	const (
		tokA = "gno.land/r/gnoland/wugnot.wugnot"
		tokB = "gno.land/r/gnoswap/gns.GNS"
		col  = "gno.land/r/nym-kylix000/kylixdemo"
	)

	t.Run("no truncation emits no blocking offers", func(t *testing.T) {
		g := Graph{
			Height: 100,
			Offers: []Offer{
				offer(1, "g1a", fungible(tokA, 100), fungible(tokB, 100)),
				offer(2, "g1b", fungible(tokB, 100), fungible(tokA, 100)),
			},
		}
		res := FindRings(g, nil, Options{})
		if res.Stats.Truncated {
			t.Fatalf("unexpected truncation: %+v", res.Stats)
		}
		if len(res.BlockingOffers) != 0 {
			t.Fatalf("expected 0 BlockingOffers when not truncated, got %v", res.BlockingOffers)
		}
	})

	t.Run("max_fanout reports full-list occupants interleaved by asset", func(t *testing.T) {
		var offers []Offer
		for i := 1; i <= 4; i++ {
			offers = append(offers, offer(uint64(i), fmt.Sprintf("g1s%d", i), item(col, fmt.Sprintf("f-%d", i)), fungible(tokA, 1)))
		}
		offers = append(offers,
			offer(100, "g1alice", fungible(tokA, 100), fungible(tokB, 100)),
			offer(101, "g1bob", fungible(tokB, 100), fungible(tokA, 100)),
		)
		res := FindRings(Graph{Height: 100, Offers: offers}, nil, Options{MaxFanout: 4})
		if !res.Stats.Truncated || res.Stats.TruncatedReason != "max_fanout" {
			t.Fatalf("expected max_fanout truncation, got %+v", res.Stats)
		}
		if len(res.BlockingOffers) != 4 {
			t.Fatalf("expected 4 blocking offers (1..4), got %v", res.BlockingOffers)
		}
		for i, id := range res.BlockingOffers {
			if id != uint64(i+1) {
				t.Fatalf("blocking[%d] = %d, want %d (all=%v)", i, id, i+1, res.BlockingOffers)
			}
		}
	})

	t.Run("max_per_owner reports capped owner's kept offers", func(t *testing.T) {
		offers := []Offer{
			offer(1, "g1alice", item(col, "a1"), fungible(tokA, 1)),
			offer(2, "g1alice", item(col, "a2"), fungible(tokA, 1)),
			offer(3, "g1alice", fungible(tokB, 100), fungible(tokA, 100)),
			offer(4, "g1bob", fungible(tokA, 100), fungible(tokB, 100)),
		}
		res := FindRings(Graph{Height: 100, Offers: offers}, nil, Options{MaxPerOwner: 2})
		if !res.Stats.Truncated || res.Stats.TruncatedReason != "max_per_owner" {
			t.Fatalf("expected max_per_owner truncation, got %+v", res.Stats)
		}
		if len(res.BlockingOffers) != 2 || res.BlockingOffers[0] != 1 || res.BlockingOffers[1] != 2 {
			t.Fatalf("expected blocking offers [1 2], got %v", res.BlockingOffers)
		}
	})

	t.Run("max_quotes reports offers consuming quotes", func(t *testing.T) {
		offers := []Offer{
			offer(1, "g1a", fungible(tokA, 10), item(col, "i1")),
			offer(2, "g1b", item(col, "i1"), fungible(tokB, 999999)),
			offer(3, "g1c", fungible(tokA, 20), item(col, "i2")),
			offer(4, "g1d", item(col, "i2"), fungible(tokB, 999999)),
			offer(5, "g1e", fungible(tokA, 30), item(col, "i3")),
			offer(6, "g1f", item(col, "i3"), fungible(tokB, 10)),
		}
		quote := func(in, out string, amt int64) (int64, uint32, bool, error) {
			return amt, 3000, true, nil
		}
		res := FindRings(Graph{Height: 100, Offers: offers}, quote, Options{MaxQuotes: 2})
		if !res.Stats.Truncated || res.Stats.TruncatedReason != "max_quotes" {
			t.Fatalf("expected max_quotes truncation, got %+v", res.Stats)
		}
		if len(res.BlockingOffers) == 0 {
			t.Fatalf("expected non-empty BlockingOffers for max_quotes")
		}
		// Offers 1,2,3,4 consumed the 2 quotes; 5,6 did not.
		has1 := false
		for _, id := range res.BlockingOffers {
			if id == 1 {
				has1 = true
			}
			if id == 5 || id == 6 {
				t.Fatalf("unquoted offer #%d should not be in quote BlockingOffers: %v", id, res.BlockingOffers)
			}
		}
		if !has1 {
			t.Fatalf("expected offer #1 in quote BlockingOffers: %v", res.BlockingOffers)
		}
	})
}
