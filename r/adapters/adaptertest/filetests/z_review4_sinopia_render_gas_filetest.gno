// PKGPATH: gno.land/r/nym-kylix000/adapters/adaptertest/filetests/z_review4_sinopia_render_gas
package z_review4_sinopia_render_gas

// Review 4, Item 3: Render("") gas with 92 Sinopia3 adapter offers (50 dead +
// 42 live) + 8 spam offers counted, 392 offers read, 6 ready 3-offer Sinopia3 rings.

import (
	"chain"
	"chain/runtime"
	"strconv"
	"strings"
	"testing"

	safe "gno.land/p/g1jz6j9hj6rdf5ltl2kcrpa4jwtdh3w30z0yul06/sinopia/safe/v1"
	"gno.land/p/nt/testutils/v0"
	"gno.land/r/g1jz6j9hj6rdf5ltl2kcrpa4jwtdh3w30z0yul06/sinopia3/core"
	"gno.land/r/g1jz6j9hj6rdf5ltl2kcrpa4jwtdh3w30z0yul06/sinopia3/engines/genesis"
	"gno.land/r/g1jz6j9hj6rdf5ltl2kcrpa4jwtdh3w30z0yul06/sinopia3/mint/v1"
	_ "gno.land/r/nym-kylix000/adapters/sinopia3"
	"gno.land/r/nym-kylix000/kylix"
	"gno.land/r/nym-kylix000/kylixdemo"
	"gno.land/r/sys/users"
)

const (
	sinopiaKey    = "gno.land/r/nym-kylix000/adapters/sinopia3"
	sinopiaAdmin  = address("g1jz6j9hj6rdf5ltl2kcrpa4jwtdh3w30z0yul06")
	genesisEngine = "gno.land/r/g1jz6j9hj6rdf5ltl2kcrpa4jwtdh3w30z0yul06/sinopia3/engines/genesis"
	mintPath      = "gno.land/r/g1jz6j9hj6rdf5ltl2kcrpa4jwtdh3w30z0yul06/sinopia3/mint/v1"
	unitPrice     = 1000
)

var (
	creator = testutils.TestAddress("r4-gas-creator")
	spam    = testutils.TestAddress("r4-gas-spam")
	named   [100]address
	target  uint64
)

func postSin(cur realm, cid string, who address, tid string, wantKind, wantKey, wantID string, wantMin int64) uint64 {
	nonce, _ := kylix.NextSlot(who)
	spender := kylix.ApproveTarget(who, nonce, sinopiaKey)
	testing.SetRealm(testing.NewUserRealm(who))
	core.Approve(cross(cur), cid, tid, spender)
	testing.SetRealm(testing.NewUserRealm(who))
	return kylix.PostIntent(cross(cur), "item", sinopiaKey, cid+"/"+tid, 0, wantKind, wantKey, wantID, wantMin, 0)
}

func init(cur realm) {
	testing.SetHeight(0)
	for i := range named {
		named[i] = testutils.TestAddress("r4g_" + strconv.Itoa(i))
		testing.SetRealm(testing.NewUserRealm(named[i]))
		_ = users.RegisterUser(cross(cur), "r4guser_"+strconv.Itoa(i), named[i])
	}
	testing.SetHeight(100)
	testing.SkipHeights(1) // blank ChainID before Launch so safe.Commit matches RevealCreatorSecret
	testing.SetRealm(testing.NewUserRealm(sinopiaAdmin))
	core.ExecuteOp(cross(cur), core.ProposeOp(cross(cur), core.OpMinterAdd, mintPath))
	testing.SetRealm(testing.NewUserRealm(sinopiaAdmin))
	genesis.Register(cross(cur))
	testing.SetRealm(testing.NewUserRealm(sinopiaAdmin))
	core.ClaimEngine(cross(cur), genesisEngine)

	testing.SetRealm(testing.NewUserRealm(creator))
	cid := mint.Create(cross(cur), "Gas Art", "GAS", "", genesisEngine, "", 200, 0, "", "", "")
	h := runtime.ChainHeight()
	testing.SetRealm(testing.NewUserRealm(creator))
	mint.AddPhase(cross(cur), cid, "public", "", h+1, h+20, unitPrice, unitPrice, 0, 0, 0)
	testing.SetRealm(testing.NewUserRealm(creator))
	mint.Launch(cross(cur), cid, safe.Commit(runtime.ChainID(), cid, "creator", "secret-gas-0123456789abcdef0123456789"), core.RevealWindowMin, false, "")
	testing.SkipHeights(1)

	pay := chain.NewCoins(chain.NewCoin("ugnot", unitPrice))
	for i := range named {
		testing.IssueCoins(named[i], pay)
		testing.IssueCoins(chain.PackageAddress(mintPath), pay)
		testing.SetOriginSend(pay)
		testing.SetRealm(testing.NewUserRealm(named[i]))
		mint.Mint(cross(cur), cid, 1, unitPrice, "")
		testing.SetOriginSend(nil)
	}
	testing.SkipHeights(25)
	testing.SetRealm(testing.NewUserRealm(creator))
	core.RevealCreatorSecret(cross(cur), cid, "secret-gas-0123456789abcdef0123456789")

	obol, drachma := kylixdemo.TokenKey("OBOL"), kylixdemo.TokenKey("DRACHMA")
	testing.SetRealm(testing.NewUserRealm(spam))
	kylixdemo.Claim(cross(cur))

	for r := 0; r < 6; r++ {
		i0, i1, i2 := r*3, r*3+1, r*3+2
		t0, t1, t2 := strconv.Itoa(i0+1), strconv.Itoa(i1+1), strconv.Itoa(i2+1)
		id0 := postSin(cur, cid, named[i0], t0, "item", sinopiaKey, cid+"/"+t2, 0)
		if r == 0 {
			target = id0
		}
		postSin(cur, cid, named[i1], t1, "item", sinopiaKey, cid+"/"+t0, 0)
		postSin(cur, cid, named[i2], t2, "item", sinopiaKey, cid+"/"+t1, 0)
	}
	for i := 18; i < 42; i++ {
		postSin(cur, cid, named[i], strconv.Itoa(i+1), "fungible", obol, "", 999999)
	}
	for i := 0; i < 300; i++ {
		_, slot := kylix.NextSlot(spam)
		testing.SetRealm(testing.NewUserRealm(spam))
		kylixdemo.Approve(cross(cur), "OBOL", slot, 1)
		testing.SetRealm(testing.NewUserRealm(spam))
		kylix.PostIntent(cross(cur), "fungible", obol, "", 1, "fungible", drachma, "", 999999, 0)
	}
	for i := 50; i < 100; i++ {
		tid := strconv.Itoa(i + 1)
		postSin(cur, cid, named[i], tid, "fungible", obol, "", 1)
		testing.SetRealm(testing.NewUserRealm(named[i]))
		core.Approve(cross(cur), cid, tid, "")
	}
}

func main(cur realm) {
	home := kylix.Render("")
	println("svgs:", strings.Count(home, "data:image/svg+xml;base64,"))
}

// Output:
// svgs: 6
