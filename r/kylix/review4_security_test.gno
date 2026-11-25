package kylix

import (
	"chain/runtime"
	"strconv"
	"strings"
	"testing"

	"gno.land/p/nt/testutils/v0"
	"gno.land/p/nt/uassert/v0"
	"gno.land/p/nym-kylix000/ring/v0"
	"gno.land/r/sys/users"
)

// The demonstration tests of security review 4 (docs/research/
// security-review-4.md), inverted where they showed a hole; the review's
// checks that something held are kept.

// R4-1: posting runs a collection's code only for an official collection,
// under the lock (its locked reads panic, its unlocked reads see the book as
// before the post). A third-party collection's code does not run at all.
func TestReview4_PostIntentCallbacks(cur realm, t *testing.T) {
	var seenNextNonce uint64
	var cbMode string
	calls := 0
	owner := func(id ItemID) address {
		calls++
		switch cbMode {
		case "check_unlocked":
			seenNextNonce, _ = NextSlot(alice)
			_ = Render("")
		case "GetOffer":
			GetOffer(1)
		case "OpenOffers":
			OpenOffers()
		case "Deliverable":
			Deliverable("1")
		case "ExportGraphJSON":
			ExportGraphJSON()
		case "ExportGraphJSONPage":
			ExportGraphJSONPage(0, 10)
		case "ExportCollectionsJSON":
			ExportCollectionsJSON("", 10)
		}
		return alice
	}
	move := func(cur realm, from, to address, itemID string) error { return nil }
	const thirdParty = "gno.land/r/evil/r4postcb"
	const official = "gno.land/r/nym-kylix000/r4postcb"
	testing.SetRealm(testing.NewCodeRealm(thirdParty))
	RegisterItem(cross(cur), "R4 PostCB", move, owner)
	testing.SetRealm(testing.NewCodeRealm(official))
	RegisterItem(cross(cur), "R4 PostCB Official", move, owner)

	// Third party: no call, the offer is stored unchecked.
	cbMode = "GetOffer" // would panic if it ran
	testing.SetRealm(testing.NewUserRealm(alice))
	id := PostIntent(cross(cur), "item", thirdParty, "item-1", 0, "fungible", fooKey, "", 10, 0)
	uassert.Equal(t, 0, calls, "posting ran third-party collection code")
	cancelAs(cur, alice, id)

	// Official: runs, under the lock.
	nonceBefore, _ := NextSlot(alice)
	offersBefore := OpenOffers()
	cbMode = "check_unlocked"
	testing.SetRealm(testing.NewUserRealm(alice))
	id = PostIntent(cross(cur), "item", official, "item-1", 0, "fungible", fooKey, "", 10, 0)
	uassert.True(t, calls > 0)
	uassert.Equal(t, nonceBefore, seenNextNonce, "NextSlot saw mutated nonce during PostIntent")
	uassert.False(t, locked, "lock must be cleared after PostIntent")
	uassert.Equal(t, offersBefore+1, OpenOffers())
	cancelAs(cur, alice, id)
	for _, m := range []string{"GetOffer", "OpenOffers", "Deliverable", "ExportGraphJSON", "ExportGraphJSONPage", "ExportCollectionsJSON"} {
		cbMode = m
		testing.SetRealm(testing.NewUserRealm(alice))
		uassert.AbortsContains(t, cur, "settlement in progress", func() {
			PostIntent(cross(cur), "item", official, "item-2", 0, "fungible", fooKey, "", 10, 0)
		}, m)
		locked = false // revive does not roll back package state in tests
	}
	uassert.Equal(t, offersBefore, OpenOffers())
}

// Kept from the review: a session key posts once the approval exists, and
// still cannot cancel.
func TestReview4_PostIntentViaSessionKey(cur realm, t *testing.T) {
	orig := sessionCheck
	sessionCheck = func() bool { return true }
	defer func() { sessionCheck = orig }()

	_, slot := NextSlot(alice)
	approve(fooKey, alice, slot, 50)
	testing.SetRealm(testing.NewUserRealm(alice))
	id := PostIntent(cross(cur), "fungible", fooKey, "", 50, "fungible", barKey, "", 50, 0)
	o, ok := GetOffer(id)
	uassert.True(t, ok)
	uassert.True(t, o.ViaSession)
	aborts(t, cur, "session key cannot cancel", func() {
		cancelAs(cur, alice, id)
	})
	sessionCheck = orig
	cancelAs(cur, alice, id)
	approve(fooKey, alice, slot, 0)
}

