package adaptertest

import (
	"chain"
	"chain/runtime"
	"strings"
	"testing"

	safe "gno.land/p/g1jz6j9hj6rdf5ltl2kcrpa4jwtdh3w30z0yul06/sinopia/safe/v1"
	"gno.land/p/nt/testutils/v0"
	"gno.land/p/nt/uassert/v0"
	"gno.land/r/g1jz6j9hj6rdf5ltl2kcrpa4jwtdh3w30z0yul06/sinopia3/core"
	"gno.land/r/g1jz6j9hj6rdf5ltl2kcrpa4jwtdh3w30z0yul06/sinopia3/engines/genesis"
	"gno.land/r/g1jz6j9hj6rdf5ltl2kcrpa4jwtdh3w30z0yul06/sinopia3/mint/v1"
	sinopia3adapter "gno.land/r/nym-kylix000/adapters/sinopia3"
	"gno.land/r/nym-kylix000/kylix"
	"gno.land/r/nym-kylix000/mocks/hostile"
	"gno.land/r/nym-kylix000/mocks/sinopiaengine/living"
	"gno.land/r/nym-kylix000/mocks/sinopiaengine/plain"
)

const (
	sinopiaKey    = "gno.land/r/nym-kylix000/adapters/sinopia3"
	sinopiaAdmin  = address("g1jz6j9hj6rdf5ltl2kcrpa4jwtdh3w30z0yul06") // hard-coded admin and genesis author
	genesisEngine = "gno.land/r/g1jz6j9hj6rdf5ltl2kcrpa4jwtdh3w30z0yul06/sinopia3/engines/genesis"
	mintPath      = "gno.land/r/g1jz6j9hj6rdf5ltl2kcrpa4jwtdh3w30z0yul06/sinopia3/mint/v1"
	livingEngine  = "gno.land/r/nym-kylix000/mocks/sinopiaengine/living"
	plainEngine   = "gno.land/r/nym-kylix000/mocks/sinopiaengine/plain"
	secret        = "kylix-test-creator-secret-0123456789abcdef"
	unitPrice     = 1000 // ugnot per token in the test sales
)

var (
	sAlice, sBob, sCarol, sCreator = testutils.TestAddress("s-alice"), testutils.TestAddress("s-bob"),
		testutils.TestAddress("s-carol"), testutils.TestAddress("s-creator")
	finalCid, lockedCid, livingCid, plainCid string
)

func sinopiaApprove(cur realm, owner address, cid, tid string, spender address) {
	testing.SetRealm(testing.NewUserRealm(owner))
	core.Approve(cross(cur), cid, tid, spender)
}

// newCollection does what a creator and a collector do on chain: the
// creator opens a collection through the platform's minter (mint/v1) with
// one public phase and launches it without a beacon; sAlice then buys two
// tokens, paying the minter. Nothing is minted by a shortcut.
func newCollection(cur realm, symbol, engineID string) string {
	testing.SetRealm(testing.NewUserRealm(sCreator))
	cid := mint.Create(cross(cur), "Kylix Test Art", symbol, "", engineID, "", 10, 0, "", "", "")
	h := runtime.ChainHeight()
	testing.SetRealm(testing.NewUserRealm(sCreator))
	mint.AddPhase(cross(cur), cid, "public", "", h+1, h+5, unitPrice, unitPrice, 0, 0, 0)
	testing.SetRealm(testing.NewUserRealm(sCreator))
	mint.Launch(cross(cur), cid, safe.Commit(runtime.ChainID(), cid, "creator", secret), core.RevealWindowMin, false, "")
	testing.SkipHeights(1)

	pay := chain.NewCoins(chain.NewCoin("ugnot", 2*unitPrice))
	testing.IssueCoins(sAlice, pay)
	testing.IssueCoins(chain.PackageAddress(mintPath), pay) // what the VM credits the minter with the call
	testing.SetOriginSend(pay)
	testing.SetRealm(testing.NewUserRealm(sAlice))
	mint.Mint(cross(cur), cid, 2, unitPrice, "")
	testing.SetOriginSend(nil)
	return cid
}

func reveal(cur realm, cid string) {
	testing.SetRealm(testing.NewUserRealm(sCreator))
	core.RevealCreatorSecret(cross(cur), cid, secret)
}

