// Package legacy721 is a TEST-ONLY collection that knows nothing of Kylix,
// shaped like the existing collections the adapters target (GnoSwap GNFT,
// MNS nsnft): Approve and TransferFrom act for cur.Previous(), and the
// collection can be paused, as Sinopia3's lock hook or an MNS registry hold
// veto moves. Never deploy it: Mint and SetPaused are unauthenticated.
package legacy721

import (
	"gno.land/p/nt/grc721/v0"
)

var (
	tok    *grc721.Token
	led    *grc721.PrivateLedger
	paused bool
)

func init(cur realm) {
	tok, led = grc721.NewToken("Legacy Collection", "LEGACY", 1, cur)
}

// Mint creates an item. Unauthenticated: test only.
func Mint(cur realm, to address, id string) { check(led.Mint(to, grc721.TokenID(id))) }

// SetPaused stops or resumes every transfer.
func SetPaused(cur realm, p bool) { paused = p }

// Approve lets spender move one of the caller's items.
func Approve(cur realm, spender address, id string) {
	check(led.CallerTeller().Approve(0, cur, spender, grc721.TokenID(id)))
}

// SetApprovalForAll lets operator move all of the caller's items.
func SetApprovalForAll(cur realm, operator address, approved bool) {
	check(led.CallerTeller().SetApprovalForAll(0, cur, operator, approved))
}

// TransferFrom moves an item; the caller must own it or be approved.
func TransferFrom(cur realm, from, to address, id string) {
	if paused {
		panic("legacy721: transfers are paused")
	}
	check(led.CallerTeller().TransferFrom(0, cur, from, to, grc721.TokenID(id)))
}

// OwnerOf returns the owner of an item, or the empty address.
func OwnerOf(id string) address {
	owner, err := tok.OwnerOf(grc721.TokenID(id))
	if err != nil {
		return ""
	}
	return owner
}

// GetApproved returns the address approved for an item, or the empty address.
func GetApproved(id string) address {
	a, err := tok.GetApproved(grc721.TokenID(id))
	if err != nil {
		return ""
	}
	return a
}

// IsApprovedForAll reports operator approval.
func IsApprovedForAll(owner, operator address) bool { return tok.IsApprovedForAll(owner, operator) }

func check(err error) {
	if err != nil {
		panic(err)
	}
}
