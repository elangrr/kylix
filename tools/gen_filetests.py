#!/usr/bin/env python3
"""Generates r/kylix/filetests/*_filetest.gno.

Filetests must be self-contained, so every file repeats the same header of
helpers; this script keeps them identical, which also keeps each happy path
and its gas baseline (z_<name>_base) byte-for-byte the same apart from the
SettleRing call. Run `make filetests` (or this script with an output
directory) after changing a scenario, then `make test`.
"""
import os
import sys

here = os.path.dirname(os.path.abspath(__file__))
out = sys.argv[1] if len(sys.argv) > 1 else os.path.join(here, "..", "r", "kylix", "filetests")

HEADER = '''// PKGPATH: gno.land/r/nym-kylix000/kylix/filetests/{pkg}
package {pkg}

// {doc}

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

type want struct {{
	kind, key, id string
	min           int64
}}

func tok(sym string, min int64) want {{ return want{{"fungible", kylixdemo.TokenKey(sym), "", min}} }}
func relic(id string) want          {{ return want{{"item", kylixdemo.CollectionKey(), id, 0}} }}
func hostileItem(id string) want    {{ return want{{"item", "gno.land/r/nym-kylix000/mocks/hostile", id, 0}} }}

// claim gives who 1000 OBOL, 1000 DRACHMA and the next relic.
func claim(cur realm, who address) string {{
	testing.SetRealm(testing.NewUserRealm(who))
	return kylixdemo.Claim(cross(cur))
}}

// giveTok approves who's next slot for amount and posts the offer.
func giveTok(cur realm, who address, sym string, amount int64, w want) uint64 {{
	_, slot := kylix.NextSlot(who)
	testing.SetRealm(testing.NewUserRealm(who))
	kylixdemo.Approve(cross(cur), sym, slot, amount)
	return kylix.PostIntent(cross(cur), "fungible", kylixdemo.TokenKey(sym), "", amount, w.kind, w.key, w.id, w.min, 0)
}}

func giveRelic(cur realm, who address, id string, w want) uint64 {{
	_, slot := kylix.NextSlot(who)
	testing.SetRealm(testing.NewUserRealm(who))
	kylixdemo.ApproveRelic(cross(cur), slot, id)
	return kylix.PostIntent(cross(cur), "item", kylixdemo.CollectionKey(), id, 0, w.kind, w.key, w.id, w.min, 0)
}}

// giveHostile mints a hostile-collection item to who and offers it.
func giveHostile(cur realm, who address, id string, w want) uint64 {{
	hostile.Mint(cross(cur), who, id)
	_, slot := kylix.NextSlot(who)
	testing.SetRealm(testing.NewUserRealm(who))
	hostile.Approve(cross(cur), slot, id)
	return kylix.PostIntent(cross(cur), "item", "gno.land/r/nym-kylix000/mocks/hostile", id, 0, w.kind, w.key, w.id, w.min, 0)
}}

// giveLegacy mints a legacy721 item to who, approves exactly the address
// kylix.ApproveTarget names for who's next offer, and offers the item
// through the adapter.
func giveLegacy(cur realm, who address, id string, w want) uint64 {{
	legacy721.Mint(cross(cur), who, id)
	nonce, _ := kylix.NextSlot(who)
	testing.SetRealm(testing.NewUserRealm(who))
	legacy721.Approve(cross(cur), kylix.ApproveTarget(who, nonce, legacyKey), id)
	return kylix.PostIntent(cross(cur), "item", legacyKey, id, 0, w.kind, w.key, w.id, w.min, 0)
}}

// legacyMove is the test adapter's MoveFn, for the direct-call threats.
func legacyMove() kylix.MoveFn {{ return legacyadapter.Move }}

// legacySpender is the address the test adapter says to approve for slot.
func legacySpender(slot address) address {{ return legacyadapter.SpenderFor(slot) }}

// openPool creates a stand-in GnoSwap pool OBOL/DRACHMA with this fee tier,
// where one OBOL buys num/den DRACHMA, and has who fund it with amount
// DRACHMA (0: leave it empty).
func openPool(cur realm, who address, fee uint32, num, den, amount int64) {{
	obol, drachma := kylixdemo.TokenKey("OBOL"), kylixdemo.TokenKey("DRACHMA")
	pool.MockCreatePool(cross(cur), obol, drachma, fee, num, den)
	if amount == 0 {{
		return
	}}
	testing.SetRealm(testing.NewUserRealm(who))
	kylixdemo.Approve(cross(cur), "DRACHMA", chain.PackageAddress("gno.land/r/gnoswap/pool"), amount)
	pool.MockFund(cross(cur), obol, drachma, fee, drachma, amount)
}}

// routerFault switches the stand-in router: halted, reporting less input
// used than asked (shortfall), or pulling less than it reports (underpull).
func routerFault(cur realm, halted bool, shortfall, underpull int64) {{
	router.MockSetHalted(cross(cur), halted)
	router.MockSetInputShortfall(cross(cur), shortfall)
	router.MockSetUnderpull(cross(cur), underpull)
}}

// settleVia settles the ring through the pool with this fee tier.
func settleVia(cur realm, fee uint32) {{
	testing.SetRealm(testing.NewUserRealm(settler))
	kylix.SettleRingVia(cross(cur), ids, fee)
}}

// bombBytes is how much the storage-bomb collection has stored.
func bombBytes() int {{ return storagebomb.BloatBytes() }}

// height is the current block height.
func height() int64 {{ return runtime.ChainHeight() }}

func join(xs ...uint64) string {{
	s := ""
	for i, x := range xs {{
		if i > 0 {{
			s += ","
		}}
		s += strconv.FormatUint(x, 10)
	}}
	return s
}}

func settle(cur realm) {{
	testing.SetRealm(testing.NewUserRealm(settler))
	kylix.SettleRing(cross(cur), ids)
}}
'''

