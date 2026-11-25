// PKGPATH: gno.land/r/nym-kylix000/kylix/filetests/z_review2_surplus_refused
package z_review2_surplus_refused

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
	// Security review 2, N3 (realm side), the review's adversarial ring: six
	// fresh receivers and surplus approvals (+1), so no allowance entry is
	// deleted and the settler would pay for six new balance entries with no
	// offsetting refund (measured by the review: kylix -3,180 B, kylixdemo
	// +12,348 B). Kylix now refuses an allowance that is not exactly the
	// offered amount, before anything moves.
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
		// Posting requires the exact approval, so the attacker posts with it
		// and then raises it to a surplus (+1): TransferFrom would update that
		// allowance instead of deleting it.
		kylixdemo.Approve(cross(cur), giveSym, slot, 50)
		testing.SetRealm(testing.NewUserRealm(traders[i]))
		ids[i] = kylix.PostIntent(cross(cur), "fungible", giveKey, "", 50, "fungible", wantKey, "", 50, 0)
		testing.SetRealm(testing.NewUserRealm(traders[i]))
		kylixdemo.Approve(cross(cur), giveSym, slot, 51)
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
// kylix: leg 0 (offer 13): slot g1n6s24y60g8xum7c403satkv0wgpsje5jvwmgn4 may spend 51 of gno.land/r/nym-kylix000/kylixdemo.OBOL; approve exactly 50, the amount this offer gives
