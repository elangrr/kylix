package adaptertest

import (
	"chain/runtime"
	"strconv"
	"testing"

	"gno.land/p/nt/testutils/v0"
	"gno.land/r/nym-kylix000/kylix"
	"gno.land/r/nym-kylix000/kylixdemo"
)

var (
	mallory = testutils.TestAddress("mallory")
	settler = testutils.TestAddress("settler")
)

// Helpers that switch the caller take cur and call SetRealm themselves;
// testing.SetRealm inside a closure does not reach the closure's crossing
// call. `revive` does not roll back state in tests, so a settlement that
// aborts after Kylix took its lock leaves the lock set: only the last test
// in the package may do that.

func claim(cur realm, who address) {
	testing.SetRealm(testing.NewUserRealm(who))
	kylixdemo.Claim(cross(cur))
}

// postItem posts who's offer of an item under key for at least wantMin
// OBOL. Posting checks that the offer could settle now, so who must hold
// the item and have approved nextTarget(who, key) first.
func postItem(cur realm, who address, key, id string, wantMin int64) uint64 {
	testing.SetRealm(testing.NewUserRealm(who))
	return kylix.PostIntent(cross(cur), "item", key, id, 0, "fungible", kylixdemo.TokenKey("OBOL"), "", wantMin, 0)
}

// buy posts who's offer of amount OBOL for an item, approving its slot.
func buy(cur realm, who address, amount int64, key, id string) uint64 {
	_, slot := kylix.NextSlot(who)
	testing.SetRealm(testing.NewUserRealm(who))
	kylixdemo.Approve(cross(cur), "OBOL", slot, amount)
	return kylix.PostIntent(cross(cur), "fungible", kylixdemo.TokenKey("OBOL"), "", amount, "item", key, id, 0, 0)
}

// postItemExpiring is postItem with an expiry n blocks ahead.
func postItemExpiring(cur realm, who address, key, id string, wantMin, n int64) uint64 {
	testing.SetRealm(testing.NewUserRealm(who))
	return kylix.PostIntent(cross(cur), "item", key, id, 0, "fungible", kylixdemo.TokenKey("OBOL"), "", wantMin, runtime.ChainHeight()+n)
}

func cancelAs(cur realm, who address, id uint64) {
	testing.SetRealm(testing.NewUserRealm(who))
	kylix.CancelIntent(cross(cur), id)
}

func pruneAs(cur realm, who address, id uint64) {
	testing.SetRealm(testing.NewUserRealm(who))
	kylix.PruneIntent(cross(cur), id)
}

func u64(n uint64) string { return strconv.FormatUint(n, 10) }

func settle(cur realm, a, b uint64) {
	testing.SetRealm(testing.NewUserRealm(settler))
	kylix.SettleRing(cross(cur), strconv.FormatUint(a, 10)+","+strconv.FormatUint(b, 10))
}

// nextTarget is the address who must approve for their next offer of an
// item under key.
func nextTarget(who address, key string) address {
	nonce, _ := kylix.NextSlot(who)
	return kylix.ApproveTarget(who, nonce, key)
}

// target is the address the owner of offer id must approve.
func target(id uint64) address {
	o, ok := kylix.GetOffer(id)
	if !ok {
		panic("offer not open")
	}
	return kylix.ApproveTarget(o.Owner, o.Nonce, o.Give.Key)
}