files = {}

# ---------------------------------------------------------------- happy paths
RING2_INIT = '''
func init(cur realm) {
	claim(cur, u1) // relic-1
	claim(cur, u2) // relic-2
	// u1 gives 100 OBOL for relic-2; u2 gives relic-2 for at least 100 OBOL.
	a := giveTok(cur, u1, "OBOL", 100, relic("relic-2"))
	b := giveRelic(cur, u2, "relic-2", tok("OBOL", 100))
	ids = join(a, b)
}
'''
RING2_PRINT = '''
	println(ids, kylix.OpenOffers())
	println(kylixdemo.BalanceOf("OBOL", u1), kylixdemo.BalanceOf("OBOL", u2))
	println(kylixdemo.OwnerOfRelic("relic-2") == u1)
'''
RING3_INIT = '''
func init(cur realm) {
	claim(cur, u1) // relic-1
	claim(cur, u2) // relic-2
	claim(cur, u3) // relic-3
	// u1: 100 OBOL -> u2; u2: relic-2 -> u3; u3: 50 DRACHMA -> u1.
	a := giveTok(cur, u1, "OBOL", 100, tok("DRACHMA", 50))
	b := giveRelic(cur, u2, "relic-2", tok("OBOL", 100))
	c := giveTok(cur, u3, "DRACHMA", 50, relic("relic-2"))
	ids = join(a, b, c)
}
'''
RING3_PRINT = '''
	println(ids, kylix.OpenOffers())
	println(kylixdemo.BalanceOf("OBOL", u1), kylixdemo.BalanceOf("DRACHMA", u1))
	println(kylixdemo.BalanceOf("OBOL", u2), kylixdemo.BalanceOf("DRACHMA", u3))
	println(kylixdemo.OwnerOfRelic("relic-2") == u3)
'''
RING6_INIT = '''
func init(cur realm) {
	for _, u := range []address{u1, u2, u3, u4, u5, u6} {
		claim(cur, u) // u_i gets relic-i
	}
	// Three token legs and three item legs from two collections:
	// u1 100 OBOL -> u2, u2 relic-2 -> u3, u3 70 DRACHMA -> u4,
	// u4 hostile h-4 (honest mode) -> u5, u5 relic-5 -> u6, u6 30 DRACHMA -> u1.
	a := giveTok(cur, u1, "OBOL", 100, tok("DRACHMA", 30))
	b := giveRelic(cur, u2, "relic-2", tok("OBOL", 90))
	c := giveTok(cur, u3, "DRACHMA", 70, relic("relic-2"))
	d := giveHostile(cur, u4, "h-4", tok("DRACHMA", 60))
	e := giveRelic(cur, u5, "relic-5", hostileItem("h-4"))
	f := giveTok(cur, u6, "DRACHMA", 30, relic("relic-5"))
	ids = join(a, b, c, d, e, f)
}
'''
RING6_PRINT = '''
	println(ids, kylix.OpenOffers())
	println(kylixdemo.BalanceOf("OBOL", u1), kylixdemo.BalanceOf("DRACHMA", u1), kylixdemo.BalanceOf("OBOL", u2))
	println(kylixdemo.BalanceOf("DRACHMA", u3), kylixdemo.BalanceOf("DRACHMA", u4), kylixdemo.BalanceOf("DRACHMA", u6))
	println(kylixdemo.OwnerOfRelic("relic-2") == u3, hostile.OwnerOf("h-4") == u5, kylixdemo.OwnerOfRelic("relic-5") == u6)
'''

