// PKGPATH: gno.land/r/nym-kylix000/kylix/filetests/z_storage_post
package z_storage_post

import (
	"testing"

	"gno.land/p/nt/testutils/v0"
	"gno.land/r/nym-kylix000/kylix"
	"gno.land/r/nym-kylix000/kylixdemo"
)

var alice = testutils.TestAddress("alice")

func init(cur realm) {
	testing.SetRealm(testing.NewUserRealm(alice))
	kylixdemo.Claim(cross(cur))
	// First offer pays one-time costs (the owner's nonce entry, tree growth).
	// Posting requires the offer to be deliverable: approve first.
	_, slot := kylix.NextSlot(alice)
	testing.SetRealm(testing.NewUserRealm(alice))
	kylixdemo.Approve(cross(cur), "OBOL", slot, 100)
	testing.SetRealm(testing.NewUserRealm(alice))
	kylix.PostIntent(cross(cur), "fungible", kylixdemo.TokenKey("OBOL"), "", 100, "fungible", kylixdemo.TokenKey("DRACHMA"), "", 90, 0)
}

func main(cur realm) {
	_, slot := kylix.NextSlot(alice)
	testing.SetRealm(testing.NewUserRealm(alice))
	kylixdemo.Approve(cross(cur), "OBOL", slot, 100)
	testing.SetRealm(testing.NewUserRealm(alice))
	id := kylix.PostIntent(cross(cur), "fungible", kylixdemo.TokenKey("OBOL"), "", 100, "item", kylixdemo.CollectionKey(), "relic-1", 0, 0)
	println(id)
}

// Output:
// 2
