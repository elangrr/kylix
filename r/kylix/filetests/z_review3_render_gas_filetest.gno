// PKGPATH: gno.land/r/nym-kylix000/kylix/filetests/z_review3_render_gas
package z_review3_render_gas

// Renders Render(""). The Gas figure covers the whole file, init included;
// subtract z_review3_gas_base, which has the same init, to get the page's
// own cost.

import (
	"strconv"
	"strings"
	"testing"

	"gno.land/p/nt/testutils/v0"
	"gno.land/r/nym-kylix000/kylix"
	"gno.land/r/nym-kylix000/kylixdemo"
	"gno.land/r/sys/users"
)

// Worst case for the on-page ring search after security review 3 (R3-2).
// Newest first, the book holds:
//   - 50 dead token offers from 50 accounts with usernames (posted approved,
//     then revoked): the open offers table's 50 rows, each checked and skipped;
//   - 300 offers from one account: 8 are counted (4 kept, ready), the other
//     292 read and passed over;
//   - 6 ready 3-offer rings (18 offers, each with a relic whose owner and
//     approval are verified in the official demo collection), and 24 ready
//     offers that almost match and burn search steps, from 42 accounts with
//     usernames.
// So the window reads 392 offers, counts 100 and keeps 46; the home page
// draws 6 rings.

var (
	named  [92]address
	spam   = testutils.TestAddress("w3-spam")
	target uint64
)

// giveTok approves exactly amount for who's next offer and posts it.
func giveTok(cur realm, who address, sym string, amount int64, wantKind, wantKey, wantID string, wantMin int64) uint64 {
	_, slot := kylix.NextSlot(who)
	testing.SetRealm(testing.NewUserRealm(who))
	kylixdemo.Approve(cross(cur), sym, slot, amount)
	testing.SetRealm(testing.NewUserRealm(who))
	return kylix.PostIntent(cross(cur), "fungible", kylixdemo.TokenKey(sym), "", amount, wantKind, wantKey, wantID, wantMin, 0)
}

func init(cur realm) {
	obol, drachma, relics := kylixdemo.TokenKey("OBOL"), kylixdemo.TokenKey("DRACHMA"), kylixdemo.CollectionKey()
	testing.SetHeight(0)
	for i := range named {
		named[i] = testutils.TestAddress("w3_" + strconv.Itoa(i))
		testing.SetRealm(testing.NewUserRealm(named[i]))
		_ = users.RegisterUser(cross(cur), "w3user_"+strconv.Itoa(i), named[i])
	}
	testing.SetHeight(100)
	relicOf := map[address]string{}
	for _, a := range append(named[:], spam) {
		testing.SetRealm(testing.NewUserRealm(a))
		relicOf[a] = kylixdemo.Claim(cross(cur))
		testing.SkipHeights(1) // one claim per block
	}

	// Oldest: 6 rings and 24 near-misses, from named[50:92].
	for r := 0; r < 6; r++ {
		uA, uB, uC := named[50+r*3], named[51+r*3], named[52+r*3]
		id := relicOf[uA]
		_, slot := kylix.NextSlot(uA)
		testing.SetRealm(testing.NewUserRealm(uA))
		kylixdemo.ApproveRelic(cross(cur), slot, id)
		testing.SetRealm(testing.NewUserRealm(uA))
		kylix.PostIntent(cross(cur), "item", relics, id, 0, "fungible", obol, "", 1, 0)
		t := giveTok(cur, uB, "DRACHMA", 1, "item", relics, id, 0)
		if r == 0 {
			target = t
		}
		giveTok(cur, uC, "OBOL", 1, "fungible", drachma, "", 1)
	}
	for i := 68; i < 92; i++ {
		if i%2 == 0 {
			giveTok(cur, named[i], "OBOL", 1, "fungible", drachma, "", 999999)
		} else {
			giveTok(cur, named[i], "DRACHMA", 1, "fungible", obol, "", 999999)
		}
	}
	// 300 offers from one account.
	for i := 0; i < 300; i++ {
		giveTok(cur, spam, "OBOL", 1, "fungible", drachma, "", 999999)
	}
	// Newest: 50 offers gone dead (approval revoked after posting).
	for i := 0; i < 50; i++ {
		_, slot := kylix.NextSlot(named[i])
		giveTok(cur, named[i], "OBOL", 1, "fungible", drachma, "", 1)
		testing.SetRealm(testing.NewUserRealm(named[i]))
		kylixdemo.Approve(cross(cur), "OBOL", slot, 0)
	}
}

func main(cur realm) {
	home := kylix.Render("")
	println("svgs:", strings.Count(home, "data:image/svg+xml;base64,"))
}

// Output:
// svgs: 6

// Gas:
// 3779046929