// The platform as deployed on the testnet: mint/v1 is a minter, and the
// Genesis engine is registered and claimed but not marked reviewed. The two
// test engines are registered and claimed the same way, by their author.
func setUpSinopia(cur realm) {
	testing.SetRealm(testing.NewUserRealm(sinopiaAdmin))
	core.ExecuteOp(cross(cur), core.ProposeOp(cross(cur), core.OpMinterAdd, mintPath))
	for _, reg := range []func(realm) string{genesis.Register, living.Register, plain.Register} {
		testing.SetRealm(testing.NewUserRealm(sinopiaAdmin))
		reg(cross(cur))
	}
	for _, e := range []string{genesisEngine, livingEngine, plainEngine} {
		testing.SetRealm(testing.NewUserRealm(sinopiaAdmin))
		core.ClaimEngine(cross(cur), e)
	}
}

// Drives real Sinopia3 collections: one to Final, one left locked, and one
// each on a living and on an unreviewed engine.
func TestSinopia3(cur realm, t *testing.T) {
	// testing.SkipHeights rewrites the test context and blanks ChainID;
	// blank it first so the creator commitment matches at reveal time.
	testing.SkipHeights(1)
	setUpSinopia(cur)
	uassert.Equal(t, "unverified", core.EngineStatus(genesisEngine), "as on the testnet")

	finalCid = newCollection(cur, "KXFIN", genesisEngine)
	lockedCid = newCollection(cur, "KXLOCK", genesisEngine)
	livingCid = newCollection(cur, "KXLIVE", livingEngine)
	plainCid = newCollection(cur, "KXPLAIN", plainEngine)
	testing.SkipHeights(10) // sales closed
	reveal(cur, finalCid)   // no beacon: Final now; lockedCid is never revealed
	reveal(cur, livingCid)
	reveal(cur, plainCid)
	owner, _ := core.OwnerOf(finalCid, "1")
	uassert.Equal(t, sAlice.String(), owner.String(), "bought through mint/v1")

	claim(cur, sBob)
	item := finalCid + "/1"
	a := offerSinopia(cur, sAlice, finalCid, "1", 100)
	b := buy(cur, sBob, 100, sinopiaKey, item)

	// Direct calls: the caller's k/ identity is not the approved address.
	err := hostile.Direct(cross(cur), sinopia3adapter.Move, sAlice, mallory, item)
	uassert.ErrorContains(t, err, "approve this offer's address for the token itself")
	err = hostile.ForgeSlot(cross(cur), sinopia3adapter.Move, sAlice, 1, sAlice, mallory, item)
	uassert.ErrorContains(t, err, "approve this offer's address for the token itself")

	settle(cur, a, b)
	owner, _ = core.OwnerOf(finalCid, "1")
	uassert.Equal(t, sBob.String(), owner.String())
}

// offerSinopia approves this one token for who's next offer, as the adapter
// requires, and posts it for at least wantMin OBOL.
func offerSinopia(cur realm, who address, cid, tid string, wantMin int64) uint64 {
	sinopiaApprove(cur, who, cid, tid, nextTarget(who, sinopiaKey))
	return postItem(cur, who, sinopiaKey, cid+"/"+tid, wantMin)
}

// refusedAtPost asserts that who cannot post an offer of item, because it
// could not settle now (the posting rule), with want in the reason.
func refusedAtPost(cur realm, t *testing.T, who address, item, want string) {
	t.Helper()
	uassert.AbortsContains(t, cur, "could not settle now", func() { postItem(cur, who, sinopiaKey, item, 1) }, item)
	uassert.AbortsContains(t, cur, want, func() { postItem(cur, who, sinopiaKey, item, 1) }, item)
}

// Finding 4b of security review 1, closed: art of a collection that is not
// Final yet is unrevealed and cannot move. Its offer cannot be posted, and
// the adapter's Move refuses too, before calling the collection.
func TestSinopia3NotFinalIsNotReady(cur realm, t *testing.T) {
	claim(cur, sCarol)
	item := lockedCid + "/1"
	sinopiaApprove(cur, sAlice, lockedCid, "1", nextTarget(sAlice, sinopiaKey))
	uassert.False(t, sinopia3adapter.Approved(kylix.ItemID(item), nextTarget(sAlice, sinopiaKey)), "approved art of a non-final collection")
	refusedAtPost(cur, t, sAlice, item, "item "+item+" cannot be moved by")
	uassert.Equal(t, sAlice.String(), sinopia3adapter.OwnerOf(kylix.ItemID(item)).String())
	err := hostile.Direct(cross(cur), sinopia3adapter.Move, sAlice, mallory, item)
	uassert.ErrorContains(t, err, "not final yet")
}