def happy(name, doc, init, prn, out_settled, out_base):
    files[f"z_{name}_filetest.gno"] = HEADER.format(pkg=f"z_{name}", doc=doc + " Happy path; compare gas with z_" + name + "_base.") + init + \
        "\nfunc main(cur realm) {\n\tsettle(cur)" + prn + "}\n\n// Output:\n" + "".join("// " + l + "\n" for l in out_settled)
    files[f"z_{name}_base_filetest.gno"] = HEADER.format(pkg=f"z_{name}_base", doc="Gas baseline for z_" + name + ": identical setup and checks, no SettleRing.") + init + \
        "\nfunc main(cur realm) {" + prn + "}\n\n// Output:\n" + "".join("// " + l + "\n" for l in out_base)

happy("ring2", "Two legs: tokens for an item.", RING2_INIT, RING2_PRINT,
      ["1,2 0", "900 1100", "true"], ["1,2 2", "1000 1000", "false"])
happy("ring3", "Three legs: token, item, token.", RING3_INIT, RING3_PRINT,
      ["1,2,3 0", "900 1050", "1100 950", "true"], ["1,2,3 3", "1000 1000", "1000 1000", "false"])
happy("ring6", "Six legs: three tokens, three items from two collections.", RING6_INIT, RING6_PRINT,
      ["1,2,3,4,5,6 0", "900 1030 1100", "930 1070 970", "true true true"],
      ["1,2,3,4,5,6 6", "1000 1000 1000", "1000 1000 1000", "false false false"])

# ------------------------------------------------------------ hostile and failure cases
HOSTILE_INIT = '''
func init(cur realm) {
	claim(cur, u1)
	claim(cur, u2)
	// u1 gives 100 OBOL for hostile item h-1; u2 gives h-1 for 100 OBOL.
	a := giveTok(cur, u1, "OBOL", 100, hostileItem("h-1"))
	b := giveHostile(cur, u2, "h-1", tok("OBOL", 100))
	ids = join(a, b)
}
'''
def scenario(name, doc, init, main_body, output):
    files[f"z_{name}_filetest.gno"] = HEADER.format(pkg=f"z_{name}", doc=doc) + init + \
        "\nfunc main(cur realm) {\n" + main_body + "}\n\n// Output:\n" + "".join("// " + l + "\n" for l in output)

def failing(name, doc, init, main_body, err):
    files[f"z_{name}_filetest.gno"] = HEADER.format(pkg=f"z_{name}", doc=doc) + init + \
        "\nfunc main(cur realm) {\n" + main_body + "\tsettle(cur)\n\tprintln(\"unreachable\")\n}\n\n// Error:\n// " + err + "\n"

failing("hostile_reenter_settle",
    "Threat: a hostile collection re-enters SettleRing during a move. A second, valid ring is ready for it to settle.",
    HOSTILE_INIT.replace("\tids = join(a, b)\n", '''	ids = join(a, b)
	claim(cur, u3)
	claim(cur, u4)
	c := giveTok(cur, u3, "OBOL", 10, tok("DRACHMA", 10))
	d := giveTok(cur, u4, "DRACHMA", 10, tok("OBOL", 10))
	hostile.SetReenterSettle(cross(cur), join(c, d))
'''),
    '\thostile.SetMode(cross(cur), "reenter-settle")\n',
    "kylix: re-entrant call during settlement")
