// PKGPATH: gno.land/r/nym-kylix000/adapters/adaptertest/filetests/z_review3_sinopia_single
package z_review3_sinopia_single

// Security review 3, R3-1: the review's ring with single-token approvals,
// the only kind the adapter uses. Every receiver is still a first-time
// holder; each transfer now clears the approval it used, whose deposit is
// refunded to the settler. Compare the storage with the review's +12,288 B.

import (
	"chain"
	"chain/runtime"
	"strconv"
	"testing"

	safe "gno.land/p/g1jz6j9hj6rdf5ltl2kcrpa4jwtdh3w30z0yul06/sinopia/safe/v1"
	"gno.land/p/nt/testutils/v0"
	"gno.land/r/g1jz6j9hj6rdf5ltl2kcrpa4jwtdh3w30z0yul06/sinopia3/core"
	"gno.land/r/g1jz6j9hj6rdf5ltl2kcrpa4jwtdh3w30z0yul06/sinopia3/engines/genesis"
	"gno.land/r/g1jz6j9hj6rdf5ltl2kcrpa4jwtdh3w30z0yul06/sinopia3/mint/v1"
	_ "gno.land/r/nym-kylix000/adapters/sinopia3"
	"gno.land/r/nym-kylix000/kylix"
	"gno.land/r/nym-kylix000/kylixdemo"
)

const (
	sinopiaKey    = "gno.land/r/nym-kylix000/adapters/sinopia3"
	sinopiaAdmin  = address("g1jz6j9hj6rdf5ltl2kcrpa4jwtdh3w30z0yul06")
	genesisEngine = "gno.land/r/g1jz6j9hj6rdf5ltl2kcrpa4jwtdh3w30z0yul06/sinopia3/engines/genesis"
	mintPath      = "gno.land/r/g1jz6j9hj6rdf5ltl2kcrpa4jwtdh3w30z0yul06/sinopia3/mint/v1"
	unitPrice     = 1000
)

var (
	settler = testutils.TestAddress("r3-sin-settler")
	creator = testutils.TestAddress("r3-sin-creator")
	traders [6]address
	ringIDs string
)

func makeCol(cur realm, sym, sec string, holders []address) string {
	testing.SetRealm(testing.NewUserRealm(creator))
	cid := mint.Create(cross(cur), "Test "+sym, sym, "", genesisEngine, "", 20, 0, "", "", "")
	h := runtime.ChainHeight()
	testing.SetRealm(testing.NewUserRealm(creator))
	mint.AddPhase(cross(cur), cid, "public", "", h+1, h+10, unitPrice, unitPrice, 0, 0, 0)
	testing.SetRealm(testing.NewUserRealm(creator))
	mint.Launch(cross(cur), cid, safe.Commit(runtime.ChainID(), cid, "creator", sec), core.RevealWindowMin, false, "")
	testing.SkipHeights(1)

	pay := chain.NewCoins(chain.NewCoin("ugnot", 2*unitPrice))
	for _, who := range holders {
		testing.IssueCoins(who, pay)
		testing.IssueCoins(chain.PackageAddress(mintPath), pay)
		testing.SetOriginSend(pay)
		testing.SetRealm(testing.NewUserRealm(who))
		mint.Mint(cross(cur), cid, 2, unitPrice, "")
		testing.SetOriginSend(nil)
	}
	testing.SkipHeights(12)
	testing.SetRealm(testing.NewUserRealm(creator))
	core.RevealCreatorSecret(cross(cur), cid, sec)
	return cid
}

func init(cur realm) {
	testing.SkipHeights(1)
	testing.SetRealm(testing.NewUserRealm(sinopiaAdmin))
	core.ExecuteOp(cross(cur), core.ProposeOp(cross(cur), core.OpMinterAdd, mintPath))
	testing.SetRealm(testing.NewUserRealm(sinopiaAdmin))
	genesis.Register(cross(cur))
	testing.SetRealm(testing.NewUserRealm(sinopiaAdmin))
	core.ClaimEngine(cross(cur), genesisEngine)

	// 12 background offers so Kylix's B+ tree does not collapse.
	bg := testutils.TestAddress("r3-sin-bg")
	obol, drachma := kylixdemo.TokenKey("OBOL"), kylixdemo.TokenKey("DRACHMA")
	testing.SetRealm(testing.NewUserRealm(bg))
	kylixdemo.Claim(cross(cur))
	for i := 0; i < 12; i++ {
		// Posting requires the exact approval: approve first.
		_, slot := kylix.NextSlot(bg)
		testing.SetRealm(testing.NewUserRealm(bg))
		kylixdemo.Approve(cross(cur), "OBOL", slot, 1)
		testing.SetRealm(testing.NewUserRealm(bg))
		kylix.PostIntent(cross(cur), "fungible", obol, "", 1, "fungible", drachma, "", 1, 0)
	}

	for i := 0; i < 6; i++ {
		traders[i] = testutils.TestAddress("r3-sin-leg-" + strconv.Itoa(i))
	}
	// Even traders hold 2 tokens of cA (and 0 of cB); odd traders hold 2 tokens of cB (and 0 of cA).
	cA := makeCol(cur, "COLA", "secret-a-0123456789abcdef0123456789", []address{traders[0], traders[2], traders[4]})
	cB := makeCol(cur, "COLB", "secret-b-0123456789abcdef0123456789", []address{traders[1], traders[3], traders[5]})

	// Token IDs minted in order: trader0->{1,2}, trader2->{3,4}, trader4->{5,6} in cA;
	// trader1->{1,2}, trader3->{3,4}, trader5->{5,6} in cB.
	// Ring: t0(cA/1)->t1(cB/1)->t2(cA/3)->t3(cB/3)->t4(cA/5)->t5(cB/5)->t0.
	giveItem := [6]string{cA + "/1", cB + "/1", cA + "/3", cB + "/3", cA + "/5", cB + "/5"}
	giveCID := [6]string{cA, cB, cA, cB, cA, cB}
	giveTID := [6]string{"1", "1", "3", "3", "5", "5"}
	var ids [6]uint64
	for i := 0; i < 6; i++ {
		wantItem := giveItem[(i+5)%6]
		nonce, _ := kylix.NextSlot(traders[i])
		spender := kylix.ApproveTarget(traders[i], nonce, sinopiaKey)
		// A single-token approval, cleared by the transfer.
		testing.SetRealm(testing.NewUserRealm(traders[i]))
		core.Approve(cross(cur), giveCID[i], giveTID[i], spender)
		testing.SetRealm(testing.NewUserRealm(traders[i]))
		ids[i] = kylix.PostIntent(cross(cur), "item", sinopiaKey, giveItem[i], 0, "item", sinopiaKey, wantItem, 0, 0)
	}
	ringIDs = strconv.FormatUint(ids[0], 10)
	for i := 1; i < 6; i++ {
		ringIDs += "," + strconv.FormatUint(ids[i], 10)
	}
}

func main(cur realm) {
	testing.SetRealm(testing.NewUserRealm(settler))
	kylix.SettleRing(cross(cur), ringIDs)
	println("settled:", ringIDs)
}

// Output:
// settled: 13,14,15,16,17,18

// Storage:
// gno.land/r/g1jz6j9hj6rdf5ltl2kcrpa4jwtdh3w30z0yul06/sinopia3/core: 1968
// gno.land/r/nym-kylix000/adapters/adaptertest/filetests/z_review3_sinopia_single: 0
// gno.land/r/nym-kylix000/adapters/sinopia3: 0
// gno.land/r/nym-kylix000/kylix: -3228
