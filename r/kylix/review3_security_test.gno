package kylix

import (
	"encoding/base64"
	"strconv"
	"strings"
	"testing"

	"gno.land/p/nt/grc20/v0"
	"gno.land/p/nt/seqid/v0"
	"gno.land/p/nt/testutils/v0"
	"gno.land/p/nt/uassert/v0"
	"gno.land/p/nym-kylix000/ring/v0"
	"gno.land/r/nt/grc20reg/v0"
)

// The demonstration tests of security review 3 (docs/research/
// security-review-3.md), inverted: each passes now that its hole is closed.

// r3Coll is a collection under Kylix's namespace (so labelled official in
// these tests) with no approval check, whose owner function answers from
// r2FakeOwners: whoever controls it can claim to own any item.
const r3Coll = "gno.land/r/nym-kylix000/r3official"

func ensureR3Coll(cur realm) {
	if !IsCollection(r3Coll) {
		testing.SetRealm(testing.NewCodeRealm(r3Coll))
		RegisterItem(cross(cur), "R3 Official", r2FakeMove, r2FakeOwner)
	}
}

// R3-2 (home): twelve offers of items nobody holds, from three accounts with
// nothing, used to fill all six home slots with rings that cannot settle.
// Now they cannot be posted; and offers whose collection vouches for them
// without an approval check are not shown on the home page.
func TestReview3_HomeCrowdOutResisted(cur realm, t *testing.T) {
	ensureR3Coll(cur)
	h1 := offer(cur, alice, fooKey, 10, bazKey, 10)
	h2 := offer(cur, bob, barKey, 10, fooKey, 10)
	h3 := offer(cur, carol, bazKey, 10, barKey, 10)
	honestURL := "ring/" + u64(h1) + "," + u64(h2) + "," + u64(h3)
	uassert.True(t, strings.Contains(Render(""), honestURL), "honest ring visible before attack")

	s1 := testutils.TestAddress("r3-s1")
	s2 := testutils.TestAddress("r3-s2")
	s3 := testutils.TestAddress("r3-s3")
	aborts(t, cur, "could not settle now (owner no longer holds item fake-x1)", func() {
		postRaw(cur, s1, "item", r3Coll, "fake-x1", 0, "item", r3Coll, "fake-y1", 0, 0)
	})

	// The same twelve offers, now that the collection says they own them.
	var spam []uint64
	postFake := func(who address, giveID, wantID string) {
		r2FakeOwners[giveID] = who
		spam = append(spam, postRaw(cur, who, "item", r3Coll, giveID, 0, "item", r3Coll, wantID, 0, 0))
	}
	for b, p := range [][2]address{{s1, s2}, {s1, s3}, {s2, s3}} {
		x, y := "fake-x"+strconv.Itoa(b), "fake-y"+strconv.Itoa(b)
		postFake(p[0], x, y)
		postFake(p[0], x, y)
		postFake(p[1], y, x)
		postFake(p[1], y, x)
	}
	home := Render("")
	uassert.True(t, strings.Contains(home, honestURL), "honest ring hidden from the home page")
	for _, r := range findHomeRings() {
		for _, o := range r {
			uassert.True(t, o.Give.Key != r3Coll, "home shows an item it could not verify")
		}
	}

	for _, id := range spam {
		o, _ := GetOffer(id)
		cancelAs(cur, o.Owner, id)
	}
	cancelAs(cur, alice, h1)
	cancelAs(cur, bob, h2)
	cancelAs(cur, carol, h3)
}

// R3-2 (offer page): twelve item offers wanting FOO, from six accounts,
// used to fill the bucket and hide the honest closing ring. Unverified item
// offers now come after verified ones.
func TestReview3_OfferPageCrowdOutResisted(cur realm, t *testing.T) {
	ensureR3Coll(cur)
	h1 := offer(cur, alice, fooKey, 10, barKey, 10)
	h2 := offer(cur, bob, barKey, 10, fooKey, 10)
	uassert.Equal(t, 1, len(findRingsForOffer(loadOffer(h1))))

	var spam []uint64
	for i := 0; i < 6; i++ {
		s := testutils.TestAddress("r3-bkt-" + strconv.Itoa(i))
		for _, suffix := range []string{"-a", "-b"} {
			id := "bkt-" + strconv.Itoa(i) + suffix
			r2FakeOwners[id] = s
			spam = append(spam, postRaw(cur, s, "item", r3Coll, id, 0, "fungible", fooKey, "", 1, 0))
		}
	}
	found := false
	for _, r := range findRingsForOffer(loadOffer(h1)) {
		if len(r) == 2 && r[1].ID == h2 {
			found = true
		}
	}
	uassert.True(t, found, "honest closing ring hidden on offer/<id>")

	for _, id := range spam {
		o, _ := GetOffer(id)
		cancelAs(cur, o.Owner, id)
	}
	cancelAs(cur, alice, h1)
	cancelAs(cur, bob, h2)
}

// R3-2 (window): one account's 100 dead offers used to empty the home
// page's search window. An owner now counts for at most matchPerOwnerSeen
// offers; the rest are passed over.
func TestReview3_HomeWindowExhaustionResisted(cur realm, t *testing.T) {
	h1 := offer(cur, alice, fooKey, 10, barKey, 10)
	h2 := offer(cur, bob, barKey, 10, fooKey, 10)
	uassert.Equal(t, 1, len(findHomeRings()))

	var spam []uint64
	for i := 0; i < matchScanRawLimit; i++ {
		spam = append(spam, post(cur, mal, fooKey, 1, barKey, 1)) // approved to post, then revoked
	}
	uassert.Equal(t, 1, len(findHomeRings()), "100 dead offers from one owner emptied the window")

	for _, id := range spam {
		cancelAs(cur, mal, id)
	}
	cancelAs(cur, alice, h1)
	cancelAs(cur, bob, h2)
}