failing("hostile_reenter_post",
    "Threat: a hostile collection re-enters PostIntent during a move.",
    HOSTILE_INIT,
    '\thostile.SetReenterPost(cross(cur), kylixdemo.TokenKey("OBOL"))\n\thostile.SetMode(cross(cur), "reenter-post")\n',
    "kylix: re-entrant call during settlement")
failing("hostile_reenter_cancel",
    "Threat: a hostile collection re-enters CancelIntent during a move, on an open offer it owns.",
    HOSTILE_INIT,
    '\ttesting.SetRealm(testing.NewUserRealm(u1))\n\tkylixdemo.Transfer(cross(cur), "OBOL", chain.PackageAddress("gno.land/r/nym-kylix000/mocks/hostile"), 5)\n\town := hostile.PostAsSelf(cross(cur), kylixdemo.TokenKey("OBOL"), 5, kylixdemo.TokenKey("DRACHMA"), 5)\n\thostile.SetReenterCancel(cross(cur), own)\n\thostile.SetMode(cross(cur), "reenter-cancel")\n',
    "kylix: re-entrant call during settlement")
failing("hostile_nomove",
    "Threat: a hostile collection returns nil without moving the item. Kylix checks ownership after the move.",
    HOSTILE_INIT,
    '\thostile.SetMode(cross(cur), "no-move")\n',
    "kylix: leg 1 (offer 2): collection reported a move but item h-1 is owned by g1w5e97h6lta047h6lta047h6lta047h6lkdczk9, not g1w5c47h6lta047h6lta047h6lta047h6ly5kscr")
failing("hostile_error",
    "Threat: a hostile collection returns an error. The message names the leg.",
    HOSTILE_INIT,
    '\thostile.SetMode(cross(cur), "error")\n',
    "kylix: leg 1 (offer 2): collection refused the move: hostile: refusing to move")
failing("hostile_panic",
    "Threat: a hostile collection panics. The whole transaction aborts.",
    HOSTILE_INIT,
    '\thostile.SetMode(cross(cur), "panic")\n',
    "hostile: panic inside move")
failing("hostile_steal",
    "Threat: a hostile collection tries to spend an allowance as the slot Kylix crossed in with. u2 has also approved its own slot for OBOL; the slot token is not live inside the collection, so grc20reg refuses it.",
    HOSTILE_INIT.replace("\tids = join(a, b)\n", '''	ids = join(a, b)
	testing.SetRealm(testing.NewUserRealm(u2))
	kylixdemo.Approve(cross(cur), "OBOL", kylix.SlotAddress(u2, 1), 500)
	hostile.SetSteal(cross(cur), kylixdemo.TokenKey("OBOL"), u2, 500)
'''),
    '\thostile.SetMode(cross(cur), "steal")\n',
    "rlm does not match the current crossing frame")
failing("item_revoked",
    "Threat: the owner revokes the item approval after posting. Relics register an approval check, so preflight names the leg before anything is written.",
    RING2_INIT,
    '\ttesting.SetRealm(testing.NewUserRealm(u2))\n\tkylixdemo.ApproveRelic(cross(cur), "", "relic-2")\n',
    "kylix: leg 1 (offer 2): item relic-2 cannot be moved by g155s6a2zs37jtpr77fj39vhh2u648akluhm55ru now (not approved, held by its collection, or refused by the collection's own rules)")
failing("item_spent",
    "Threat: the owner gives the item away after posting. Preflight catches it before anything is written.",
    RING2_INIT,
    '\ttesting.SetRealm(testing.NewUserRealm(u2))\n\tkylixdemo.TransferRelic(cross(cur), u6, "relic-2")\n',
    "kylix: leg 1 (offer 2): owner no longer holds item relic-2")
failing("token_revoked",
    "Threat: the owner revokes the token approval after posting. Preflight names the leg before anything is written.",
    RING2_INIT,
    '\ttesting.SetRealm(testing.NewUserRealm(u1))\n\tkylixdemo.Approve(cross(cur), "OBOL", kylix.SlotAddress(u1, 1), 0)\n',
    "kylix: leg 0 (offer 1): slot g1mu8fjvjfk5yv2gf0yf6naqrrunzz8cd2hcr98f may spend 0 of gno.land/r/nym-kylix000/kylixdemo.OBOL; approve exactly 100, the amount this offer gives")

