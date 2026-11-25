package kylix

import (
	"chain"
	"strings"
	"testing"

	"gno.land/p/nt/testutils/v0"
	"gno.land/p/nt/uassert/v0"
)

func TestNextSlotIsTheSubRealmAddress(cur realm, t *testing.T) {
	nonce, slot := NextSlot(alice)
	uassert.Equal(t, slot.String(), cur.Sub(slotPath(alice, nonce)).Address().String())
	uassert.Equal(t, slot.String(), chain.DerivePkgSubAddr(selfPath, "w/"+alice.String()+"/"+u64(nonce)).String())

	// Posting uses that nonce, and the next slot moves on.
	id := post(cur, alice, fooKey, 10, barKey, 10)
	o, _ := GetOffer(id)
	uassert.Equal(t, nonce, o.Nonce)
	next, slot2 := NextSlot(alice)
	uassert.Equal(t, nonce+1, next)
	uassert.NotEqual(t, slot.String(), slot2.String())

	// Another owner's nonce is independent.
	newNonce, _ := NextSlot(testutils.TestAddress("newcomer"))
	uassert.Equal(t, uint64(1), newNonce)
	testing.SetRealm(testing.NewUserRealm(alice))
	CancelIntent(cross(cur), id)
}

func TestTwoLegRing(cur realm, t *testing.T) {
	a := offer(cur, alice, fooKey, 100, barKey, 40)
	b := offer(cur, bob, barKey, 50, fooKey, 100)
	ao, _ := GetOffer(a)
	bo, _ := GetOffer(b)
	aSlot, bSlot := SlotAddress(alice, ao.Nonce), SlotAddress(bob, bo.Nonce)
	uassert.Equal(t, int64(100), grc20Allowance(fooKey, alice, aSlot))
	aFoo, aBar, bFoo, bBar := bal(fooKey, alice), bal(barKey, alice), bal(fooKey, bob), bal(barKey, bob)

	settleAs(cur, carol, u64(a)+","+u64(b))

	// Each leg gives its whole amount; the receiver keeps any surplus.
	uassert.Equal(t, aFoo-100, bal(fooKey, alice))
	uassert.Equal(t, aBar+50, bal(barKey, alice))
	uassert.Equal(t, bFoo+100, bal(fooKey, bob))
	uassert.Equal(t, bBar-50, bal(barKey, bob))
	uassert.False(t, isOpen(a))
	uassert.False(t, isOpen(b))
	uassert.False(t, locked)
	// Kylix and the slots hold nothing, and each slot's allowance is used up.
	for _, key := range []string{fooKey, barKey} {
		uassert.Equal(t, int64(0), bal(key, chain.PackageAddress(selfPath)))
		uassert.Equal(t, int64(0), bal(key, aSlot))
		uassert.Equal(t, int64(0), bal(key, bSlot))
	}
	uassert.Equal(t, int64(0), grc20Allowance(fooKey, alice, aSlot))
	uassert.Equal(t, int64(0), grc20Allowance(barKey, bob, bSlot))
}

// Threat: a slot approved for one offer cannot move any other offer's asset
// or any other owner's asset.
func TestSlotIsolation(cur realm, t *testing.T) {
	// alice approves her first slot, then posts a second offer whose own
	// slot she never approves.
	n1, slot1 := NextSlot(alice)
	approve(fooKey, alice, slot1, 100)
	first := postRaw(cur, alice, "fungible", fooKey, "", 100, "fungible", barKey, "", 10, 0)
	second := post(cur, alice, fooKey, 100, bazKey, 10)
	b := offer(cur, bob, bazKey, 10, fooKey, 100)

	// The ring uses alice's second offer: her first slot's allowance is not
	// usable for it.
	aborts(t, cur, "leg 0 (offer "+u64(second)+"): slot "+SlotAddress(alice, n1+1).String()+" may spend 0", func() {
		settleAs(cur, carol, u64(second)+","+u64(b))
	})
	uassert.True(t, isOpen(second))
	uassert.True(t, isOpen(b))

	// bob approves alice's first slot for his BAR (by mistake). An offer of
	// bob's still cannot use it: his own slot is not approved.
	approve(barKey, bob, slot1, 900)
	bo := post(cur, bob, barKey, 10, fooKey, 100)
	boOffer, _ := GetOffer(bo)
	aborts(t, cur, "leg 1 (offer "+u64(bo)+"): slot "+SlotAddress(bob, boOffer.Nonce).String()+" may spend 0", func() {
		settleAs(cur, carol, u64(first)+","+u64(bo))
	})
	uassert.Equal(t, int64(900), grc20Allowance(barKey, bob, slot1))

	for _, id := range []uint64{first, second} {
		testing.SetRealm(testing.NewUserRealm(alice))
		CancelIntent(cross(cur), id)
	}
	for _, id := range []uint64{b, bo} {
		testing.SetRealm(testing.NewUserRealm(bob))
		CancelIntent(cross(cur), id)
	}
	approve(fooKey, alice, slot1, 0)
	approve(barKey, bob, slot1, 0)
}

