// PKGPATH: gno.land/r/nym-kylix000/kylix/filetests/z_post_needs_approval
package z_post_needs_approval

// The posting rule: an offer must be deliverable when it is posted. Approve first, then post; unfunded, unapproved, over-approved and unowned offers are refused, and nothing is stored.

import (
	"chain"
	"chain/runtime"
	"strconv"
	"testing"

	"gno.land/p/nt/testutils/v0"
	"gno.land/r/gnoswap/pool"
	"gno.land/r/gnoswap/router"
	"gno.land/r/nym-kylix000/kylix"
	"gno.land/r/nym-kylix000/kylixdemo"
	"gno.land/r/nym-kylix000/mocks/hostile"
	"gno.land/r/nym-kylix000/mocks/legacy721"
	"gno.land/r/nym-kylix000/mocks/legacyadapter"
	"gno.land/r/nym-kylix000/mocks/storagebomb"
)

const legacyKey = "gno.land/r/nym-kylix000/mocks/legacyadapter"

var (
	u1 = testutils.TestAddress("u1")
	u2 = testutils.TestAddress("u2")
	u3 = testutils.TestAddress("u3")
	u4 = testutils.TestAddress("u4")
	u5 = testutils.TestAddress("u5")
	u6 = testutils.TestAddress("u6")
	settler = testutils.TestAddress("settler")
	ids  string
)

type want struct {
	kind, key, id string
	min           int64
}

func tok(sym string, min int64) want { return want{"fungible", kylixdemo.TokenKey(sym), "", min} }
func relic(id string) want          { return want{"item", kylixdemo.CollectionKey(), id, 0} }
func hostileItem(id string) want    { return want{"item", "gno.land/r/nym-kylix000/mocks/hostile", id, 0} }

// claim gives who 1000 OBOL, 1000 DRACHMA and the next relic.
func claim(cur realm, who address) string {
	testing.SetRealm(testing.NewUserRealm(who))
	return kylixdemo.Claim(cross(cur))
}

// giveTok approves who's next slot for amount and posts the offer.
func giveTok(cur realm, who address, sym string, amount int64, w want) uint64 {
	_, slot := kylix.NextSlot(who)
	testing.SetRealm(testing.NewUserRealm(who))
	kylixdemo.Approve(cross(cur), sym, slot, amount)
	return kylix.PostIntent(cross(cur), "fungible", kylixdemo.TokenKey(sym), "", amount, w.kind, w.key, w.id, w.min, 0)
}

func giveRelic(cur realm, who address, id string, w want) uint64 {
	_, slot := kylix.NextSlot(who)
	testing.SetRealm(testing.NewUserRealm(who))
	kylixdemo.ApproveRelic(cross(cur), slot, id)
	return kylix.PostIntent(cross(cur), "item", kylixdemo.CollectionKey(), id, 0, w.kind, w.key, w.id, w.min, 0)
}

// giveHostile mints a hostile-collection item to who and offers it.
func giveHostile(cur realm, who address, id string, w want) uint64 {
	hostile.Mint(cross(cur), who, id)
	_, slot := kylix.NextSlot(who)
	testing.SetRealm(testing.NewUserRealm(who))
	hostile.Approve(cross(cur), slot, id)
	return kylix.PostIntent(cross(cur), "item", "gno.land/r/nym-kylix000/mocks/hostile", id, 0, w.kind, w.key, w.id, w.min, 0)
}

// giveLegacy mints a legacy721 item to who, approves exactly the address
// kylix.ApproveTarget names for who's next offer, and offers the item
// through the adapter.
func giveLegacy(cur realm, who address, id string, w want) uint64 {
	legacy721.Mint(cross(cur), who, id)
	nonce, _ := kylix.NextSlot(who)
	testing.SetRealm(testing.NewUserRealm(who))
	legacy721.Approve(cross(cur), kylix.ApproveTarget(who, nonce, legacyKey), id)
	return kylix.PostIntent(cross(cur), "item", legacyKey, id, 0, w.kind, w.key, w.id, w.min, 0)
}

// legacyMove is the test adapter's MoveFn, for the direct-call threats.
func legacyMove() kylix.MoveFn { return legacyadapter.Move }

// legacySpender is the address the test adapter says to approve for slot.
func legacySpender(slot address) address { return legacyadapter.SpenderFor(slot) }