failing("item_revoked_nocheck",
    "Threat: the owner revokes the item approval after posting, in a collection without an approval check. The move fails and names the leg; the chain rolls back the whole transaction, leaving every offer open.",
    HOSTILE_INIT,
    '\ttesting.SetRealm(testing.NewUserRealm(u2))\n\thostile.Approve(cross(cur), "", "h-1")\n',
    "kylix: leg 1 (offer 2): collection refused the move: caller is not token owner or approved")

# ----------------------------------------------------------------- GnoSwap bridge
BRIDGE_INIT = '''
func init(cur realm) {
	for _, u := range []address{u1, u2, u3, u4} {
		claim(cur, u) // u_i gets relic-i
	}
	POOL
	// u1: 1000 OBOL -> u2, who wants DRACHMA: bridged by a swap.
	// u2: relic-2 -> u3; u3: 50 DRACHMA -> u1.
	a := giveTok(cur, u1, "OBOL", 1000, tok("DRACHMA", 50))
	b := giveRelic(cur, u2, "relic-2", tok("DRACHMA", WANTMIN))
	c := THIRD
	ids = join(a, b, c)
}
'''
ONE_POOL = "openPool(cur, u4, 3000, 1, 1, 1000) // 0.3%, 1:1, 1000 DRACHMA of liquidity"
DECOY_POOLS = """openPool(cur, u4, 3000, 1, 1, 1000) // 0.3%, 1:1, 1000 DRACHMA: the real market
	// A decoy: 1%, one OBOL buys 0.01 DRACHMA, but it holds more DRACHMA.
	claim(cur, u5)
	claim(cur, u6)
	openPool(cur, u5, 10000, 1, 100, 1000)
	testing.SetRealm(testing.NewUserRealm(u6))
	kylixdemo.Approve(cross(cur), "DRACHMA", chain.PackageAddress("gno.land/r/gnoswap/pool"), 1000)
	pool.MockFund(cross(cur), kylixdemo.TokenKey("OBOL"), kylixdemo.TokenKey("DRACHMA"), 10000, kylixdemo.TokenKey("DRACHMA"), 1000)"""
EMPTY_POOL = "openPool(cur, u4, 3000, 1, 1, 0) // a pool with nothing in it"
def bridge_init(pool=ONE_POOL, wantmin=990, third='giveTok(cur, u3, "DRACHMA", 50, relic("relic-2"))'):
    return BRIDGE_INIT.replace("POOL", pool or "// no pool for OBOL/DRACHMA") \
        .replace("WANTMIN", str(wantmin)).replace("THIRD", third)
BRIDGE_PRINT = '''
	settle := kylix.SettleAddress()
	println(ids, kylix.OpenOffers())
	println(kylixdemo.BalanceOf("OBOL", u1), kylixdemo.BalanceOf("DRACHMA", u1), kylixdemo.BalanceOf("DRACHMA", u2))
	println(kylixdemo.OwnerOfRelic("relic-2") == u3)
	println(kylixdemo.BalanceOf("OBOL", settle), kylixdemo.BalanceOf("DRACHMA", settle),
		kylixdemo.Allowance("OBOL", settle, chain.PackageAddress("gno.land/r/gnoswap/router")))
'''
happy("ring3_bridged", "Three legs with one hop bridged by a (stand-in) GnoSwap swap: 1000 OBOL in, 997 after the 0.3% pool fee, 996 after the 15 bps router fee, all of it to the receiver. The settle sub-address ends empty with no allowance left.",
      bridge_init(), BRIDGE_PRINT,
      ["1,2,3 0", "0 1050 1996", "true", "0 0 0"],
      ["1,2,3 3", "1000 1000 1000", "false", "0 0 0"])
failing("bridge_slippage",
    "Bridge: the swap returns less than the receiver's minimum. The router refuses and the whole ring aborts.",
    bridge_init(wantmin=997), "", "[GNOSWAP-ROUTER] slippage: output 996 < minimum 997")
