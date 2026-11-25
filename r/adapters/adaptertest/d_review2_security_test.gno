package adaptertest

import (
	"testing"

	"gno.land/p/nt/testutils/v0"
	"gno.land/p/nt/uassert/v0"
	nsnftadapter "gno.land/r/nym-kylix000/adapters/nsnft"
	sinopia3adapter "gno.land/r/nym-kylix000/adapters/sinopia3"
	"gno.land/r/nym-kylix000/kylix"
	"gno.land/r/nym-kylix000/kylixdemo"
	"gno.land/r/nym-kylix000/mocks/hostile"
	"gno.land/r/nym-mnsrehearsal001/nsnft/v2"
)

// The demonstration tests of security review 2 (docs/research/
// security-review-2.md), inverted: each passes now that its hole is closed.

// N1: a real MNS v2 token id ("label*domain") passes Kylix's id rule; the
// offer is refused only because the name has no lease (posting rule).
func TestReview2_MNSRealTokenIDAccepted(cur realm, t *testing.T) {
	seller := testutils.TestAddress("r2-mns-seller")
	testing.SetRealm(testing.NewCodeRealm(nsRegistry))
	nsnft.Mint(cross(cur), seller, "bob*gnoland", 0)
	nsApprove(cur, seller, nextTarget(seller, nsnftKey), "bob*gnoland")
	uassert.AbortsContains(t, cur, "cannot be moved by", func() {
		testing.SetRealm(testing.NewUserRealm(seller))
		kylix.PostIntent(cross(cur), "item", nsnftKey, "bob*gnoland", 0,
			"fungible", kylixdemo.TokenKey("OBOL"), "", 100, 0)
	})
	uassert.AbortsContains(t, cur, "could not settle now", func() { postItem(cur, seller, nsnftKey, "bob*gnoland", 100) })
}

// N1: a name with no valid lease (here, none at all; on chain, an expired
// one ten years on) is not approved, cannot be offered and does not move.
func TestReview2_MNSAdapterChecksTheLease(cur realm, t *testing.T) {
	seller := testutils.TestAddress("r2-mns-exp-seller")
	testing.SetRealm(testing.NewCodeRealm(nsRegistry))
	nsnft.Mint(cross(cur), seller, "expired*gnoland", 0)
	testing.SkipHeights(100_000_000)
	nsApprove(cur, seller, nextTarget(seller, nsnftKey), "expired*gnoland")

	uassert.False(t, nsnftadapter.Approved(kylix.ItemID("expired*gnoland"), nextTarget(seller, nsnftKey)))
	uassert.AbortsContains(t, cur, "cannot be moved by", func() { postItem(cur, seller, nsnftKey, "expired*gnoland", 100) })
	err := hostile.Direct(cross(cur), nsnftadapter.Move, seller, mallory, "expired*gnoland")
	uassert.ErrorContains(t, err, "no record of expired*gnoland")
	uassert.Equal(t, seller.String(), nsnft.OwnerOf("expired*gnoland").String())
}

// Review 1 finding 4 still holds: malformed or out-of-range Sinopia3 ids
// make no adapter function panic.
func TestReview2_Sinopia3PoisonIDsHold(cur realm, t *testing.T) {
	poisons := []string{
		"999999/1", "01/1", "1/0", "1/01", "0/1", "abc/1", "1/abc", "1/", "/1",
		"1/9999999999999999999",
		"999999999999999999/1",
	}
	for _, id := range poisons {
		uassert.Equal(t, address(""), sinopia3adapter.OwnerOf(kylix.ItemID(id)), "OwnerOf "+id)
		uassert.False(t, sinopia3adapter.Approved(kylix.ItemID(id), mallory), "Approved "+id)
		uassert.AbortsContains(t, cur, "owner no longer holds item", func() { postItem(cur, mallory, sinopiaKey, id, 1) }, id)
	}
}