// openPool creates a stand-in GnoSwap pool OBOL/DRACHMA with this fee tier,
// where one OBOL buys num/den DRACHMA, and has who fund it with amount
// DRACHMA (0: leave it empty).
func openPool(cur realm, who address, fee uint32, num, den, amount int64) {
	obol, drachma := kylixdemo.TokenKey("OBOL"), kylixdemo.TokenKey("DRACHMA")
	pool.MockCreatePool(cross(cur), obol, drachma, fee, num, den)
	if amount == 0 {
		return
	}
	testing.SetRealm(testing.NewUserRealm(who))
	kylixdemo.Approve(cross(cur), "DRACHMA", chain.PackageAddress("gno.land/r/gnoswap/pool"), amount)
	pool.MockFund(cross(cur), obol, drachma, fee, drachma, amount)
}

// routerFault switches the stand-in router: halted, reporting less input
// used than asked (shortfall), or pulling less than it reports (underpull).
func routerFault(cur realm, halted bool, shortfall, underpull int64) {
	router.MockSetHalted(cross(cur), halted)
	router.MockSetInputShortfall(cross(cur), shortfall)
	router.MockSetUnderpull(cross(cur), underpull)
}

// settleVia settles the ring through the pool with this fee tier.
func settleVia(cur realm, fee uint32) {
	testing.SetRealm(testing.NewUserRealm(settler))
	kylix.SettleRingVia(cross(cur), ids, fee)
}

// bombBytes is how much the storage-bomb collection has stored.
func bombBytes() int { return storagebomb.BloatBytes() }

// height is the current block height.
func height() int64 { return runtime.ChainHeight() }

func join(xs ...uint64) string {
	s := ""
	for i, x := range xs {
		if i > 0 {
			s += ","
		}
		s += strconv.FormatUint(x, 10)
	}
	return s
}

func settle(cur realm) {
	testing.SetRealm(testing.NewUserRealm(settler))
	kylix.SettleRing(cross(cur), ids)
}

func init(cur realm) {
	claim(cur, u1) // relic-1
}

func main(cur realm) {
	obol, drachma := kylixdemo.TokenKey("OBOL"), kylixdemo.TokenKey("DRACHMA")
	try := func(f func()) {
		r := revive(f)
		println(r)
	}
	_, slot := kylix.NextSlot(u1)
	post := func(kind, key, id string, amount int64) {
		kylix.PostIntent(cross(cur), kind, key, id, amount, "fungible", drachma, "", 10, 0)
	}
	// testing.SetRealm inside a closure does not reach its crossing call, so
	// the caller is set before each try.
	testing.SetRealm(testing.NewUserRealm(u1))
	try(func() { post("fungible", obol, "", 10) }) // not approved
	testing.SetRealm(testing.NewUserRealm(u1))
	kylixdemo.Approve(cross(cur), "OBOL", slot, 11)
	testing.SetRealm(testing.NewUserRealm(u1))
	try(func() { post("fungible", obol, "", 10) }) // approved for more than the amount
	testing.SetRealm(testing.NewUserRealm(u1))
	try(func() { post("item", kylixdemo.CollectionKey(), "relic-9", 0) }) // an item u1 does not hold
	testing.SetRealm(testing.NewUserRealm(u2))
	try(func() { post("fungible", obol, "", 10) }) // u2 holds nothing
	println(kylix.OpenOffers())
	testing.SetRealm(testing.NewUserRealm(u1))
	kylixdemo.Approve(cross(cur), "OBOL", slot, 10)
	testing.SetRealm(testing.NewUserRealm(u1))
	println(kylix.PostIntent(cross(cur), "fungible", obol, "", 10, "fungible", drachma, "", 10, 0), kylix.OpenOffers())
}

// Output:
// kylix: give: the offer could not settle now (slot g1mu8fjvjfk5yv2gf0yf6naqrrunzz8cd2hcr98f may spend 0 of gno.land/r/nym-kylix000/kylixdemo.OBOL; approve exactly 10, the amount this offer gives); approve first, then post
// kylix: give: the offer could not settle now (slot g1mu8fjvjfk5yv2gf0yf6naqrrunzz8cd2hcr98f may spend 11 of gno.land/r/nym-kylix000/kylixdemo.OBOL; approve exactly 10, the amount this offer gives); approve first, then post
// kylix: give: the offer could not settle now (owner no longer holds item relic-9); approve first, then post
// kylix: give: the offer could not settle now (owner holds 0 of gno.land/r/nym-kylix000/kylixdemo.OBOL, offer gives 10); approve first, then post
// 0
// 1 1