failing("bridge_nopool",
    "Bridge: no pool exists for the pair. Preflight names the leg before anything is written.",
    bridge_init(pool=""), "",
    "kylix: leg 0 (offer 1): no GnoSwap pool with reserves to swap gno.land/r/nym-kylix000/kylixdemo.OBOL for gno.land/r/nym-kylix000/kylixdemo.DRACHMA")
failing("bridge_halted",
    "Bridge: the router is halted. The swap panics and the whole ring aborts.",
    bridge_init(), "\trouterFault(cur, true, 0, 0)\n", "[GNOSWAP-ROUTER] router is halted")
failing("bridge_partial",
    "Bridge: the router consumes less than the whole input. A leg gives its whole amount, so Kylix aborts.",
    bridge_init(), "\trouterFault(cur, false, 1, 0)\n",
    "kylix: leg 0 (offer 1): swap used 999 of 1000; a leg gives its whole amount")
failing("bridge_two",
    "Bridge: a ring that needs two swaps is refused before anything is written.",
    bridge_init(third='giveTok(cur, u3, "OBOL", 50, relic("relic-2"))'), "",
    "kylix: ring: leg 2 (offer 3): a ring can bridge at most 1 hop, and the hop from leg 0 is already bridged")

failing("bridge_allowance_left",
    "Bridge: the router reports using the whole input but leaves part of the allowance unspent. Kylix refuses to finish with an allowance on the router.",
    bridge_init(), "\trouterFault(cur, false, 0, 1)\n",
    "kylix: leg 0 (offer 1): router allowance left after the swap: 1")
failing("bridge_zero_reserve",
    "Bridge: SettleRing ignores a pool that holds none of the token being bought; with no other pool, preflight names the leg.",
    bridge_init(pool=EMPTY_POOL), "",
    "kylix: leg 0 (offer 1): no GnoSwap pool with reserves to swap gno.land/r/nym-kylix000/kylixdemo.OBOL for gno.land/r/nym-kylix000/kylixdemo.DRACHMA")
failing("bridge_decoy_auto",
    "Threat (finding 3 of security review 1): a decoy pool holding more of the bought token but at a bad price makes SettleRing's automatic choice fail. This is the documented limit of SettleRing; z_bridge_decoy_via shows the remedy.",
    bridge_init(pool=DECOY_POOLS), "",
    "[GNOSWAP-ROUTER] slippage: output 9 < minimum 990")
scenario("bridge_decoy_via",
    "Finding 3 of security review 1: with a decoy pool present, the settler names the real pool with SettleRingVia and the ring settles.",
    bridge_init(pool=DECOY_POOLS),
    "\tsettleVia(cur, 3000)" + BRIDGE_PRINT,
    ["1,2,3 0", "0 1050 1996", "true", "0 0 0"])
failing("bridge_via_badfee",
    "SettleRingVia refuses a fee that is not one of GnoSwap's tiers.",
    bridge_init(), "\tsettleVia(cur, 2500)\n", "kylix: fee must be one of GnoSwap's tiers: 100, 500, 3000 or 10000")
failing("bridge_via_nopool",
    "SettleRingVia refuses a fee tier with no pool for the pair, naming the leg.",
    bridge_init(), "\tsettleVia(cur, 500)\n",
    "kylix: leg 0 (offer 1): no GnoSwap pool with fee tier 500 to swap gno.land/r/nym-kylix000/kylixdemo.OBOL for gno.land/r/nym-kylix000/kylixdemo.DRACHMA")
failing("bridge_via_direct",
    "SettleRingVia refuses a ring with no swap through GnoSwap.",
    RING2_INIT, "\tsettleVia(cur, 3000)\n", "kylix: this ring has no swap through GnoSwap; use SettleRing")

