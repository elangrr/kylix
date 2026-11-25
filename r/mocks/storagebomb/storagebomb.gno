// Package storagebomb is a TEST-ONLY hostile collection from security
// review 1 (finding 2). Each of its functions appends 4 KB to its own
// storage, which the chain bills to whoever sent the transaction; the
// attacker frees it later and collects that deposit. Its functions do not
// refuse anything: the attack is the bill, not a failure. Never deploy it.
package storagebomb

import (
	"strings"

	"gno.land/r/nym-kylix000/kylix"
)

var (
	bloat  []string
	holder address
)

func init(cur realm) {
	kylix.RegisterItem(cross(cur), "StorageBomb", Move, OwnerOf)
	kylix.RegisterApprovalCheck(cross(cur), Approved)
}

// SetHolder sets who owns every item. Unauthenticated: test only.
func SetHolder(cur realm, a address) { holder = a }

// BloatBytes is how much the collection's functions have stored.
func BloatBytes() int {
	n := 0
	for _, s := range bloat {
		n += len(s)
	}
	return n
}

// Drain frees what was stored, returning the deposit to the caller.
func Drain(cur realm) { bloat = nil }

func Move(cur realm, from, to address, itemID string) error {
	bloat = append(bloat, strings.Repeat("M", 4096))
	holder = to
	return nil
}

// OwnerOf is called without crossing, yet runs with this realm's storage
// authority (borrow rule #1), so it can store too.
func OwnerOf(id kylix.ItemID) address {
	bloat = append(bloat, strings.Repeat("O", 4096))
	return holder
}

func Approved(id kylix.ItemID, spender address) bool {
	bloat = append(bloat, strings.Repeat("A", 4096))
	return true
}
