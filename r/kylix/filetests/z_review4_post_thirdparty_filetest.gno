// PKGPATH: gno.land/r/r4evil/postbomb
package postbomb

// Security review 4, R4-1, inverted. This realm is a third-party collection
// (outside Kylix's namespace) whose owner and approval functions write 4 KB
// each into its own storage. Posting an offer of its item used to run them,
// billing the poster for storage the collection could later free and
// collect. Posting now runs no third-party code: nothing is written here,
// and the offer is stored unchecked (it is checked when someone settles).

import (
	"strings"
	"testing"

	"gno.land/p/nt/testutils/v0"
	"gno.land/r/nym-kylix000/kylix"
	"gno.land/r/nym-kylix000/kylixdemo"
)

var (
	victim = testutils.TestAddress("r4-post-victim")
	bloat  []string
)

func init(cur realm) {
	kylix.RegisterItem(cross(cur), "Post Bomb", Move, OwnerOf)
	kylix.RegisterApprovalCheck(cross(cur), Approved)
}

func Move(cur realm, from, to address, itemID string) error { return nil }

func OwnerOf(id kylix.ItemID) address {
	bloat = append(bloat, strings.Repeat("O", 4096))
	return victim
}

func Approved(id kylix.ItemID, spender address) bool {
	bloat = append(bloat, strings.Repeat("A", 4096))
	return true
}

func main(cur realm) {
	testing.SetRealm(testing.NewUserRealm(victim))
	id := kylix.PostIntent(cross(cur), "item", "gno.land/r/r4evil/postbomb", "bomb-1", 0, "fungible", kylixdemo.TokenKey("OBOL"), "", 100, 0)
	c, _ := kylix.GetCollection("gno.land/r/r4evil/postbomb")
	println("posted:", id, "official:", c.Official, "callbacks run:", len(bloat))
}

// Output:
// posted: 1 official: false callbacks run: 0