# --------------------------------------------------------- storage-deposit bill
BOMB_INIT = '''
func init(cur realm) {
	claim(cur, u1)
	storagebomb.SetHolder(cross(cur), u2)
	// u2 offers storage-bomb item b-1 for 1 OBOL; u1 gives 1 OBOL for it.
	testing.SetRealm(testing.NewUserRealm(u2))
	b := kylix.PostIntent(cross(cur), "item", "gno.land/r/nym-kylix000/mocks/storagebomb", "b-1", 0, "fungible", kylixdemo.TokenKey("OBOL"), "", 1, EXPIRY)
	a := giveTok(cur, u1, "OBOL", 1, want{"item", "gno.land/r/nym-kylix000/mocks/storagebomb", "b-1", 0})
	ids = join(b, a)
}
'''
scenario("storagebomb_prune",
    "Finding 2 of security review 1, closed for pruning: PruneIntent calls no collection code, so pruning a hostile collection's expired offer stores nothing in it and costs the pruner nothing.",
    BOMB_INIT.replace("EXPIRY", "height()+1"),
    "\tbefore := bombBytes() // posting ran its OwnerOf and Approved, at the poster's expense\n\ttesting.SkipHeights(2)\n\ttesting.SetRealm(testing.NewUserRealm(settler))\n\tkylix.PruneIntent(cross(cur), 1)\n\tprintln(kylix.OpenOffers(), bombBytes()-before)\n",
    ["1 0"])
scenario("storagebomb_settle",
    "Finding 2 of security review 1, documented for settlement: settling a ring runs each collection's code, which may store data at the settler's expense (4 KB from each of OwnerOf and Approved in preflight, Move, and OwnerOf after the move). Settlers set a tight -max-deposit.",
    BOMB_INIT.replace("EXPIRY", "0"),
    "\tbefore := bombBytes() // posting ran its OwnerOf and Approved, at the poster's expense\n\tsettle(cur)\n\tprintln(kylix.OpenOffers(), bombBytes()-before)\n",
    ["0 16384"])

# ------------------------------------------------------------------- adapters
ADAPTER_INIT = '''
func init(cur realm) {
	claim(cur, u1)
	claim(cur, u2)
	// u1 offers legacy item L-1 through the official test adapter for 100
	// OBOL; u2 gives 100 OBOL for it.
	a := giveLegacy(cur, u1, "L-1", tok("OBOL", 100))
	b := giveTok(cur, u2, "OBOL", 100, want{"item", legacyKey, "L-1", 0})
	ids = join(a, b)
}
'''
scenario("adapter_ring",
    "Adapter: an item of a collection that knows nothing of Kylix trades through an adapter. The owner approved ApproveTarget, the adapter's k/<slot> sub-address, not the slot.",
    ADAPTER_INIT,
    '''	slot := kylix.SlotAddress(u1, 1)
	target := kylix.ApproveTarget(u1, 1, legacyKey)
	println(target == legacySpender(slot), target != slot)
	c, _ := kylix.GetCollection(legacyKey)
	println(c.Adapter, c.Official, c.ApprovalCheck, c.Target)
	settle(cur)
	println(legacy721.OwnerOf("L-1") == u2, kylixdemo.BalanceOf("OBOL", u1), kylix.OpenOffers())
''',
    ["true true", "true true true gno.land/r/nym-kylix000/mocks/legacy721", "true 1100 0"])
REFUSED = ["legacy adapter: approve this offer's address for the item itself", "true"]
scenario("adapter_forged",
    "Threat: another realm mints its own w/<owner>/<nonce> sub-identity and calls the adapter. Its address differs from Kylix's slot, so the address the owner approved is not its k/ identity, and the adapter refuses.",
    ADAPTER_INIT,
    '\tprintln(hostile.ForgeSlot(cross(cur), legacyMove(), u1, 1, u1, u3, "L-1"))\n\tprintln(legacy721.OwnerOf("L-1") == u1)\n',
    REFUSED)
scenario("adapter_direct_hostile",
    "Threat: a hostile realm calls the adapter's Move directly. Nobody approved its k/ identity, so the adapter refuses.",
    ADAPTER_INIT,
    '\tprintln(hostile.Direct(cross(cur), legacyMove(), u1, u3, "L-1"))\n\tprintln(legacy721.OwnerOf("L-1") == u1)\n',
    REFUSED)
scenario("adapter_direct_user",
    "Threat: a user calls the adapter's Move directly. Nobody approved its k/ identity, so the adapter refuses.",
    ADAPTER_INIT,
    '\ttesting.SetRealm(testing.NewUserRealm(u3))\n\tmove := legacyMove()\n\tprintln(move(cross(cur), u1, u3, "L-1"))\n\tprintln(legacy721.OwnerOf("L-1") == u1)\n',
    REFUSED)
