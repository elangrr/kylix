// PKGPATH: gno.land/r/nym-kylix000/kylix/filetests/z_review4_realm_self_item
package z_review4_realm_self_item

// Review 4, Item 1: Check whether a collection realm posting an item of ITS OWN
// collection (calling kylix.PostIntent(cross(cur), "item", self, ...) which in
// turn calls back into self's non-crossing OwnerFn/ApprovedFn) succeeds under
// Gno v1.8.0 interrealm rules.

import (
	"testing"

	"gno.land/r/nym-kylix000/kylix"
	"gno.land/r/nym-kylix000/kylixdemo"
)

var (
	selfPath string
	owners   = map[string]address{}
	approved = map[string]address{}
)

func init(cur realm) {
	selfPath = cur.PkgPath()
	kylix.RegisterItem(cross(cur), "SelfColl", Move, OwnerOf)
	kylix.RegisterApprovalCheck(cross(cur), Approved)
	owners["self-1"] = cur.Address()
}

func Move(cur realm, from, to address, itemID string) error {
	owners[itemID] = to
	delete(approved, itemID)
	return nil
}

func OwnerOf(id kylix.ItemID) address {
	return owners[string(id)]
}

func Approved(id kylix.ItemID, spender address) bool {
	return approved[string(id)] == spender && spender != ""
}

func main(cur realm) {
	_, slot := kylix.NextSlot(cur.Address())
	approved["self-1"] = slot
	id := kylix.PostIntent(cross(cur), "item", selfPath, "self-1", 0, "fungible", kylixdemo.TokenKey("OBOL"), "", 10, 0)
	println("posted:", id)
	// Also test defer/recover cannot catch a cross-realm panic from PostIntent.
	recovered := false
	func() {
		defer func() {
			if recover() != nil {
				recovered = true
			}
		}()
		kylix.PostIntent(cross(cur), "item", selfPath, "missing", 0, "fungible", kylixdemo.TokenKey("OBOL"), "", 10, 0)
	}()
	println("recovered:", recovered)
	_ = testing.SetRealm
}

// Error:
// kylix: give: the offer could not settle now (owner no longer holds item missing); approve first, then post
