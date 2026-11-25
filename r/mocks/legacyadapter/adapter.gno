// Package legacyadapter is a TEST-ONLY Kylix adapter for the test-only
// legacy721 collection. It has exactly the shape of the real adapters under
// r/adapters, so this repo's tests can exercise the pattern without
// third-party source. Never deploy it.
package legacyadapter

import (
	"chain"
	"errors"

	"gno.land/r/nym-kylix000/kylix"
	"gno.land/r/nym-kylix000/mocks/legacy721"
)

const target = "gno.land/r/nym-kylix000/mocks/legacy721"

var selfPath string

func init(cur realm) {
	selfPath = cur.PkgPath()
	kylix.RegisterAdapter(cross(cur), target, "Legacy Collection", Move, OwnerOf)
	kylix.RegisterApprovalCheck(cross(cur), Approved)
}

// SpenderFor is the address an owner approves in legacy721 for the offer
// whose Kylix slot is slot. kylix.ApproveTarget returns the same address.
func SpenderFor(slot address) address {
	return chain.DerivePkgSubAddr(selfPath, "k/"+slot.String())
}

// Move crosses into legacy721 as k/<caller>. Called by Kylix, the caller is
// the offer's slot, so only the approval made for that one offer applies.
// Called by anyone else, it can only spend approvals made to k/<them>.
//
// Only a single-item approval of that address is used (Kylix's rule: an
// approval Kylix uses must be consumed by the move).
func Move(cur realm, from, to address, itemID string) error {
	if legacy721.GetApproved(itemID) != SpenderFor(cur.Previous().Address()) {
		return errors.New("legacy adapter: approve this offer's address for the item itself")
	}
	sub := cur.Sub("k/" + cur.Previous().Address().String())
	legacy721.TransferFrom(cross(sub), from, to, itemID)
	return nil
}

// OwnerOf is the OwnerFn registered with Kylix.
func OwnerOf(id kylix.ItemID) address { return legacy721.OwnerOf(string(id)) }

// Approved is the ApprovedFn registered with Kylix.
// Only a single-item approval counts; see Move.
func Approved(id kylix.ItemID, spender address) bool {
	a := legacy721.GetApproved(string(id))
	return a != "" && a == spender
}