// Threat: an offer used twice, the same owner twice, a ring of one, a ring
// of seven.
func TestRingShape(cur realm, t *testing.T) {
	a := offer(cur, alice, fooKey, 10, barKey, 10)
	b := offer(cur, bob, barKey, 10, fooKey, 10)
	a2 := offer(cur, alice, barKey, 10, fooKey, 10)
	ids := []uint64{
		offer(cur, carol, fooKey, 1, bazKey, 1),
		offer(cur, dave, barKey, 1, fooKey, 1),
		offer(cur, erin, bazKey, 1, barKey, 1),
		offer(cur, frank, fooKey, 1, bazKey, 1),
		offer(cur, grace, barKey, 1, fooKey, 1),
		offer(cur, mal, bazKey, 1, barKey, 1),
	}

	cases := []struct{ ids, want string }{
		{u64(a) + "," + u64(a), "leg 1 (offer " + u64(a) + "): offer already used by leg 0"},
		{u64(a) + "," + u64(b) + "," + u64(a), "offer already used by leg 0"},
		{u64(a) + "," + u64(b) + "," + u64(a2), "leg 2 (offer " + u64(a2) + "): owner already trades in leg 0"},
		{u64(a), "a ring needs at least 2 legs, got 1"},
		{"1,2,3,4,5,6,7", "a ring has at most 6 legs, got 7"},
		{"", "no offer ids"},
		{u64(a) + ",x", "bad offer id"},
	}
	for _, c := range cases {
		aborts(t, cur, c.want, func() { settleAs(cur, carol, c.ids) })
	}
	// A seven-leg ring of otherwise valid offers is still refused.
	seven := u64(a) + "," + u64(b)
	for _, id := range ids {
		seven += "," + u64(id)
	}
	aborts(t, cur, "at most 6 legs, got 8", func() { settleAs(cur, carol, seven) })
	// The six of them make a valid ring.
	six := ""
	for i, id := range ids {
		if i > 0 {
			six += ","
		}
		six += u64(id)
	}
	settleAs(cur, carol, six)
	for _, id := range ids {
		uassert.False(t, isOpen(id))
	}
	uassert.True(t, isOpen(a))
	uassert.True(t, isOpen(b))

	settleAs(cur, carol, u64(a)+","+u64(b))
	testing.SetRealm(testing.NewUserRealm(alice))
	CancelIntent(cross(cur), a2)
}

// Threat: settling an offer that is cancelled, already settled or expired.
func TestSettleClosedOrExpired(cur realm, t *testing.T) {
	a := offer(cur, alice, fooKey, 10, barKey, 10)
	b := offer(cur, bob, barKey, 10, fooKey, 10)
	settleAs(cur, carol, u64(a)+","+u64(b))
	aborts(t, cur, "leg 0 (offer "+u64(a)+"): offer is not open", func() {
		settleAs(cur, carol, u64(a)+","+u64(b))
	})

	c := offer(cur, alice, fooKey, 10, barKey, 10)
	d := offer(cur, bob, barKey, 10, fooKey, 10)
	testing.SetRealm(testing.NewUserRealm(bob))
	CancelIntent(cross(cur), d)
	aborts(t, cur, "leg 1 (offer "+u64(d)+"): offer is not open", func() {
		settleAs(cur, carol, u64(c)+","+u64(d))
	})
	uassert.True(t, isOpen(c))

	// An offer valid up to and including its expiry height.
	h := chainHeight()
	_, slot := NextSlot(bob)
	approve(barKey, bob, slot, 10)
	testing.SetRealm(testing.NewUserRealm(bob))
	e := PostIntent(cross(cur), "fungible", barKey, "", 10, "fungible", fooKey, "", 10, h+1)
	testing.SkipHeights(2)
	aborts(t, cur, "leg 1 (offer "+u64(e)+"): offer expired at height "+i64(h+1), func() {
		settleAs(cur, carol, u64(c)+","+u64(e))
	})
	uassert.True(t, isOpen(c))

	testing.SetRealm(testing.NewUserRealm(alice))
	CancelIntent(cross(cur), c)
	testing.SetRealm(testing.NewUserRealm(bob))
	CancelIntent(cross(cur), e)
}

