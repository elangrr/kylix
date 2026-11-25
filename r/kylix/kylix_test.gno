package kylix

import (
	"chain"
	"chain/runtime"
	"strings"
	"testing"

	"gno.land/p/nt/uassert/v0"
	"gno.land/p/nym-kylix000/ring/v0"
)

func chainHeight() int64 { return runtime.ChainHeight() }

// fakeOwners backs the in-package test collection registered below.
var fakeOwners = map[string]address{}

func fakeMove(cur realm, from, to address, itemID string) error {
	fakeOwners[itemID] = to
	return nil
}

func fakeOwner(id ItemID) address { return fakeOwners[string(id)] }

// The trap collection panics in every function and counts the calls, to
// show where Kylix runs collection code and where it must not.
const trapColl = "gno.land/r/test/trap"

// Posting runs the collection's owner and approval functions (the poster's
// choice and cost), so the trap is armed only after the offer is posted.
var (
	trapCalls int
	trapArmed bool
)

func trapMove(cur realm, from, to address, itemID string) error {
	trapCalls++
	panic("trap: move called")
}

func trapOwner(id ItemID) address {
	if !trapArmed {
		return alice
	}
	trapCalls++
	panic("trap: owner called")
}

func trapApproved(id ItemID, spender address) bool {
	if !trapArmed {
		return true
	}
	trapCalls++
	panic("trap: approved called")
}

const fakeColl = "gno.land/r/test/fakecoll"

func TestPostIntentValidation(cur realm, t *testing.T) {
	testing.SetRealm(testing.NewCodeRealm(fakeColl))
	RegisterItem(cross(cur), "Fake", fakeMove, fakeOwner)

	h := chainHeight()
	type args struct {
		gk, gkey, gid string
		ga            int64
		wk, wkey, wid string
		wm, exp       int64
	}
	cases := []struct {
		name string
		a    args
		want string
	}{
		{"bad give kind", args{"token", fooKey, "", 1, "fungible", barKey, "", 1, 0}, "give kind must be"},
		{"bad want kind", args{"fungible", fooKey, "", 1, "Item", fakeColl, "x", 0, 0}, "want kind must be"},
		{"unregistered token", args{"fungible", "gno.land/r/nobody.NOPE", "", 1, "fungible", barKey, "", 1, 0}, "give: token is not in grc20reg"},
		{"zero amount", args{"fungible", fooKey, "", 0, "fungible", barKey, "", 1, 0}, "give: fungible amount must be positive"},
		{"negative min", args{"fungible", fooKey, "", 5, "fungible", barKey, "", -1, 0}, "want: fungible amount must be positive"},
		{"token with id", args{"fungible", fooKey, "x", 5, "fungible", barKey, "", 1, 0}, "give: fungible asset with an item id"},
		{"unregistered collection", args{"item", "gno.land/r/nobody", "x", 0, "fungible", barKey, "", 1, 0}, "give: collection is not registered"},
		{"item without id", args{"item", fakeColl, "", 0, "fungible", barKey, "", 1, 0}, "give: item without an id"},
		{"item with amount", args{"fungible", fooKey, "", 5, "item", fakeColl, "x", 3, 0}, "want: item with an amount"},
		{"item id with markup", args{"item", fakeColl, "<b>x</b>", 0, "fungible", barKey, "", 1, 0}, "item id must be"},
		{"item id with separator", args{"item", fakeColl, "a|b", 0, "fungible", barKey, "", 1, 0}, "item id must be"},
		{"item id too long", args{"item", fakeColl, strings.Repeat("x", 65), 0, "fungible", barKey, "", 1, 0}, "item id must be"},
		{"gives what it wants", args{"fungible", fooKey, "", 5, "fungible", fooKey, "", 1, 0}, "cannot give the asset it wants"},
		{"same item both sides", args{"item", fakeColl, "x", 0, "item", fakeColl, "x", 0, 0}, "cannot give the asset it wants"},
		{"past expiry", args{"fungible", fooKey, "", 5, "fungible", barKey, "", 1, h}, "expiry must be a future block height, or 0 for the default of 7 days"},
		{"negative expiry", args{"fungible", fooKey, "", 5, "fungible", barKey, "", 1, -1}, "expiry must be a future block height"},
		{"expiry too far", args{"fungible", fooKey, "", 5, "fungible", barKey, "", 1, h + MaxExpiryBlocks + 1}, "expiry may be at most 30 days ahead"},
	}
	before := OpenOffers()
	for _, c := range cases {
		a := c.a
		aborts(t, cur, c.want, func() {
			postRaw(cur, alice, a.gk, a.gkey, a.gid, a.ga, a.wk, a.wkey, a.wid, a.wm, a.exp)
		})
	}
	uassert.Equal(t, before, OpenOffers())

	// Valid: an item for a token, with a future expiry.
	fakeOwners["C1/relic:7-b_c.d"] = alice // posting checks the owner
	testing.SetRealm(testing.NewUserRealm(alice))
	id := PostIntent(cross(cur), "item", fakeColl, "C1/relic:7-b_c.d", 0, "fungible", barKey, "", 3, h+10)
	o, ok := GetOffer(id)
	uassert.True(t, ok)
	uassert.Equal(t, alice.String(), o.Owner.String())
	uassert.Equal(t, int(ring.Item), int(o.Give.Kind))
	uassert.Equal(t, "C1/relic:7-b_c.d", o.Give.ID)
	uassert.Equal(t, int64(3), o.Want.Amount)
	uassert.Equal(t, h+10, o.Expiry)
	uassert.False(t, o.ViaSession)
	CancelIntent(cross(cur), id)
}

