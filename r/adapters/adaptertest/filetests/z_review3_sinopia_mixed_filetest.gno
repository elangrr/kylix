// PKGPATH: gno.land/r/nym-kylix000/adapters/adaptertest/filetests/z_review3_sinopia_mixed
package z_review3_sinopia_mixed

// Security review 3, R3-1, inverted: the review's mixed ring (three
// Sinopia3 tokens approved for all, three exact OBOL approvals, every
// receiver a first-time holder; the review measured +7,027 B charged to the
// settler against -3,192 B refunded). The Sinopia3 offers cannot be posted.

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
	settler = testutils.TestAddress("r3-mix-settler")
	creator = testutils.TestAddress("r3-mix-creator")
	traders [6]address
	ringIDs string
)

func init(cur realm) {
	testing.SkipHeights(1)
	testing.SetRealm(testing.NewUserRealm(sinopiaAdmin))
	core.ExecuteOp(cross(cur), core.ProposeOp(cross(cur), core.OpMinterAdd, mintPath))
	testing.SetRealm(testing.NewUserRealm(sinopiaAdmin))
	genesis.Register(cross(cur))
	testing.SetRealm(testing.NewUserRealm(sinopiaAdmin))
	core.ClaimEngine(cross(cur), genesisEngine)

	bg := testutils.TestAddress("r3-mix-bg")
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
		traders[i] = testutils.TestAddress("r3-mix-leg-" + strconv.Itoa(i))
	}

	// Create 1 Final Genesis Sinopia3 collection; even traders hold 2 NFTs (0 OBOL),
	// odd traders hold 100 OBOL (0 NFTs).
	testing.SetRealm(testing.NewUserRealm(creator))
	cid := mint.Create(cross(cur), "Mix Art", "MIX", "", genesisEngine, "", 20, 0, "", "", "")
	h := runtime.ChainHeight()
	testing.SetRealm(testing.NewUserRealm(creator))
	mint.AddPhase(cross(cur), cid, "public", "", h+1, h+10, unitPrice, unitPrice, 0, 0, 0)
	testing.SetRealm(testing.NewUserRealm(creator))
	mint.Launch(cross(cur), cid, safe.Commit(runtime.ChainID(), cid, "creator", "secret-mix-0123456789abcdef0123456789"), core.RevealWindowMin, false, "")
	testing.SkipHeights(1)

	pay := chain.NewCoins(chain.NewCoin("ugnot", 2*unitPrice))
	for _, idx := range []int{0, 2, 4} {
		testing.IssueCoins(traders[idx], pay)
		testing.IssueCoins(chain.PackageAddress(mintPath), pay)
		testing.SetOriginSend(pay)
		testing.SetRealm(testing.NewUserRealm(traders[idx]))
		mint.Mint(cross(cur), cid, 2, unitPrice, "")
		testing.SetOriginSend(nil)
	}
	testing.SkipHeights(12)
	testing.SetRealm(testing.NewUserRealm(creator))
	core.RevealCreatorSecret(cross(cur), cid, "secret-mix-0123456789abcdef0123456789")

	for _, idx := range []int{1, 3, 5} {
		testing.SetRealm(testing.NewUserRealm(bg))
		kylixdemo.Transfer(cross(cur), "OBOL", traders[idx], 100)
	}

	// 6-leg official ring: 3 Sinopia3 items (SetApprovalForAll) + 3 OBOL (exact approval).
	// Solver --max-deposit auto cap = 3*250,000 + 3*100,000 = 1,050,000 ugnot (1.05 GNOT).
	itemIDs := [3]string{cid + "/1", cid + "/3", cid + "/5"}
	var ids [6]uint64
	for k := 0; k < 3; k++ {
		even := 2 * k
		odd := 2*k + 1
		// even gives Sinopia3 item (SetApprovalForAll), wants 50 OBOL (first-time holder!)
		nonceE, _ := kylix.NextSlot(traders[even])
		spenderE := kylix.ApproveTarget(traders[even], nonceE, sinopiaKey)
		testing.SetRealm(testing.NewUserRealm(traders[even]))
		core.SetApprovalForAll(cross(cur), cid, spenderE, true)
		testing.SetRealm(testing.NewUserRealm(traders[even]))
		ids[even] = kylix.PostIntent(cross(cur), "item", sinopiaKey, itemIDs[k], 0, "fungible", obol, "", 50, 0)

		// odd gives 50 OBOL (exact approval), wants itemIDs[k] (first-time holder!)
		_, slotO := kylix.NextSlot(traders[odd])
		testing.SetRealm(testing.NewUserRealm(traders[odd]))
		kylixdemo.Approve(cross(cur), "OBOL", slotO, 50)
		testing.SetRealm(testing.NewUserRealm(traders[odd]))
		ids[odd] = kylix.PostIntent(cross(cur), "fungible", obol, "", 50, "item", sinopiaKey, itemIDs[k], 0, 0)
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

// Error:
// kylix: give: the offer could not settle now (item 1/1 cannot be moved by g1gl6l0v8zrpj9l42u3xsgupn7v68xt6sgc7dh22 now (not approved, held by its collection, or refused by the collection's own rules)); approve first, then post
