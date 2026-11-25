// PKGPATH: gno.land/r/nym-kylix000/kylix/filetests/notify_enable
package notify_enable

// Verifies EnableNotifications authorization via gnotif + r/sys/names:
// - refuses a caller who is not the namespace owner
// - succeeds when called directly by the namespace owner
// - refuses a second call while the handle is already live

import (
	"testing"

	"gno.land/r/nym-gfanton001/gnotif/v1"
	"gno.land/r/nym-kylix000/kylix"
	"gno.land/r/sys/names"
	"gno.land/r/sys/users"
	"gno.land/p/nt/testutils/v0"
)

const (
	namesAdmin = address("g1skl80cuz8zq3lul9pgz5pc35l2pfzgxgfpsqkx")
	kylixPath  = "gno.land/r/nym-kylix000/kylix"
)

var (
	owner    = testutils.TestAddress("kylixowner")
	stranger = testutils.TestAddress("stranger")
)

func init(cur realm) {
	// Register nym-kylix000 at genesis height 0, then enable r/sys/names.
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
	// 1. Non-owner calling EnableNotifications directly must abort.
	testing.SetOriginCaller(stranger)
	testing.SetRealm(testing.NewUserRealm(stranger))
	r := revive(func() {
		kylix.EnableNotifications(cross(cur))
	})
	println("stranger_rejected:", r != nil)

	// 2. Namespace owner calling EnableNotifications directly succeeds.
	testing.SetOriginCaller(owner)
	testing.SetRealm(testing.NewUserRealm(owner))
	kylix.EnableNotifications(cross(cur))
	active := gnotif.Active(kylixPath)
	println("active_nonempty:", active != "")

	// 3. Second call while handle is live is refused by gnotif.
	r2 := revive(func() {
		kylix.EnableNotifications(cross(cur))
	})
	println("duplicate_rejected:", r2 != nil)
}

// Output:
// stranger_rejected: true
// active_nonempty: true
// duplicate_rejected: true