// Threat: an owner who revokes the approval or spends the asset after
// posting. The ring aborts before anything is written, the error names the
// leg, and the other offers stay open.
func TestRevokedOrSpent(cur realm, t *testing.T) {
	a := offer(cur, alice, fooKey, 100, bazKey, 5)
	b := offer(cur, bob, barKey, 10, fooKey, 100)
	c := offer(cur, carol, bazKey, 5, barKey, 10)
	ring := u64(a) + "," + u64(b) + "," + u64(c)

	// bob revokes his approval.
	bo, _ := GetOffer(b)
	approve(barKey, bob, SlotAddress(bob, bo.Nonce), 0)
	aborts(t, cur, "leg 1 (offer "+u64(b)+"): slot "+SlotAddress(bob, bo.Nonce).String()+" may spend 0 of "+barKey+"; approve exactly 10", func() {
		settleAs(cur, dave, ring)
	})
	for _, id := range []uint64{a, b, c} {
		uassert.True(t, isOpen(id), "offer "+u64(id)+" must stay open")
	}
	uassert.False(t, locked)

	// bob re-approves, then carol spends all her BAZ.
	approve(barKey, bob, SlotAddress(bob, bo.Nonce), 10)
	spent := bal(bazKey, carol)
	mustOK(ledgers[bazKey].Transfer(carol, mal, spent))
	aborts(t, cur, "leg 2 (offer "+u64(c)+"): owner holds 0 of "+bazKey+", offer gives 5", func() {
		settleAs(cur, dave, ring)
	})
	for _, id := range []uint64{a, b, c} {
		uassert.True(t, isOpen(id))
	}

	// Once carol has funds again the same ring settles.
	mustOK(ledgers[bazKey].Transfer(mal, carol, spent))
	settleAs(cur, dave, ring)
	for _, id := range []uint64{a, b, c} {
		uassert.False(t, isOpen(id))
	}
}

// Threat: native coins sent with SettleRing (or any other entry point).
func TestCoinsRejected(cur realm, t *testing.T) {
	a := offer(cur, alice, fooKey, 10, barKey, 10)
	b := offer(cur, bob, barKey, 10, fooKey, 10)
	coins := chain.NewCoins(chain.NewCoin("ugnot", 1))

	aborts(t, cur, "do not send coins", func() {
		testing.SetOriginSend(coins)
		settleAs(cur, carol, u64(a)+","+u64(b))
	})
	aborts(t, cur, "do not send coins", func() {
		testing.SetOriginSend(coins)
		post(cur, alice, fooKey, 1, barKey, 1)
	})
	aborts(t, cur, "do not send coins", func() {
		testing.SetOriginSend(coins)
		cancelAs(cur, alice, a)
	})
	// Finding 8 of security review 1: coins attached to a transaction that
	// reaches Kylix through a realm went to that realm, not to Kylix, so
	// they are not refused.
	testing.SetOriginSend(coins)
	viaRealm := postAsRealm(cur, "gno.land/r/test/payablewrapper", fooKey, 1, barKey, 1)
	testing.SetOriginSend(nil)
	uassert.True(t, isOpen(viaRealm))
	cancelAsRealm(cur, "gno.land/r/test/payablewrapper", viaRealm)
	uassert.True(t, isOpen(a))
	uassert.True(t, isOpen(b))
	settleAs(cur, carol, u64(a)+","+u64(b))
}

