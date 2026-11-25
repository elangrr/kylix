package nsnft

import (
	"testing"

	"gno.land/p/nt/testutils/v0"
	"gno.land/p/nt/uassert/v0"
	"gno.land/r/nym-mnsrehearsal001/nsnft/v2"
)

// Review 3, R3-4: under `gno test` the registry holds no leases, so the
// lease decision is tested here directly, every branch and the boundary.
func TestLeaseProblem(t *testing.T) {
	const now = int64(1_800_000_000)
	const tid = "alice*gnoland"
	cases := []struct {
		exists, frozen, valid bool
		expires               int64
		want                  string
	}{
		{false, false, false, 0, "the registry has no record of alice*gnoland"},
		{false, true, true, now + 400*86400, "the registry has no record of alice*gnoland"},
		{true, true, true, now + 400*86400, "alice*gnoland is frozen"},
		{true, false, false, now - 1, "the lease on alice*gnoland has expired"},
		{true, false, false, now + 400*86400, "the lease on alice*gnoland has expired"}, // the registry's word wins
		{true, false, true, now + MinLeaseLeft - 1, "the lease on alice*gnoland has less than 31 days left, so it could end before an offer expires; renew it first"},
		{true, false, true, now + 1, "the lease on alice*gnoland has less than 31 days left, so it could end before an offer expires; renew it first"},
		{true, false, true, now + MinLeaseLeft, ""}, // exactly 31 days passes
		{true, false, true, now + MinLeaseLeft + 1, ""},
		{true, false, true, now + 365*86400, ""},
	}
	for i, c := range cases {
		uassert.Equal(t, c.want, leaseProblem(tid, c.exists, c.frozen, c.valid, c.expires, now), "case "+string(rune('a'+i)))
	}
	uassert.Equal(t, 31*86400, MinLeaseLeft)
}

func TestSplitTokenID(t *testing.T) {
	for _, bad := range []string{"", "*", "alice", "*gnoland", "alice*", "a*b*c"} {
		_, _, ok := splitTokenID(bad)
		uassert.False(t, ok, bad)
	}
	l, d, ok := splitTokenID("alice*gnoland")
	uassert.True(t, ok)
	uassert.Equal(t, "alice", l)
	uassert.Equal(t, "gnoland", d)
}

// Review 3, R3-1: only an approval of the one name counts; an approval for
// all names does not, because the transfer leaves it in place.
func TestSingleApprovalOnly(cur realm, t *testing.T) {
	owner := testutils.TestAddress("solo-owner")
	spender := testutils.TestAddress("solo-spender")
	testing.SetRealm(testing.NewCodeRealm(registry))
	nsnft.Mint(cross(cur), owner, "solo*gnoland", 0)
	testing.SetRealm(testing.NewUserRealm(owner))
	nsnft.SetApprovalForAll(cross(cur), spender, true)
	uassert.False(t, singleApproval("solo*gnoland", spender), "approval for all counted")
	testing.SetRealm(testing.NewUserRealm(owner))
	nsnft.Approve(cross(cur), spender, "solo*gnoland")
	uassert.True(t, singleApproval("solo*gnoland", spender))
	uassert.False(t, singleApproval("solo*gnoland", owner))
	uassert.False(t, singleApproval("none*gnoland", ""), "empty approval matched an empty spender")
}
