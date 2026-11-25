package adaptertest

import (
	"chain"
	"strings"
	"testing"

	"gno.land/p/nt/testutils/v0"
	"gno.land/p/nt/uassert/v0"
	nsnftadapter "gno.land/r/nym-kylix000/adapters/nsnft"
	"gno.land/r/nym-kylix000/kylix"
	"gno.land/r/nym-kylix000/mocks/hostile"
	"gno.land/r/nym-mnsrehearsal001/nsdata/v2"
	"gno.land/r/nym-mnsrehearsal001/nslogic/v2"
	"gno.land/r/nym-mnsrehearsal001/nsnft/v2"
)

const (
	nsnftKey   = "gno.land/r/nym-kylix000/adapters/nsnft"
	nsRegistry = "gno.land/r/nym-mnsrehearsal001/nsdata/v2"
)

var nAlice, nBob = testutils.TestAddress("n-alice"), testutils.TestAddress("n-bob")

func nsApprove(cur realm, owner, spender address, name string) {
	testing.SetRealm(testing.NewUserRealm(owner))
	nsnft.Approve(cross(cur), spender, name)
}

func nsHold(cur realm, name string, on bool) {
	testing.SetRealm(testing.NewCodeRealm(nsRegistry))
	nsnft.SetLock(cross(cur), name, 0, on)
}

// What this harness can and cannot show about MNS.
//
// A user gets a name by paying nslogic, which writes the lease into the
// registry (nsdata/v2) and has the registry mint the token in nsdata's
// name. Under `gno test` nsdata has no deployer, so it has no admin, can
// trust no logic realm, and holds no leases: no name here can be registered
// the way a user does. A token minted directly in the registry's name
// (the shortcut the first version of this test took) therefore has no
// lease behind it, and the adapter must refuse it. The positive path, a
// name registered and paid for through nslogic and then traded, runs on a
// local chain: scripts/local-demo.sh registers one and lists it
// (scripts/README.md).

// Review 2 finding N1: real MNS token ids are "<label>*<domain>", and
// Kylix accepts them; but a token with no lease in the registry (here, the
// only kind the harness can make) cannot be offered: posting runs the
// adapter's approval check, which refuses it. Move refuses it too.
func TestNsnftUnleasedNameCannotBePosted(cur realm, t *testing.T) {
	testing.SetRealm(testing.NewCodeRealm(nsRegistry))
	nsnft.Mint(cross(cur), nAlice, "alice*gnoland", 0)
	nsApprove(cur, nAlice, nextTarget(nAlice, nsnftKey), "alice*gnoland")
	uassert.Equal(t, nAlice.String(), nsnftadapter.OwnerOf(kylix.ItemID("alice*gnoland")).String())
	uassert.Equal(t, "the registry has no record of alice*gnoland", nsnftadapter.Unmovable("alice*gnoland"))
	uassert.False(t, nsnftadapter.Approved(kylix.ItemID("alice*gnoland"), nextTarget(nAlice, nsnftKey)))
	uassert.AbortsContains(t, cur, "item alice*gnoland cannot be moved by", func() {
		postItem(cur, nAlice, nsnftKey, "alice*gnoland", 100)
	})
	err := hostile.Direct(cross(cur), nsnftadapter.Move, nAlice, mallory, "alice*gnoland")
	uassert.ErrorContains(t, err, "no record of alice*gnoland")
	uassert.Equal(t, nAlice.String(), nsnft.OwnerOf("alice*gnoland").String())
}

// Malformed ids and registry holds are refused before anything else, and
// nothing panics.
func TestNsnftRefusals(cur realm, t *testing.T) {
	for _, id := range []string{"alice", "*gnoland", "alice*", "a*b*c", "", "*"} {
		uassert.Equal(t, "an MNS item id is <label>*<domain>", nsnftadapter.Unmovable(id), id)
		uassert.False(t, nsnftadapter.Approved(kylix.ItemID(id), mallory), id)
		uassert.Equal(t, address(""), nsnftadapter.OwnerOf(kylix.ItemID(id)), id)
	}

	testing.SetRealm(testing.NewCodeRealm(nsRegistry))
	nsnft.Mint(cross(cur), nAlice, "held*gnoland", 0)
	nsHold(cur, "held*gnoland", true)
	uassert.True(t, strings.Contains(nsnftadapter.Unmovable("held*gnoland"), "the registry holds held*gnoland"))
	nsHold(cur, "held*gnoland", false)

	// The adapter's minimum lease outlasts the longest offer.
	uassert.True(t, nsnftadapter.MinLeaseLeft > kylix.MaxExpiryBlocks*5, "lease floor shorter than an offer")
}

// Why no name is registered here: under `gno test` the registry has no
// deployer, hence no admin, so it trusts no logic realm, and nslogic's
// RegisterName cannot write a lease. (Importing nslogic also makes
// `make deps` fetch it for the local demo, which registers a name through
// it.)
func TestNsnftRegistryUnwiredUnderTest(t *testing.T) {
	uassert.Equal(t, address(""), nsdata.GetAdmin())
	uassert.False(t, nsdata.IsTrustedLogic(chain.PackageAddress("gno.land/r/nym-mnsrehearsal001/nslogic/v2")))
	uassert.True(t, nslogic.NamePrice("gnoland", "alice") > 0)
}