// R3-5: the ring picture of a ring with a GnoSwap hop shows the realm hint
// of the wanted token as well as the given one.
func TestReview3_BridgedRingSVGShowsWantedTokenHint(cur realm, t *testing.T) {
	const evilTokRealm = "gno.land/r/evil/spoofgns"
	testing.SetRealm(testing.NewCodeRealm(evilTokRealm))
	evilTok, evilLed := grc20.NewToken("Fake GNS", "GNS", 0, seqid.ID(1), cur)
	evilTokKey := grc20reg.Register(cross(cur), evilTok, "")
	mustOK(evilLed.Mint(bob, 1000))

	// Hop 0 (alice -> bob): gives FOO, bob wants the look-alike GNS: bridged.
	a := offer(cur, alice, fooKey, 100, barKey, 50)
	b := offer(cur, bob, barKey, 50, evilTokKey, 100)

	ringPage := Render("ring/" + u64(a) + "," + u64(b))
	const prefix = "data:image/svg+xml;base64,"
	idx := strings.Index(ringPage, prefix)
	uassert.True(t, idx > 0, "expected SVG data URI on ring page")
	rest := ringPage[idx+len(prefix):]
	end := strings.IndexByte(rest, ')')
	svgBytes, err := base64.StdEncoding.DecodeString(rest[:end])
	uassert.NoError(t, err)
	svg := string(svgBytes)
	uassert.True(t, strings.Contains(svg, "100 GNS"), svg)
	uassert.True(t, strings.Contains(svg, "→ evil/spoofgns"), "wanted token's hint missing: "+svg)
	uassert.True(t, strings.Contains(svg, "nym-kylix000/kylix"), "given token's hint missing: "+svg)
	uassert.True(t, strings.Contains(ringPage, "(token `"+evilTokKey+"`)"))

	cancelAs(cur, alice, a)
	cancelAs(cur, bob, b)
}

// R3-5: settle buttons on the home and offer pages lead to the ring page,
// which shows every asset's full key, instead of settling from a card that
// shows only short names.
func TestReview3_SettleButtonsLeadToRingPage(cur realm, t *testing.T) {
	a := offer(cur, alice, fooKey, 10, barKey, 10)
	b := offer(cur, bob, barKey, 10, fooKey, 10)
	ids := u64(a) + "," + u64(b)
	for name, page := range map[string]string{"home": Render(""), "offer": Render("offer/" + u64(a))} {
		uassert.True(t, strings.Contains(page, `<gno-button href="/r/nym-kylix000/kylix:ring/`+ids+`" label="Review and settle"`), name+": "+page)
		uassert.False(t, strings.Contains(page, "func=SettleRing"), name+" settles without showing the keys")
	}
	cancelAs(cur, alice, a)
	cancelAs(cur, bob, b)
}

// R3-5: realm hints in ring pictures never cut the namespace.
func TestSVGHintKeepsNamespace(t *testing.T) {
	uassert.Equal(t, "nym-kylix000/kylixdemo", svgHint("nym-kylix000/kylixdemo"))
	uassert.Equal(t, "evil/…ery-long-name", svgHint("evil/a-very-very-long-name"))
	uassert.Equal(t, "a-long-namespace-name-here/x", svgHint("a-long-namespace-name-here/x"))
	uassert.Equal(t, "g1jz6j9h…0yul06/sinopia3/core", svgHint("g1jz6j9hj6rdf5ltl2kcrpa4jwtdh3w30z0yul06/sinopia3/core"))
	uassert.Equal(t, "gnoland", svgHint("gnoland"))
}

// Fee wording: the ring page's command sizes the gas limit to the ring and
// prints the minimum fee for it.
func TestSettleGasWanted(t *testing.T) {
	tok := &Offer{Give: ringAsset(true)}
	item := &Offer{Give: ringAsset(false)}
	uassert.Equal(t, int64(35_000_000), settleGasWanted([]*Offer{tok, tok}, false))
	uassert.Equal(t, int64(43_000_000), settleGasWanted([]*Offer{tok, item, tok}, false))
	uassert.Equal(t, int64(55_000_000), settleGasWanted([]*Offer{tok, tok, tok, tok, tok, tok}, false))
	uassert.Equal(t, int64(93_000_000), settleGasWanted([]*Offer{tok, item, tok}, true))
	mns := &Offer{Give: ring.Asset{Kind: ring.Item, Key: namespacePrefix() + "adapters/nsnft", ID: "a*b"}}
	uassert.Equal(t, int64(44_000_000), settleGasWanted([]*Offer{tok, mns}, false))
	uassert.Equal(t, int64(73_000_000), settleGasWanted([]*Offer{item, item, item, item, item, item}, false))
}

func ringAsset(token bool) ring.Asset {
	if token {
		return ring.Asset{Kind: ring.Fungible, Key: fooKey, Amount: 1}
	}
	return ring.Asset{Kind: ring.Item, Key: r3Coll, ID: "x"}
}
