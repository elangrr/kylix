// PKGPATH: gno.land/r/nym-kylix000/kylix/filetests/notify_indirect
package notify_indirect

// Review 2, Part 2 item 5: EnableNotifications reached through another
// realm, even in a transaction the namespace owner signed, is refused, so a
// realm the owner calls cannot claim Kylix's notification handle. (Session
// keys cannot be simulated by gno test; they are refused by gnotif before
// this check, which the local-chain rehearsal exercises.)

import (
	"testing"

	"gno.land/p/nt/testutils/v0"
	"gno.land/r/nym-gfanton001/gnotif/v1"
	"gno.land/r/nym-kylix000/kylix"
	"gno.land/r/sys/names"
	"gno.land/r/sys/users"
)

const (
	namesAdmin = address("g1skl80cuz8zq3lul9pgz5pc35l2pfzgxgfpsqkx")
	kylixPath  = "gno.land/r/nym-kylix000/kylix"
)

var owner = testutils.TestAddress("kylixowner")

func init(cur realm) {
	testing.SetHeight(0)
	testing.SetRealm(testing.NewUserRealm(owner))
	if err := users.RegisterUser(cross(cur), "nym-kylix000", owner); err != nil {
		panic(err)
	}
	testing.SetHeight(10)
	testing.SetRealm(testing.NewUserRealm(namesAdmin))
	names.Enable(cross(cur))
}

func main(cur realm) {
	// The owner signs, but the call reaches Kylix from this realm.
	testing.SetOriginCaller(owner)
	testing.SetRealm(testing.NewCodeRealm("gno.land/r/nym-kylix000/kylix/filetests/notify_indirect"))
	r := revive(func() {
		kylix.EnableNotifications(cross(cur))
	})
	println("indirect_rejected:", r)
	println("no_handle:", gnotif.Active(kylixPath) == "")
}

// Output:
// indirect_rejected: the dapp was not entered directly by its namespace owner; entered from gno.land/r/nym-kylix000/kylix/filetests/notify_indirect
// no_handle: true
