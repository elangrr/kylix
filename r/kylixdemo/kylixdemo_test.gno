package kylixdemo

import (
	"strconv"
	"strings"
	"testing"

	"gno.land/p/nt/testutils/v0"
	"gno.land/p/nt/uassert/v0"
	"gno.land/r/nt/grc20reg/v0"
	"gno.land/r/nym-kylix000/kylix"
)

func claimAs(cur realm, who address) string {
	testing.SetRealm(testing.NewUserRealm(who))
	return Claim(cross(cur))
}

func claimAsRealm(cur realm, pkgPath string) string {
	testing.SetRealm(testing.NewCodeRealm(pkgPath))
	return Claim(cross(cur))
}

func moveAsRealm(cur realm, pkgPath string, from, to address, id string) error {
	testing.SetRealm(testing.NewCodeRealm(pkgPath))
	return MoveRelic(cross(cur), from, to, id)
}

func TestSetup(t *testing.T) {
	uassert.True(t, kylix.IsCollection(CollectionKey()))
	uassert.Equal(t, CollectionName, kylix.CollectionName(CollectionKey()))
	uassert.Equal(t, CollectionKey()+".OBOL", TokenKey("OBOL"))
	uassert.Equal(t, CollectionKey()+".DRACHMA", TokenKey("DRACHMA"))
	uassert.NotNil(t, grc20reg.Get(TokenKey("OBOL")))
	uassert.NotNil(t, grc20reg.Get(TokenKey("DRACHMA")))
	uassert.PanicsContains(t, nil, "unknown token", func() { TokenKey("GNOT") })
}

func TestClaimAndCooldown(cur realm, t *testing.T) {
	alice := testutils.TestAddress("demo-alice")
	id := claimAs(cur, alice)
	uassert.Equal(t, int64(ClaimTokens), BalanceOf("OBOL", alice))
	uassert.Equal(t, int64(ClaimTokens), BalanceOf("DRACHMA", alice))
	uassert.Equal(t, alice.String(), OwnerOfRelic(id).String())

	uassert.AbortsContains(t, cur, "already claimed", func() { claimAs(cur, alice) })
	testing.SkipHeights(ClaimCooldownBlocks - 1)
	uassert.AbortsContains(t, cur, "already claimed", func() { claimAs(cur, alice) })
	testing.SkipHeights(1)
	id2 := claimAs(cur, alice)
	uassert.NotEqual(t, id, id2)
	uassert.Equal(t, int64(2*ClaimTokens), BalanceOf("OBOL", alice))

	uassert.AbortsContains(t, cur, "only users can claim", func() { claimAsRealm(cur, "gno.land/r/test/bot") })
}

func TestClaimsPerBlock(cur realm, t *testing.T) {
	testing.SkipHeights(1)
	for i := 0; i < MaxClaimsPerBlock; i++ {
		claimAs(cur, testutils.TestAddress("burst"+strconv.Itoa(i)))
	}
	late := testutils.TestAddress("burst-late")
	uassert.AbortsContains(t, cur, "faucet is busy", func() { claimAs(cur, late) })
	testing.SkipHeights(1)
	claimAs(cur, late)
	uassert.Equal(t, int64(ClaimTokens), BalanceOf("OBOL", late))
}

func TestMoveRelicNeedsApproval(cur realm, t *testing.T) {
	owner := testutils.TestAddress("demo-owner")
	const thief = "gno.land/r/test/thief"
	thiefAddr := testing.NewCodeRealm(thief).Address()
	id := claimAs(cur, owner)

	err := moveAsRealm(cur, thief, owner, thiefAddr, id)
	uassert.ErrorContains(t, err, "approve this offer's address for relic "+id+" itself")
	uassert.Equal(t, owner.String(), OwnerOfRelic(id).String())

	// Security review 3, R3-1: an approval for all relics is not used.
	testing.SetRealm(testing.NewUserRealm(owner))
	ApproveAllRelics(cross(cur), thiefAddr, true)
	uassert.False(t, RelicApproved(kylix.ItemID(id), thiefAddr))
	uassert.ErrorContains(t, moveAsRealm(cur, thief, owner, thiefAddr, id), "an approval for all relics is not used")
	uassert.Equal(t, owner.String(), OwnerOfRelic(id).String())

	testing.SetRealm(testing.NewUserRealm(owner))
	ApproveRelic(cross(cur), thiefAddr, id)
	uassert.True(t, RelicApproved(kylix.ItemID(id), thiefAddr))
	uassert.NoError(t, moveAsRealm(cur, thief, owner, thiefAddr, id))
	uassert.Equal(t, thiefAddr.String(), OwnerOfRelic(id).String())
	uassert.Equal(t, address(""), RelicOwner(kylix.ItemID("relic-does-not-exist")))
}

func TestTokenEntryPoints(cur realm, t *testing.T) {
	a := testutils.TestAddress("demo-a")
	b := testutils.TestAddress("demo-b")
	testing.SkipHeights(1)
	claimAs(cur, a)
	testing.SetRealm(testing.NewUserRealm(a))
	Transfer(cross(cur), "DRACHMA", b, 250)
	uassert.Equal(t, int64(250), BalanceOf("DRACHMA", b))
	testing.SetRealm(testing.NewUserRealm(a))
	Approve(cross(cur), "OBOL", b, 40)
	uassert.Equal(t, int64(40), Allowance("OBOL", a, b))
}

func TestRender(t *testing.T) {
	out := Render("")
	uassert.True(t, strings.Contains(out, "Call `Claim`"))
	uassert.True(t, strings.Contains(out, TokenKey("OBOL")))
	uassert.True(t, strings.Contains(out, "| "+CollectionName+" (items) | "+CollectionKey()+" |"))
}