// Finding 4a of security review 1, closed: unknown or malformed collection
// ids make the adapter answer "nobody owns it" instead of panicking, so an
// offer of one cannot be posted, and a batch query with one does not break.
func TestSinopia3PoisonIDs(cur realm, t *testing.T) {
	poisoner := testutils.TestAddress("sinopia-poisoner")
	for _, id := range []string{"999999/1", "abc/1", "0/1", "01/1", finalCid + "/0", finalCid + "/x", "1/", "/1"} {
		uassert.Equal(t, "", sinopia3adapter.OwnerOf(kylix.ItemID(id)).String(), "owner of "+id)
		uassert.False(t, sinopia3adapter.Approved(kylix.ItemID(id), mallory), "approved "+id)
		if kylixValidID(id) {
			refusedAtPost(cur, t, poisoner, id, "owner no longer holds item")
		}
	}
}

// Security review 3, R3-1: an approval for all of a collection's tokens is
// not used, because the transfer does not consume it: its deposit would
// never come back to the settler, who pays for the receivers' new entries.
// Posting with one is refused; swapping the single approval for one after
// posting makes the offer not ready, and Move refuses it too.
func TestSinopia3ApprovalForAllRefused(cur realm, t *testing.T) {
	item := finalCid + "/2"
	spender := nextTarget(sAlice, sinopiaKey)
	testing.SetRealm(testing.NewUserRealm(sAlice))
	core.SetApprovalForAll(cross(cur), finalCid, spender, true)
	uassert.False(t, sinopia3adapter.Approved(kylix.ItemID(item), spender))
	refusedAtPost(cur, t, sAlice, item, "item "+item+" cannot be moved by")

	a := offerSinopia(cur, sAlice, finalCid, "2", 10)
	sinopiaApprove(cur, sAlice, finalCid, "2", "") // withdraw the single approval; the one for all stays
	uassert.True(t, strings.Contains(kylix.Deliverable(u64(a)), `"deliverable":false`))
	b := buy(cur, sCarol, 10, sinopiaKey, item)
	uassert.AbortsContains(t, cur, "item "+item+" cannot be moved by", func() { settle(cur, a, b) })
	testing.SetRealm(testing.NewUserRealm(sAlice))
	core.SetApprovalForAll(cross(cur), finalCid, spender, false)
	cancelAs(cur, sAlice, a)
	cancelAs(cur, sCarol, b)
}

// kylixValidID mirrors Kylix's item id rule, so the test posts only ids
// PostIntent accepts.
func kylixValidID(id string) bool {
	if id == "" || len(id) > 64 {
		return false
	}
	for i := 0; i < len(id); i++ {
		c := id[i]
		ok := c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' || c >= '0' && c <= '9' ||
			c == '.' || c == '_' || c == ':' || c == '/' || c == '-' || c == '*'
		if !ok {
			return false
		}
	}
	return true
}

// Review 2 (Sinopia3 follow-up): art drawn by a living engine depends on the
// token's transfer history, and an engine nobody reviewed could keep state
// and change what it draws even though its manifest says it is not living.
// Both are refused by the approval check, so their offers cannot be posted,
// and by Move; once the Sinopia3 admin marks the second engine reviewed, its
// art trades.
func TestSinopia3LivingAndUnreviewedEngines(cur realm, t *testing.T) {
	for _, c := range []struct{ cid, want string }{
		{livingCid, "living engine"},
		{plainCid, "engine is not reviewed (status unverified)"},
	} {
		item := c.cid + "/1"
		sinopiaApprove(cur, sAlice, c.cid, "1", nextTarget(sAlice, sinopiaKey))
		uassert.False(t, sinopia3adapter.Approved(kylix.ItemID(item), nextTarget(sAlice, sinopiaKey)), item)
		refusedAtPost(cur, t, sAlice, item, "item "+item+" cannot be moved by")
		err := hostile.Direct(cross(cur), sinopia3adapter.Move, sAlice, mallory, item)
		uassert.ErrorContains(t, err, c.want)
	}

	testing.SetRealm(testing.NewUserRealm(sinopiaAdmin))
	op := core.ProposeOp(cross(cur), core.OpEngineReview, plainEngine)
	testing.SkipHeights(60_000) // the review is timelocked
	testing.SetRealm(testing.NewUserRealm(sinopiaAdmin))
	core.ExecuteOp(cross(cur), op)
	item := plainCid + "/1"
	a := offerSinopia(cur, sAlice, plainCid, "1", 10)
	b := buy(cur, sCarol, 10, sinopiaKey, item)
	settle(cur, a, b)
	owner, _ := core.OwnerOf(plainCid, "1")
	uassert.Equal(t, sCarol.String(), owner.String())
}
