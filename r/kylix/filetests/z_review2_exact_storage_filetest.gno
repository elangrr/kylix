// PKGPATH: gno.land/r/nym-kylix000/kylix/filetests/z_review2_exact_storage
package z_review2_exact_storage

import (
	"strconv"
	"testing"

	"gno.land/p/nt/testutils/v0"
	"gno.land/r/nym-kylix000/kylix"
	"gno.land/r/nym-kylix000/kylixdemo"
)

var (
	settler = testutils.TestAddress("r2-settler")
	ringIDs string
)

func init(cur realm) {
	// Security review 2, N3 (realm side): the worst honest case for a settler.
	// A 6-offer ring of canonical GRC20 tokens (OBOL, DRACHMA) where every
	// receiver has never held the token it receives, so each transfer adds a
	// balance entry the settler pays for. With the exact allowances Kylix now
	// requires, each transfer also deletes the allowance entry it used up,
	// whose deposit is refunded to the settler. 12 background offers keep the
	// book from collapsing on deletion, as in a live book.
	obol := kylixdemo.TokenKey("OBOL")
	drachma := kylixdemo.TokenKey("DRACHMA")

	bg := testutils.TestAddress("r2-bg")
	testing.SetRealm(testing.NewUserRealm(bg))
	kylixdemo.Claim(cross(cur))
	for i := 0; i < 12; i++ {
		_, slot := kylix.NextSlot(bg)
		testing.SetRealm(testing.NewUserRealm(bg))
		kylixdemo.Approve(cross(cur), "OBOL", slot, 1) // posting requires the exact approval
		testing.SetRealm(testing.NewUserRealm(bg))
		kylix.PostIntent(cross(cur), "fungible", obol, "", 1, "fungible", drachma, "", 1, 0)
	}

	// Fund 6 distinct traders: even traders hold ONLY OBOL (no DRACHMA AVL node),
	// odd traders hold ONLY DRACHMA (no OBOL AVL node).
	var traders [6]address
	for i := 0; i < 6; i++ {
		traders[i] = testutils.TestAddress("r2-leg-" + strconv.Itoa(i))
		testing.SetRealm(testing.NewUserRealm(bg))
		if i%2 == 0 {
			kylixdemo.Transfer(cross(cur), "OBOL", traders[i], 100)
		} else {
			kylixdemo.Transfer(cross(cur), "DRACHMA", traders[i], 100)
		}
	}

	// 6-leg ring: t0(OBOL)->t1(DRACHMA)->t2(OBOL)->t3(DRACHMA)->t4(OBOL)->t5(DRACHMA)->t0
	var ids [6]uint64
	for i := 0; i < 6; i++ {
		giveSym, giveKey, wantKey := "OBOL", obol, drachma
		if i%2 == 1 {
			giveSym, giveKey, wantKey = "DRACHMA", drachma, obol
		}
		_, slot := kylix.NextSlot(traders[i])
		testing.SetRealm(testing.NewUserRealm(traders[i]))
		// Exact approval: the allowance is used up and deleted by the transfer.
		kylixdemo.Approve(cross(cur), giveSym, slot, 50)
		ids[i] = kylix.PostIntent(cross(cur), "fungible", giveKey, "", 50, "fungible", wantKey, "", 50, 0)
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
// gno.land/r/nt/grc20reg/v0: 0
// gno.land/r/nym-kylix000/kylix: -3186
// gno.land/r/nym-kylix000/kylix/filetests/z_review2_exact_storage: 0
// gno.land/r/nym-kylix000/kylixdemo: 553
