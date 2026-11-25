package kylix

// Regression tests for security review 1 (docs/research/security-review-1.md)
// that fit in-package. The others are filetests (z_storagebomb_*,
// z_bridge_decoy_*, z_bridge_via_*) and r/adapters/adaptertest.

import (
	"chain"
	"strings"
	"testing"

	"gno.land/p/nt/uassert/v0"
	"gno.land/r/gnoswap/pool"
)

// Finding 6: a page of the export looks at a bounded number of offers
// however many have expired, and "hasMore" is not set when only expired
// offers remain. "collections" appears only on the first page.
func TestExportPageBoundedScan(cur realm, t *testing.T) {
	before := OpenOffers()
	h := chainHeight()
	active := post(cur, alice, fooKey, 10, barKey, 10)
	var stale []uint64
	for i := 0; i < 3; i++ {
		stale = append(stale, postRaw(cur, bob, "fungible", fooKey, "", 1, "fungible", barKey, "", 1, h+1))
	}
	testing.SkipHeights(2)

	p := ExportGraphJSONPage(active-1, 1)
	uassert.True(t, strings.Contains(p, `"id":`+u64(active)+`,`), p)
	uassert.True(t, strings.Contains(p, `"hasMore":false,"next":0`), "only expired offers remain: "+p)
	uassert.False(t, strings.Contains(p, `"collections"`), "collections on a later page")
	uassert.True(t, strings.Contains(ExportGraphJSONPage(0, 1), `"collections":[`), "collections on the first page")

	// MaxExportPage+100 more expired offers: one page looks at no more than
	// MaxExportPage of them and hands back a cursor inside the stretch.
	for i := 0; i < MaxExportPage+100; i++ {
		stale = append(stale, postRaw(cur, bob, "fungible", fooKey, "", 1, "fungible", barKey, "", 1, chainHeight()+1))
	}
	testing.SkipHeights(2)
	first := stale[3]
	p = ExportGraphJSONPage(first-1, 1)
	uassert.True(t, strings.Contains(p, `"offers":[],"hasMore":true,"next":`+u64(first+MaxExportPage-1)+`,`), p)
	p = ExportGraphJSONPage(first+MaxExportPage-1, 1)
	uassert.True(t, strings.Contains(p, `"offers":[],"hasMore":false,"next":0`), p)

	cancelAs(cur, alice, active)
	for _, id := range stale {
		testing.SetRealm(testing.NewUserRealm(mal))
		PruneIntent(cross(cur), id)
	}
	uassert.Equal(t, before, OpenOffers())
}

// Finding 3: the ring page names the pool and offers SettleRingVia, so a
// visitor settles through the pool they checked, not the automatic choice.
func testingPoolAddr() address { return chain.PackageAddress("gno.land/r/gnoswap/pool") }

func TestRingPageNamesThePool(cur realm, t *testing.T) {
	testing.SetRealm(testing.NewCodeRealm("gno.land/r/test/poolmaker"))
	pool.MockCreatePool(cross(cur), fooKey, bazKey, 500, 1, 1)
	// Fund the pool: approve it from alice and pull.
	approve(bazKey, alice, testingPoolAddr(), 100)
	testing.SetRealm(testing.NewUserRealm(alice))
	pool.MockFund(cross(cur), fooKey, bazKey, 500, bazKey, 100)

	a := offer(cur, bob, fooKey, 50, barKey, 10) // bob's FOO reaches carol, who wants BAZ
	b := offer(cur, carol, barKey, 10, bazKey, 40)
	page := Render("ring/" + u64(a) + "," + u64(b))
	uassert.True(t, strings.Contains(page, "func=SettleRingVia"), page)
	uassert.True(t, strings.Contains(page, "Settle through the 0.05% pool"), page)
	uassert.True(t, strings.Contains(page, `<gno-form exec="SettleRingVia">`), page)
	cancelAs(cur, bob, a)
	cancelAs(cur, carol, b)
}

// Found in the local-chain rehearsal: the home page offered a "Settle ring"
// button for a ring whose owner had revoked their token approval, so the
// settlement could only fail. Ring cards now leave out offers whose token is
// not held and approved (a read of the token ledger, no collection code).
func TestHomeHidesRingsWithUnapprovedTokens(cur realm, t *testing.T) {
	a := offer(cur, alice, fooKey, 3, barKey, 3)
	b := offer(cur, bob, barKey, 3, fooKey, 3)
	ids := u64(a) + "," + u64(b)
	uassert.True(t, strings.Contains(Render(""), "ring/"+ids), "ready ring shown")

	ao, _ := GetOffer(a)
	approve(fooKey, alice, SlotAddress(alice, ao.Nonce), 0)
	home := Render("")
	uassert.False(t, strings.Contains(home, "ring/"+ids), "ring with a revoked approval shown")
	uassert.True(t, strings.Contains(home, ":offer/"+u64(a)+")"), "the offer itself is still listed")
	uassert.False(t, strings.Contains(Render("offer/"+u64(b)), "ring/"+ids), "offer page shows the dead ring")

	cancelAs(cur, alice, a)
	cancelAs(cur, bob, b)
}

// Found in the local-chain rehearsal: a 7-day offer a few blocks old read
// "in about 6 days" because the time left was rounded down.
func TestExpiryRoundsToNearest(t *testing.T) {
	cases := map[int64]string{
		DefaultExpiryBlocks - 5:         "in about 7 days",
		DefaultExpiryBlocks + 5:         "in about 7 days",
		BlocksPerDay + 1:                "in about a day",
		BlocksPerDay/2 + 1:              "in about 12 hours",
		BlocksPerDay/24 - 10:            "in about an hour",
		10:                              "in less than an hour",
		MaxExpiryBlocks - 3:             "in about 30 days",
		BlocksPerDay*2 - BlocksPerDay/4: "in about 2 days",
	}
	for n, want := range cases {
		uassert.Equal(t, want, blocksAhead(n), u64(uint64(n)))
	}
}

// Found in the local-chain rehearsal: gnoweb's own command for a function
// sets no deposit limit, so the ring page prints one that does, with the
// fee at the base gas price (a flat 1 GNOT fee turns a settler's refund into
// a loss on small rings).
func TestRingPageCommandHasDepositLimit(cur realm, t *testing.T) {
	a := offer(cur, alice, fooKey, 4, barKey, 4)
	b := offer(cur, bob, barKey, 4, fooKey, 4)
	page := Render("ring/" + u64(a) + "," + u64(b))
	// Review 3: the gas limit is sized to the ring (two token offers: 35M)
	// and the fee is the minimum for that limit.
	uassert.True(t, strings.Contains(page, "-func SettleRing -args "+u64(a)+","+u64(b)+" \\\n  -gas-fee 35000ugnot -gas-wanted 35000000 -max-deposit 500000ugnot"), page)
	cancelAs(cur, alice, a)
	cancelAs(cur, bob, b)
}
