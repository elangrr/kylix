package kylix

// In-package tests: they can reach unexported state (the re-entrancy lock,
// the session check) and use test tokens created by this realm. They must
// not import realms that import kylix (kylixdemo, mocks): `gno test` would
// then load a second copy of kylix for those realms. Item rings and hostile
// collections are covered by the filetests in ./filetests instead.

import (
	"chain"
	"chain/runtime"
	"testing"

	"gno.land/p/nt/grc20/v0"
	"gno.land/p/nt/seqid/v0"
	"gno.land/p/nt/testutils/v0"
	"gno.land/p/nt/uassert/v0"
	"gno.land/r/nt/grc20reg/v0"
)

var (
	alice = testutils.TestAddress("alice")
	bob   = testutils.TestAddress("bob")
	carol = testutils.TestAddress("carol")
	dave  = testutils.TestAddress("dave")
	erin  = testutils.TestAddress("erin")
	frank = testutils.TestAddress("frank")
	grace = testutils.TestAddress("grace")
	mal   = testutils.TestAddress("mallory")

	fooKey, barKey, bazKey string
	ledgers                = map[string]*grc20.PrivateLedger{}
)

func init(cur realm) {
	for i, sym := range []string{"FOO", "BAR", "BAZ"} {
		tok, led := grc20.NewToken("Test "+sym, sym, 0, seqid.ID(100+i), cur)
		key := grc20reg.Register(cross(cur), tok, "")
		ledgers[key] = led
		switch sym {
		case "FOO":
			fooKey = key
		case "BAR":
			barKey = key
		case "BAZ":
			bazKey = key
		}
	}
	for _, who := range []address{alice, bob, carol, dave, erin, frank, grace, mal} {
		for _, led := range ledgers {
			mustOK(led.Mint(who, 1_000))
		}
	}
}

func mustOK(err error) {
	if err != nil {
		panic(err)
	}
}

func bal(key string, who address) int64 { return grc20reg.MustGet(key).BalanceOf(who) }

// approve sets owner's allowance for spender directly on the test ledger.
func approve(key string, owner, spender address, amount int64) {
	mustOK(ledgers[key].Approve(owner, spender, amount))
}

// post posts a token-for-token offer that is not approved afterwards: an
// offer gone dead after posting. Posting itself needs the exact approval,
// so post approves, posts, and revokes the approval again.
func post(cur realm, owner address, give string, amount int64, want string, min int64) uint64 {
	_, slot := NextSlot(owner)
	approve(give, owner, slot, amount)
	testing.SetRealm(testing.NewUserRealm(owner))
	id := PostIntent(cross(cur), "fungible", give, "", amount, "fungible", want, "", min, 0)
	approve(give, owner, slot, 0)
	return id
}

// offer approves exactly its slot and posts a token-for-token offer.
func offer(cur realm, owner address, give string, amount int64, want string, min int64) uint64 {
	_, slot := NextSlot(owner)
	approve(give, owner, slot, amount)
	testing.SetRealm(testing.NewUserRealm(owner))
	return PostIntent(cross(cur), "fungible", give, "", amount, "fungible", want, "", min, 0)
}

// Helpers that switch the caller take cur and call SetRealm themselves.
// Calling testing.SetRealm directly inside a closure passed to `aborts` does
// not change the caller the closure's crossing call sees.

func cancelAs(cur realm, who address, id uint64) {
	testing.SetRealm(testing.NewUserRealm(who))
	CancelIntent(cross(cur), id)
}

func cancelAsRealm(cur realm, pkgPath string, id uint64) {
	testing.SetRealm(testing.NewCodeRealm(pkgPath))
	CancelIntent(cross(cur), id)
}

func registerAs(cur realm, rlm runtime.Realm, name string, move MoveFn, owner OwnerFn) {
	testing.SetRealm(rlm)
	RegisterItem(cross(cur), name, move, owner)
}

// postRaw posts any offer and leaves the approval as the caller set it up:
// a token offer whose slot the caller did not approve exactly is approved
// for the post and revoked again (an offer gone dead after posting). An item
// offer needs its owner (and approval, if the collection checks one) set up
// by the caller, as PostIntent checks them.
func postRaw(cur realm, who address, gk, gkey, gid string, ga int64, wk, wkey, wid string, wm, exp int64) uint64 {
	revoke := false
	_, slot := NextSlot(who)
	if gk == "fungible" && ledgers[gkey] != nil && grc20reg.MustGet(gkey).Allowance(who, slot) != ga {
		approve(gkey, who, slot, ga)
		revoke = true
	}
	testing.SetRealm(testing.NewUserRealm(who))
	id := PostIntent(cross(cur), gk, gkey, gid, ga, wk, wkey, wid, wm, exp)
	if revoke {
		approve(gkey, who, slot, 0)
	}
	return id
}

func settleAs(cur realm, who address, ids string) {
	testing.SetRealm(testing.NewUserRealm(who))
	SettleRing(cross(cur), ids)
}

func isOpen(id uint64) bool {
	_, ok := GetOffer(id)
	return ok
}

// aborts asserts that fn aborts the transaction with a message containing
// substr, before SettleRing took its lock: every abort these in-package
// tests provoke happens in a check that runs before anything is written.
// `revive` does not roll state back in tests, so a lock left set would mean
// an abort after the lock, which only the filetests may provoke.
func aborts(t *testing.T, rlm realm, substr string, fn func()) {
	t.Helper()
	uassert.AbortsContains(t, rlm, substr, fn)
	uassert.False(t, locked, "aborted after taking the lock: "+substr)
	locked = false
	testing.SetOriginSend(nil)
}

func settleViaAs(cur realm, who address, ids string, fee uint32) {
	testing.SetRealm(testing.NewUserRealm(who))
	SettleRingVia(cross(cur), ids, fee)
}

// postAsRealm posts a token offer as a realm, funding and approving it for
// the post and revoking the approval afterwards.
func postAsRealm(cur realm, pkgPath string, give string, amount int64, want string, min int64) uint64 {
	addr := chain.PackageAddress(pkgPath)
	if bal(give, addr) < amount {
		mustOK(ledgers[give].Mint(addr, amount))
	}
	_, slot := NextSlot(addr)
	approve(give, addr, slot, amount)
	testing.SetRealm(testing.NewCodeRealm(pkgPath))
	id := PostIntent(cross(cur), "fungible", give, "", amount, "fungible", want, "", min, 0)
	approve(give, addr, slot, 0)
	return id
}