// The lock refuses every exported function except Render while a
// settlement is moving assets: state-changing ones as re-entry, reads
// because the book is already updated but the assets have not all moved
// (finding 7 of security review 1). The filetests drive this through a
// hostile collection; here it is checked directly for each function.
func TestLockRefusesReentry(cur realm, t *testing.T) {
	a := offer(cur, alice, fooKey, 10, barKey, 10)
	writes := map[string]func(){
		"SettleRing":    func() { settleAs(cur, carol, u64(a)+",1") },
		"SettleRingVia": func() { settleViaAs(cur, carol, u64(a)+",1", 3000) },
		"PostIntent":    func() { post(cur, alice, fooKey, 1, barKey, 1) },
		"CancelIntent":  func() { cancelAs(cur, alice, a) },
		"PruneIntent":   func() { PruneIntent(cross(cur), a) },
		"RegisterItem": func() {
			registerAs(cur, testing.NewCodeRealm("gno.land/r/test/lockcoll"), "x", fakeMove, fakeOwner)
		},
		"RegisterAdapter": func() {
			adapterAs(cur, testing.NewCodeRealm("gno.land/r/test/lockadapter"), someTarget, "x")
		},
		"RegisterApprovalCheck": func() {
			approvalCheckAs(cur, testing.NewCodeRealm(fakeColl), fakeApproved)
		},
		"EnableNotifications": func() { EnableNotifications(cross(cur)) },
	}
	for name, call := range writes {
		locked = true
		uassert.AbortsContains(t, cur, "re-entrant call during settlement", call, name)
	}
	reads := map[string]func(){
		"GetOffer":            func() { GetOffer(a) },
		"OpenOffers":          func() { OpenOffers() },
		"Deliverable":         func() { Deliverable(u64(a)) },
		"ExportGraphJSON":     func() { ExportGraphJSON() },
		"ExportGraphJSONPage": func() { ExportGraphJSONPage(0, 10) },
	}
	for name, call := range reads {
		locked = true
		uassert.PanicsContains(t, nil, "settlement in progress", call, name)
	}
	locked = true
	uassert.NotPanics(t, nil, func() { Render("") }, "Render stays readable")
	locked = false
	cancelAs(cur, alice, a)
}

// Finding 7 of security review 1, as a collection would see it: during a
// settlement's moves, a callback asking Kylix about the book is refused.
func TestReadsRefusedDuringSettle(cur realm, t *testing.T) {
	const peekColl = "gno.land/r/test/peekcoll"
	testing.SetRealm(testing.NewCodeRealm(peekColl))
	RegisterItem(cross(cur), "Peek", peekMove, peekOwner)

	peekHolder = alice
	testing.SetRealm(testing.NewUserRealm(alice))
	a := PostIntent(cross(cur), "item", peekColl, "p-1", 0, "fungible", fooKey, "", 10, 0)
	_, slot := NextSlot(bob)
	approve(fooKey, bob, slot, 10)
	b := postRaw(cur, bob, "fungible", fooKey, "", 10, "item", peekColl, "p-1", 0, 0)
	peekTarget = b

	settleAs(cur, carol, u64(a)+","+u64(b))
	uassert.Equal(t, bob.String(), peekHolder.String(), "the item moved")
	uassert.True(t, strings.Contains(peekSaw, "settlement in progress"), "GetOffer answered mid-settlement: "+peekSaw)
	uassert.False(t, isOpen(a))
	uassert.False(t, isOpen(b))
}

var (
	peekHolder address
	peekTarget uint64
	peekSaw    string
)

// peekMove asks Kylix about the other offer in its ring while the ring is
// settling. It is declared in this package, so the panic it provokes is an
// ordinary one it can recover; a foreign realm's call would abort the ring.
func peekMove(cur realm, from, to address, itemID string) error {
	func() {
		defer func() {
			if r := recover(); r != nil {
				peekSaw = r.(string)
			}
		}()
		GetOffer(peekTarget)
		peekSaw = "no panic"
	}()
	peekHolder = to
	return nil
}

func peekOwner(id ItemID) address { return peekHolder }

func grc20Allowance(key string, owner, spender address) int64 {
	return tokenOf(key).Allowance(owner, spender)
}