func TestCancelOnlyByOwner(cur realm, t *testing.T) {
	a := post(cur, alice, fooKey, 10, barKey, 10)
	aborts(t, cur, "only the owner can cancel", func() { cancelAs(cur, mal, a) })
	aborts(t, cur, "only the owner can cancel", func() { cancelAsRealm(cur, "gno.land/r/test/other", a) })
	uassert.True(t, isOpen(a))
	testing.SetRealm(testing.NewUserRealm(alice))
	CancelIntent(cross(cur), a)
	uassert.False(t, isOpen(a))
	aborts(t, cur, "is not open", func() { cancelAs(cur, alice, a) })
}

// Threat: a session key calling CancelIntent. Session keys may post and
// settle. `gno test` cannot sign with a session key, so the check is
// swapped for the duration of the test.
func TestSessionKeyCannotCancel(cur realm, t *testing.T) {
	real := sessionCheck
	sessionCheck = func() bool { return true }

	a := offer(cur, alice, fooKey, 10, barKey, 10)
	o, _ := GetOffer(a)
	uassert.True(t, o.ViaSession, "a session-posted offer is marked")
	aborts(t, cur, "a session key cannot cancel", func() { cancelAs(cur, alice, a) })
	uassert.True(t, isOpen(a))

	// A session key may still settle.
	b := offer(cur, bob, barKey, 10, fooKey, 10)
	settleAs(cur, carol, u64(a)+","+u64(b))
	uassert.False(t, isOpen(a))

	// With the account key, cancelling works.
	c := offer(cur, alice, fooKey, 10, barKey, 10)
	sessionCheck = real
	testing.SetRealm(testing.NewUserRealm(alice))
	CancelIntent(cross(cur), c)
	uassert.False(t, isOpen(c))
}

func TestRegisterItem(cur realm, t *testing.T) {
	c1 := testing.NewCodeRealm("gno.land/r/test/c1")
	cases := []struct {
		name   string
		caller runtime.Realm
		coll   string
		move   MoveFn
		owner  OwnerFn
		want   string
	}{
		{"user", testing.NewUserRealm(alice), "Mine", fakeMove, fakeOwner, "only a realm can register"},
		{"ephemeral", runtime.NewRealm(alice, "gno.land/e/"+alice.String()+"/run"), "Run", fakeMove, fakeOwner, "a MsgRun package cannot register"},
		{"nil move", c1, "C1", nil, fakeOwner, "move and ownerOf are both required"},
		{"nil owner", c1, "C1", fakeMove, nil, "move and ownerOf are both required"},
		{"empty name", c1, "", fakeMove, fakeOwner, "collection name must be"},
		{"control char", c1, "a\nb", fakeMove, fakeOwner, "collection name must be"},
		{"bidi override", c1, "abc\u202edef", fakeMove, fakeOwner, "collection name must be"},
		{"too long", c1, strings.Repeat("n", 65), fakeMove, fakeOwner, "collection name must be"},
		{"twice", testing.NewCodeRealm(fakeColl), "Again", fakeMove, fakeOwner, "already registered"},
		{"sub-identity", runtime.NewRealm(chain.DerivePkgSubAddr("gno.land/r/test/c1", "x"), "gno.land/r/test/c1#x"),
			"Sub", fakeMove, fakeOwner, "not from a sub-identity"},
	}
	for _, c := range cases {
		c := c
		aborts(t, cur, c.want, func() { registerAs(cur, c.caller, c.coll, c.move, c.owner) })
	}
	uassert.False(t, IsCollection("gno.land/r/test/c1"))

	testing.SetRealm(testing.NewCodeRealm("gno.land/r/test/c1"))
	RegisterItem(cross(cur), "Cups & *Bowls*", fakeMove, fakeOwner)
	uassert.True(t, IsCollection("gno.land/r/test/c1"))
	uassert.Equal(t, "Cups & *Bowls*", CollectionName("gno.land/r/test/c1"))
}

