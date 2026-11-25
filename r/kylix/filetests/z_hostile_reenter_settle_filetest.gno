// PKGPATH: gno.land/r/nym-kylix000/kylix/filetests/z_hostile_reenter_settle
package z_hostile_reenter_settle

// Threat: a hostile collection re-enters SettleRing during a move. A second, valid ring is ready for it to settle.

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
	claim(cur, u1)
	claim(cur, u2)
	// u1 gives 100 OBOL for hostile item h-1; u2 gives h-1 for 100 OBOL.
	a := giveTok(cur, u1, "OBOL", 100, hostileItem("h-1"))
	b := giveHostile(cur, u2, "h-1", tok("OBOL", 100))
	ids = join(a, b)
	claim(cur, u3)
	claim(cur, u4)
	c := giveTok(cur, u3, "OBOL", 10, tok("DRACHMA", 10))
	d := giveTok(cur, u4, "DRACHMA", 10, tok("OBOL", 10))
	hostile.SetReenterSettle(cross(cur), join(c, d))
}

func main(cur realm) {
	hostile.SetMode(cross(cur), "reenter-settle")
	settle(cur)
	println("unreachable")
}

// Error:
// kylix: re-entrant call during settlement