failing("adapter_approval_for_all",
    "Security review 3, R3-1: an approval for all items is not used, because the move does not consume it (its deposit would never come back to the settler). The owner replaced the single-item approval with an approval for all; preflight refuses before anything is written.",
    ADAPTER_INIT,
    '\ttesting.SetRealm(testing.NewUserRealm(u1))\n\tlegacy721.Approve(cross(cur), "", "L-1")\n\ttesting.SetRealm(testing.NewUserRealm(u1))\n\tlegacy721.SetApprovalForAll(cross(cur), kylix.ApproveTarget(u1, 1, legacyKey), true)\n',
    "kylix: leg 0 (offer 1): item L-1 cannot be moved by g1y0ne40qp8v56y9rm3tnljm7ku2d9vpl4a5wqr9 now (not approved, held by its collection, or refused by the collection's own rules)")
failing("relic_approval_for_all",
    "Security review 3, R3-1: the demo collection, like the official adapters, uses only an approval of the one relic, which the transfer clears. An approval for all relics is refused before anything is written.",
    RING2_INIT,
    '\ttesting.SetRealm(testing.NewUserRealm(u2))\n\tkylixdemo.ApproveRelic(cross(cur), "", "relic-2")\n\ttesting.SetRealm(testing.NewUserRealm(u2))\n\tkylixdemo.ApproveAllRelics(cross(cur), kylix.SlotAddress(u2, 1), true)\n',
    "kylix: leg 1 (offer 2): item relic-2 cannot be moved by g155s6a2zs37jtpr77fj39vhh2u648akluhm55ru now (not approved, held by its collection, or refused by the collection's own rules)")
scenario("post_needs_approval",
    "The posting rule: an offer must be deliverable when it is posted. Approve first, then post; unfunded, unapproved, over-approved and unowned offers are refused, and nothing is stored.",
    "\nfunc init(cur realm) {\n\tclaim(cur, u1) // relic-1\n}\n",
    '''	obol, drachma := kylixdemo.TokenKey("OBOL"), kylixdemo.TokenKey("DRACHMA")
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
''',
    ["kylix: give: the offer could not settle now (slot g1mu8fjvjfk5yv2gf0yf6naqrrunzz8cd2hcr98f may spend 0 of gno.land/r/nym-kylix000/kylixdemo.OBOL; approve exactly 10, the amount this offer gives); approve first, then post",
     "kylix: give: the offer could not settle now (slot g1mu8fjvjfk5yv2gf0yf6naqrrunzz8cd2hcr98f may spend 11 of gno.land/r/nym-kylix000/kylixdemo.OBOL; approve exactly 10, the amount this offer gives); approve first, then post",
     "kylix: give: the offer could not settle now (owner no longer holds item relic-9); approve first, then post",
     "kylix: give: the offer could not settle now (owner holds 0 of gno.land/r/nym-kylix000/kylixdemo.OBOL, offer gives 10); approve first, then post",
     "0", "1 1"])
failing("adapter_paused",
    "Threat: the collection pauses transfers (like Sinopia3's lock hook or an MNS registry hold). The move panics and the whole ring aborts.",
    ADAPTER_INIT,
    '\tlegacy721.SetPaused(cross(cur), true)\n',
    "legacy721: transfers are paused")
failing("adapter_wrong_approval",
    "An owner who approved the slot itself instead of ApproveTarget is caught by the adapter's approval check, naming the leg and the address to approve.",
    ADAPTER_INIT,
    '\ttesting.SetRealm(testing.NewUserRealm(u1))\n\tlegacy721.Approve(cross(cur), kylix.SlotAddress(u1, 1), "L-1")\n',
    "kylix: leg 0 (offer 1): item L-1 cannot be moved by g1y0ne40qp8v56y9rm3tnljm7ku2d9vpl4a5wqr9 now (not approved, held by its collection, or refused by the collection's own rules)")

os.makedirs(out, exist_ok=True)
for name, body in files.items():
    with open(os.path.join(out, name), "w") as f:
        f.write(body)
print(len(files), "files")