// Every offer expires: expiry 0 means the default, the maximum is enforced,
// and the offer settles up to and including its expiry height.
func TestExpiryDefaults(cur realm, t *testing.T) {
	h := chainHeight()
	d := post(cur, alice, fooKey, 1, barKey, 1)
	o, _ := GetOffer(d)
	uassert.Equal(t, h+DefaultExpiryBlocks, o.Expiry)
	m := postRaw(cur, alice, "fungible", fooKey, "", 1, "fungible", barKey, "", 1, h+MaxExpiryBlocks)
	o, _ = GetOffer(m)
	uassert.Equal(t, h+MaxExpiryBlocks, o.Expiry)
	uassert.Equal(t, int64(7*17280), int64(DefaultExpiryBlocks))
	uassert.Equal(t, int64(30*17280), int64(MaxExpiryBlocks))
	for _, id := range []uint64{d, m} {
		cancelAs(cur, alice, id)
	}
}

// Threats (findings 2, 4a, 9 of security review 1): PruneIntent works only
// on expired offers, and calls no collection code, so pruning is safe for
// the caller and no collection can make an expired offer unprunable.
func TestPruneOnlyExpiredAndCallsNoCollectionCode(cur realm, t *testing.T) {
	// A collection whose functions panic and count their calls.
	testing.SetRealm(testing.NewCodeRealm(trapColl))
	RegisterItem(cross(cur), "Trap", trapMove, trapOwner)
	RegisterApprovalCheck(cross(cur), trapApproved)

	h := chainHeight()
	testing.SetRealm(testing.NewUserRealm(alice))
	trap := PostIntent(cross(cur), "item", trapColl, "t-1", 0, "fungible", fooKey, "", 1, h+10)
	trapArmed, trapCalls = true, 0
	tok := offer(cur, bob, fooKey, 100, barKey, 10)
	tokOffer, _ := GetOffer(tok)
	approve(fooKey, bob, SlotAddress(bob, tokOffer.Nonce), 0) // undeliverable: not prunable for that

	testing.SetRealm(testing.NewUserRealm(mal))
	aborts(t, cur, "has not expired; it can be pruned after height "+i64(h+10), func() { PruneIntent(cross(cur), trap) })
	aborts(t, cur, "has not expired", func() { PruneIntent(cross(cur), tok) })

	testing.SkipHeights(10) // height h+10: still settleable, still not prunable
	aborts(t, cur, "has not expired", func() { PruneIntent(cross(cur), trap) })
	testing.SkipHeights(1)
	testing.SetRealm(testing.NewUserRealm(mal))
	PruneIntent(cross(cur), trap)
	uassert.False(t, isOpen(trap))
	uassert.Equal(t, 0, trapCalls, "pruning called collection code")
	cancelAs(cur, bob, tok)
}

func TestStoreRoundTrip(t *testing.T) {
	cases := []Offer{
		{ID: 1, Owner: alice, Nonce: 1, Give: ring.Asset{Kind: ring.Fungible, Key: fooKey, Amount: 1}, Want: ring.Asset{Kind: ring.Item, Key: fakeColl, ID: "a.b:c-d_e"}},
		{ID: 18446744073709551615, Owner: bob, Nonce: 99, Give: ring.Asset{Kind: ring.Item, Key: fakeColl, ID: "x"}, Want: ring.Asset{Kind: ring.Fungible, Key: barKey, Amount: 9223372036854775807}, Expiry: 1 << 40, ViaSession: true},
	}
	for _, o := range cases {
		got := decodeOffer(o.ID, encodeOffer(&o))
		uassert.True(t, *got == o, "round trip changed offer "+u64(o.ID))
	}
	// Keys sort numerically.
	prev := ""
	for _, id := range []uint64{1, 9, 10, 99, 100, 12345, 18446744073709551615} {
		k := offerKey(id)
		uassert.True(t, k > prev, k+" sorts after "+prev)
		uassert.Equal(t, id, parseOfferKey(k))
		prev = k
	}
	uassert.PanicsContains(t, nil, "separator", func() {
		encodeOffer(&Offer{Owner: alice, Give: ring.Asset{Key: "a|b"}})
	})
}
