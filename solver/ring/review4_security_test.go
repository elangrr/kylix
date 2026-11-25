package ring

import (
	"fmt"
	"testing"
)

// Review 4 (R4-2a): A few dense starting offers that each yield thousands of
// rings must not exhaust DefaultMaxRings (10,000) and hide unrelated honest
// rings later in the book. DefaultMaxRingsPerStart (100) caps rings per start
// while keeping DefaultMaxRings as a global backstop.
func TestReview4_MaxRingsPerStartReachesHonestRingBehindDenseStarts(t *testing.T) {
	const (
		t1   = "gno.land/r/evil/t1.T1"
		t2   = "gno.land/r/evil/t2.T2"
		t3   = "gno.land/r/evil/t3.T3"
		t4   = "gno.land/r/evil/t4.T4"
		t5   = "gno.land/r/evil/t5.T5"
		t6   = "gno.land/r/evil/t6.T6"
		tokA = "gno.land/r/gnoland/wugnot.wugnot"
		tokB = "gno.land/r/gnoswap/gns.GNS"
	)

	var offers []Offer
	id := uint64(1)

	// 6 early starting offers (IDs 1..6), each feeding into a 5-layer DAG
	// (1*2*6*12*16 = 2,304 rings per start; > 10,000 total without per-start cap).
	for i := 0; i < 6; i++ {
		offers = append(offers, offer(id, fmt.Sprintf("g1dead%02d", i), fungible(t1, 1), fungible(t6, 1)))
		id++
	}
	addLayer := func(count int, prefix, giveTok, wantTok string) {
		for i := 0; i < count; i++ {
			offers = append(offers, offer(id, fmt.Sprintf("%s_%02d", prefix, i), fungible(giveTok, 1), fungible(wantTok, 1)))
			id++
		}
	}
	addLayer(1, "g1l2", t2, t1)
	addLayer(2, "g1l3", t3, t2)
	addLayer(6, "g1l4", t4, t3)
	addLayer(12, "g1l5", t5, t4)
	addLayer(16, "g1l6", t6, t5)

	// Unrelated honest ring at higher IDs.
	offers = append(offers,
		offer(1000, "g1alice", fungible(tokA, 1000), fungible(tokB, 1000)),
		offer(1001, "g1bob", fungible(tokB, 1000), fungible(tokA, 1000)),
	)

	t.Run("default per-start cap reaches honest ring and blames capped starts", func(t *testing.T) {
		res := FindRings(Graph{Height: 500, Offers: offers}, nil, Options{})
		if !res.Stats.Truncated || res.Stats.TruncatedReason != "max_rings_per_start" {
			t.Fatalf("expected max_rings_per_start truncation, got %+v", res.Stats)
		}
		// 6 starts * 100 rings + 1 honest ring = 601 rings.
		if want := 6*DefaultMaxRingsPerStart + 1; len(res.Rings) != want {
			t.Fatalf("got %d rings, want %d", len(res.Rings), want)
		}
		foundHonest := false
		for _, r := range res.Rings {
			if r.FormatIDs() == "1000,1001" {
				foundHonest = true
				break
			}
		}
		if !foundHonest {
			t.Fatalf("expected honest ring [1000,1001] to be found behind 6 dense starts")
		}
		if len(res.BlockingOffers) == 0 {
			t.Fatalf("expected non-empty BlockingOffers for max_rings_per_start")
		}
		for _, bid := range res.BlockingOffers {
			if bid == 1000 || bid == 1001 {
				t.Fatalf("unrelated honest offer #%d must not be blamed for max_rings_per_start: %v", bid, res.BlockingOffers)
			}
		}
	})

	t.Run("global MaxRings remains a backstop", func(t *testing.T) {
		res := FindRings(Graph{Height: 500, Offers: offers}, nil, Options{
			MaxRings:         150,
			MaxRingsPerStart: 100,
		})
		if !res.Stats.Truncated {
			t.Fatalf("expected truncation at global MaxRings backstop, got %+v", res.Stats)
		}
		if len(res.Rings) != 150 {
			t.Fatalf("expected global MaxRings backstop at 150 rings, got %d", len(res.Rings))
		}
	})
}