// R4-3: 24 live offers from 6 accounts that almost match used to use up the
// home search's step budget. Only rings that close count as steps now.
func TestReview4_HomeStepExhaustionResisted(cur realm, t *testing.T) {
	h1 := offer(cur, alice, fooKey, 10, bazKey, 10)
	h2 := offer(cur, bob, barKey, 10, fooKey, 10)
	h3 := offer(cur, carol, bazKey, 10, barKey, 10)
	honestURL := "ring/" + u64(h1) + "," + u64(h2) + "," + u64(h3)
	uassert.True(t, strings.Contains(Render(""), honestURL), "honest ring visible before attack")

	var sybils [6]address
	for i := range sybils {
		sybils[i] = testutils.TestAddress("r4-step-sybil-" + strconv.Itoa(i))
		for _, led := range ledgers {
			mustOK(led.Mint(sybils[i], 1000))
		}
	}
	var spam []uint64
	spam = append(spam, offer(cur, sybils[5], bazKey, 100, fooKey, 999999))
	for i := 0; i < 4; i++ {
		spam = append(spam, offer(cur, sybils[i], barKey, 1, fooKey, 1))
		spam = append(spam, offer(cur, sybils[i], barKey, 1, fooKey, 1))
		spam = append(spam, offer(cur, sybils[i], bazKey, 1, barKey, 1))
		spam = append(spam, offer(cur, sybils[i], bazKey, 1, barKey, 1))
	}
	for i := 0; i < 4; i++ {
		spam = append(spam, offer(cur, sybils[4], fooKey, 1, bazKey, 100))
	}
	for i := 0; i < 3; i++ {
		spam = append(spam, offer(cur, sybils[5], fooKey, 1, bazKey, 100))
	}
	uassert.Equal(t, 24, len(spam))
	uassert.True(t, strings.Contains(Render(""), honestURL), "honest ring hidden by 24 offers that almost match")

	for _, id := range spam {
		o, _ := GetOffer(id)
		cancelAs(cur, o.Owner, id)
	}
	cancelAs(cur, alice, h1)
	cancelAs(cur, bob, h2)
	cancelAs(cur, carol, h3)
}

// The cheapest attack left on the home page (re-measured for DESIGN.md):
// fill the search window with live offers that form no ring, 4 per account
// (the most one account keeps). The window keeps 50 offers, newest first, so
// a 3-offer ring disappears once 48 newer offers are kept: 12 accounts.
func TestReview4_CheapestHomeAttack(cur realm, t *testing.T) {
	h1 := offer(cur, alice, fooKey, 10, bazKey, 10)
	h2 := offer(cur, bob, barKey, 10, fooKey, 10)
	h3 := offer(cur, carol, bazKey, 10, barKey, 10)
	honestURL := "ring/" + u64(h1) + "," + u64(h2) + "," + u64(h3)
	open := OpenOffers() - 3 // offers other tests left open, older than h1
	var spam []uint64
	accounts := 0
	for ; accounts < 13 && strings.Contains(Render(""), honestURL); accounts++ {
		s := testutils.TestAddress("r4-fill-" + strconv.Itoa(accounts))
		for _, led := range ledgers {
			mustOK(led.Mint(s, 100))
		}
		for i := 0; i < matchPerOwnerWindow; i++ {
			spam = append(spam, offer(cur, s, fooKey, 1, barKey, 999999)) // live, closes nothing
		}
	}
	uassert.Equal(t, 0, open, "the book should hold only this test's offers")
	uassert.Equal(t, 12, accounts, "accounts needed to hide the ring")
	uassert.Equal(t, 48, len(spam))

	for _, id := range spam {
		o, _ := GetOffer(id)
		cancelAs(cur, o.Owner, id)
	}
	cancelAs(cur, alice, h1)
	cancelAs(cur, bob, h2)
	cancelAs(cur, carol, h3)
}

// R4-5: a registered name that only looks like an address is never
// shortened like one, and a 64-character namespace is never clipped.
func TestReview4_SVGHintAddressCheck(cur realm, t *testing.T) {
	const realSinopia = "g1jz6j9hj6rdf5ltl2kcrpa4jwtdh3w30z0yul06/sinopia3/core"
	const fakeUnderscore = "g1jz6j9h_evil_x0yul06"
	const fakeLong41 = "g1jz6j9hxxxxxxxxxxxxxxxxxxxxxxxxxxx0yul06"

	origH := runtime.ChainHeight()
	testing.SetHeight(0)
	u1 := testutils.TestAddress("r4-spoof-u1")
	u2 := testutils.TestAddress("r4-spoof-u2")
	testing.SetRealm(testing.NewUserRealm(u1))
	uassert.NoError(t, users.RegisterUser(cross(cur), fakeUnderscore, u1))
	testing.SetRealm(testing.NewUserRealm(u2))
	uassert.NoError(t, users.RegisterUser(cross(cur), fakeLong41, u2))
	testing.SetHeight(origH)

	real := svgHint(realSinopia)
	uassert.Equal(t, "g1jz6j9h…0yul06/sinopia3/core", real)
	uassert.Equal(t, fakeUnderscore+"/sinopia3/core", svgHint(fakeUnderscore+"/sinopia3/core"))
	uassert.Equal(t, fakeLong41+"/sinopia3/core", svgHint(fakeLong41+"/sinopia3/core"))

	nsA := strings.Repeat("a", 60) + "real"
	nsB := strings.Repeat("a", 60) + "evil"
	svg := func(ns string) string {
		return ring.GraphSVG([]ring.GraphHop{
			{From: "@a", Give: "10 T", Note: svgHint(ns + "/a-long-realm-name")},
			{From: "@b", Give: "10 U", Note: svgHint("gnoland/wugnot")},
		}, ring.GraphFull)
	}
	uassert.NotEqual(t, svg(nsA), svg(nsB), "two 64-character namespaces drawn alike")
	uassert.True(t, strings.Contains(svg(nsA), nsA+"/…"), "namespace clipped")
}
