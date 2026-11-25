package kylix

import (
	"chain"
	"chain/runtime"
	"strconv"
	"strings"
	"testing"

	"gno.land/p/nt/grc20/v0"
	"gno.land/p/nt/seqid/v0"
	"gno.land/p/nt/testutils/v0"
	"gno.land/p/nt/uassert/v0"
	"gno.land/r/nt/grc20reg/v0"
	"gno.land/r/sys/users"
)

// The demonstration tests of security review 2 (docs/research/
// security-review-2.md), inverted where they demonstrated a hole: each now
// passes because the hole is closed. Tests the review wrote to confirm that
// something held are kept as they were.

var (
	r2FakeOwners = map[string]address{}
	r2BombWrites int
	r2ObsTarget  uint64
)

func r2ObsMove(cur realm, from, to address, itemID string) error {
	// Attempting read-only re-entrancy during SettleRing must abort.
	_, _ = GetOffer(r2ObsTarget)
	r2FakeOwners[itemID] = to
	return nil
}

func r2FakeMove(cur realm, from, to address, itemID string) error {
	r2FakeOwners[itemID] = to
	return nil
}

func r2FakeOwner(id ItemID) address { return r2FakeOwners[string(id)] }

func r2BombMove(cur realm, from, to address, itemID string) error {
	r2BombWrites++
	r2FakeOwners[itemID] = to
	return nil
}

func r2BombOwner(id ItemID) address {
	r2BombWrites++
	return r2FakeOwners[string(id)]
}

func r2BombApproved(id ItemID, spender address) bool {
	r2BombWrites++
	return true
}

// N1: real MNS v2 token ids are "label*domain"; Kylix accepts them on both
// sides of an offer.
func TestReview2_MNSRealTokenIDAccepted(cur realm, t *testing.T) {
	const collKey = "gno.land/r/review2/mnsstub"
	testing.SetRealm(testing.NewCodeRealm(collKey))
	RegisterItem(cross(cur), "MNS Stub", r2FakeMove, r2FakeOwner)

	r2FakeOwners["alice*gnoland"] = alice
	a := postRaw(cur, alice, "item", collKey, "alice*gnoland", 0, "fungible", fooKey, "", 10, 0)
	b := postRaw(cur, bob, "fungible", fooKey, "", 10, "item", collKey, "alice*gnoland", 0, 0)
	o, _ := GetOffer(a)
	uassert.Equal(t, "alice*gnoland", o.Give.ID)

	// '*' is markdown emphasis: every page escapes it.
	r2FakeOwners["alice*gnoland"] = alice
	for name, page := range map[string]string{
		"home": Render(""), "offer": Render("offer/" + u64(a)), "ring": Render("ring/" + u64(a) + "," + u64(b)),
	} {
		uassert.True(t, strings.Contains(page, `\#alice\*gnoland`), name+": "+page)
		uassert.False(t, strings.Contains(page, "#alice*gnoland**"), name)
	}
	uassert.True(t, strings.Contains(ExportGraphJSON(), `"id":"alice*gnoland"`))
	cancelAs(cur, alice, a)
	cancelAs(cur, bob, b)
}

// N2: a token with a well-known symbol and a collection with an official
// name, both from someone else's realm. Every page shows where they come
// from, and the third-party collection never carries the official label.
func TestReview2_TokenAndCollectionLookAlikesAreLabelled(cur realm, t *testing.T) {
	const evilTokRealm = "gno.land/r/evil/faketok"
	testing.SetRealm(testing.NewCodeRealm(evilTokRealm))
	evilTok, evilLed := grc20.NewToken("Fake FOO", "FOO", 0, seqid.ID(1), cur)
	evilTokKey := grc20reg.Register(cross(cur), evilTok, "")
	mustOK(evilLed.Mint(mal, 1_000_000))

	const evilCollRealm = "gno.land/r/evil/fakerelics"
	testing.SetRealm(testing.NewCodeRealm(evilCollRealm))
	RegisterItem(cross(cur), "Kylix Relics", r2FakeMove, r2FakeOwner)

	// The crafted :post link from the review: the victim gives real BAR for
	// the look-alike FOO, prepared for alice's address.
	page := Render("post?owner=" + alice.String() +
		"&giveKind=fungible&giveKey=" + barKey + "&giveAmount=100" +
		"&wantKind=fungible&wantKey=" + evilTokKey + "&wantMin=100")
	frame := page[:strings.Index(page, "</gno-frame>")]
	button := strings.Index(frame, `<gno-button href="/r/nym-kylix000/kylix$help&amp;func=PostIntent`)
	uassert.True(t, button > 0, frame)
	prose := frame[:button]
	uassert.True(t, strings.Contains(prose, "(token `"+evilTokKey+"`)"), "full look-alike key next to its symbol: "+prose)
	uassert.True(t, strings.Contains(prose, "(token `"+barKey+"`)"), prose)
	// The account the page was prepared for is shown above the approve step.
	who := strings.Index(prose, "Prepared for account `"+alice.String()+"`")
	step1 := strings.Index(prose, "**1. Approve this address first**")
	uassert.True(t, who >= 0 && who < step1, prose)

	// The look-alike collection.
	page = Render("post?owner=" + alice.String() +
		"&giveKind=fungible&giveKey=" + barKey + "&giveAmount=100" +
		"&wantKind=item&wantKey=" + evilCollRealm + "&wantID=relic-1&wantMin=0")
	frame = page[:strings.Index(page, "</gno-frame>")]
	uassert.True(t, strings.Contains(frame, "(third-party collection `"+evilCollRealm+"`)"), frame)
	uassert.False(t, strings.Contains(frame, "(official collection `"), frame)

	// Home, offer and ring pages.
	r2FakeOwners["relic-1"] = mal
	a := offer(cur, alice, barKey, 100, evilTokKey, 100)
	_, slotMal := NextSlot(mal)
	mustOK(evilLed.Approve(mal, slotMal, 100))
	b := postRaw(cur, mal, "fungible", evilTokKey, "", 100, "fungible", barKey, "", 100, 0)
	c := postRaw(cur, mal, "item", evilCollRealm, "relic-1", 0, "fungible", barKey, "", 50, 0)

	home := Render("")
	uassert.True(t, strings.Contains(home, `100 FOO \(evil/faketok\)`), "table hint for the look-alike token")
	uassert.True(t, strings.Contains(home, `Kylix Relics \#relic\-1 \(third\-party collection, evil/fakerelics\)`), home)
	uassert.False(t, strings.Contains(home, `Kylix Relics \#relic\-1 \(official`), "look-alike collection labelled official")
	ringPage := Render("ring/" + u64(a) + "," + u64(b))
	uassert.True(t, strings.Contains(ringPage, "(token `"+evilTokKey+"`)"), ringPage)
	offerPage := Render("offer/" + u64(c))
	uassert.True(t, strings.Contains(offerPage, "(third-party collection `"+evilCollRealm+"`)"), offerPage)
	// The export labels it the same way.
	uassert.True(t, strings.Contains(ExportGraphJSON(), `"key":"`+evilCollRealm+`","name":"Kylix Relics","adapter":false,"target":"","official":false,"label":"third-party collection"`))

	cancelAs(cur, alice, a)
	cancelAs(cur, mal, b)
	cancelAs(cur, mal, c)
}

// N6: offers posted to crowd honest rings off the home and offer pages.
// The review used seven unfunded offers; those no longer enter the search
// at all (only funded, approved token offers do). Here the spam is funded
// and approved, one unit each, which is the cheap form of the attack now.
func TestReview2_MatchHomeCrowdOutResisted(cur realm, t *testing.T) {
	h1 := offer(cur, alice, fooKey, 10, bazKey, 10)
	h2 := offer(cur, bob, barKey, 10, fooKey, 10)
	h3 := offer(cur, carol, bazKey, 10, barKey, 10)
	before := findHomeRings()
	uassert.Equal(t, 1, len(before))

	s1 := testutils.TestAddress("spammer1")
	s2 := testutils.TestAddress("spammer2")
	s3 := testutils.TestAddress("spammer3")
	for _, s := range []address{s1, s2, s3} {
		for _, led := range ledgers {
			mustOK(led.Mint(s, 100))
		}
	}
	var spam []uint64
	spam = append(spam, offer(cur, s1, fooKey, 1, bazKey, 1), offer(cur, s1, fooKey, 1, bazKey, 1))
	spam = append(spam, offer(cur, s2, barKey, 1, fooKey, 1), offer(cur, s2, barKey, 1, fooKey, 1))
	spam = append(spam, offer(cur, s3, bazKey, 1, barKey, 1), offer(cur, s3, bazKey, 1, barKey, 1), offer(cur, s3, bazKey, 1, barKey, 1))
	// And the review's unfunded version on top.
	for i := 0; i < 7; i++ {
		spam = append(spam, post(cur, mal, fooKey, 1, bazKey, 1))
	}

	honest := func(rings [][]*Offer) bool {
		for _, r := range rings {
			if r[0].ID == h1 && len(r) == 3 {
				return true
			}
		}
		return false
	}
	uassert.True(t, honest(findHomeRings()), "honest ring crowded off the home page")
	uassert.True(t, strings.Contains(Render(""), "ring/"+u64(h1)+","+u64(h2)+","+u64(h3)))

	// offer/<id>: twelve newer funded offers from one account wanting FOO.
	var bucket []uint64
	for i := 0; i < matchMaxBucket; i++ {
		bucket = append(bucket, offer(cur, s2, barKey, 1, fooKey, 1))
	}
	found := false
	for _, r := range findRingsForOffer(loadOffer(h1)) {
		for _, o := range r {
			if o.ID == h2 {
				found = true
			}
		}
	}
	uassert.True(t, found, "honest counterparty pushed out of the bucket")

	for _, id := range bucket {
		cancelAs(cur, s2, id)
	}
	for _, id := range spam {
		o, _ := GetOffer(id)
		cancelAs(cur, o.Owner, id)
	}
	cancelAs(cur, alice, h1)
	cancelAs(cur, bob, h2)
	cancelAs(cur, carol, h3)
}

// Part 2.1 positive check, extended (review 2, Part 2 item 5: the escape
// test checked three substrings): gnoweb tags, markdown links and images,
// alerts, HTML and SVG breakouts in a collection name, an item id and the
// post page's query are all neutralized on every page.
func TestReview2_PageInjectionVectorsHold(cur realm, t *testing.T) {
	const gnoTagColl = "gno.land/r/evil/gnotag"
	payload := `<gno-button href="/r/x" label="X"/><gno-form exec="Y">![a](b)`
	testing.SetRealm(testing.NewCodeRealm(gnoTagColl))
	RegisterItem(cross(cur), payload, r2FakeMove, r2FakeOwner)
	r2FakeOwners["t-1"] = alice

	a := postRaw(cur, alice, "item", gnoTagColl, "t-1", 0, "fungible", fooKey, "", 1, 0)
	_, sb := NextSlot(bob)
	approve(fooKey, bob, sb, 1)
	b := postRaw(cur, bob, "fungible", fooKey, "", 1, "item", gnoTagColl, "t-1", 0, 0)

	pages := map[string]string{
		"home":        Render(""),
		"offer":       Render("offer/" + u64(a)),
		"ring":        Render("ring/" + u64(a) + "," + u64(b)),
		"collections": Render("collections"),
		"post": Render("post?owner=%22%3E%3Cgno-button%20href=%22/r/evil%22%20label=%22Steal%22/%3E" +
			"&giveKind=item&giveKey=" + gnoTagColl + "&giveID=t-1&wantKind=fungible&wantKey=" + fooKey + "&wantMin=1"),
		"post-raw":          Render("post?giveKey=%3Cscript%3E&wantKey=](javascript:alert(1))&giveID=%3Cgno-form%3E&expiry=**b**"),
		"collections-after": Render("collections?after=%3Cgno-button%3E"),
	}
	for name, md := range pages {
		for _, bad := range []string{
			`<gno-button href="/r/x"`, `<gno-button href="/r/evil"`, `<gno-form exec="Y"`, `![a](b)`,
			`<script>`, `](javascript:`, `**b**`, `<gno-form>`, `<gno-button>`,
		} {
			uassert.False(t, strings.Contains(md, bad), name+": raw "+bad)
		}
	}
	cancelAs(cur, alice, a)
	cancelAs(cur, bob, b)
}

// Part 1 checks the review ran to confirm earlier fixes; kept as written.
func TestReview2_ExpiryAndReview1FixesHold(cur realm, t *testing.T) {
	h := runtime.ChainHeight()

	aborts(t, cur, "future block height", func() {
		postRaw(cur, alice, "fungible", fooKey, "", 1, "fungible", barKey, "", 1, h)
	})
	aborts(t, cur, "future block height", func() {
		postRaw(cur, alice, "fungible", fooKey, "", 1, "fungible", barKey, "", 1, -1)
	})
	aborts(t, cur, "at most 30 days ahead", func() {
		postRaw(cur, alice, "fungible", fooKey, "", 1, "fungible", barKey, "", 1, h+MaxExpiryBlocks+1)
	})

	idDef := postRaw(cur, alice, "fungible", fooKey, "", 1, "fungible", barKey, "", 1, 0)
	oDef, _ := GetOffer(idDef)
	uassert.Equal(t, h+DefaultExpiryBlocks, oDef.Expiry)

	idMax := postRaw(cur, alice, "fungible", fooKey, "", 1, "fungible", barKey, "", 1, h+MaxExpiryBlocks)
	oMax, _ := GetOffer(idMax)
	uassert.Equal(t, h+MaxExpiryBlocks, oMax.Expiry)

	_, sA := NextSlot(alice)
	approve(fooKey, alice, sA, 5)
	idExact := postRaw(cur, alice, "fungible", fooKey, "", 5, "fungible", barKey, "", 5, h+2)
	idMatch := offer(cur, bob, barKey, 5, fooKey, 5)
	testing.SkipHeights(2)
	aborts(t, cur, "has not expired", func() {
		testing.SetRealm(testing.NewUserRealm(carol))
		PruneIntent(cross(cur), idExact)
	})
	settleAs(cur, carol, u64(idExact)+","+u64(idMatch))
	uassert.False(t, isOpen(idExact))

	const bombKey = "gno.land/r/review2/bombcoll"
	testing.SetRealm(testing.NewCodeRealm(bombKey))
	RegisterItem(cross(cur), "Bomb", r2BombMove, r2BombOwner)
	RegisterApprovalCheck(cross(cur), r2BombApproved)
	r2FakeOwners["b-1"] = alice
	hNow := runtime.ChainHeight()
	idBomb := postRaw(cur, alice, "item", bombKey, "b-1", 0, "fungible", fooKey, "", 1, hNow+1)
	r2BombWrites = 0 // posting ran the collection's code, at the poster's choice and cost
	testing.SkipHeights(2)
	aborts(t, cur, "offer expired", func() {
		settleAs(cur, carol, u64(idBomb)+","+u64(idDef))
	})
	testing.SetRealm(testing.NewUserRealm(carol))
	PruneIntent(cross(cur), idBomb)
	uassert.Equal(t, 0, r2BombWrites, "PruneIntent must not invoke OwnerFn or ApprovedFn")
	uassert.False(t, isOpen(idBomb))

	locked = true
	uassert.PanicsWithMessage(t, cur, "kylix: settlement in progress", func() { GetOffer(idDef) })
	uassert.PanicsWithMessage(t, cur, "kylix: settlement in progress", func() { OpenOffers() })
	uassert.PanicsWithMessage(t, cur, "kylix: settlement in progress", func() { Deliverable(u64(idDef)) })
	uassert.PanicsWithMessage(t, cur, "kylix: settlement in progress", func() { ExportGraphJSON() })
	uassert.PanicsWithMessage(t, cur, "kylix: settlement in progress", func() { ExportGraphJSONPage(0, 10) })
	uassert.PanicsWithMessage(t, cur, "kylix: settlement in progress", func() { ExportCollectionsJSON("", 10) })
	locked = false
	const obsKey = "gno.land/r/review2/observer"
	r2ObsTarget = idDef
	testing.SetRealm(testing.NewCodeRealm(obsKey))
	RegisterItem(cross(cur), "Observer", r2ObsMove, r2FakeOwner)
	r2FakeOwners["obs-1"] = alice
	idObsA := postRaw(cur, alice, "item", obsKey, "obs-1", 0, "fungible", fooKey, "", 1, 0)
	_, sBob := NextSlot(bob)
	approve(fooKey, bob, sBob, 1)
	idObsB := postRaw(cur, bob, "fungible", fooKey, "", 1, "item", obsKey, "obs-1", 0, 0)
	uassert.AbortsContains(t, cur, "settlement in progress", func() {
		settleAs(cur, carol, u64(idObsA)+","+u64(idObsB))
	})
	locked = false // in-package revive does not roll back state

	coins := chain.NewCoins(chain.NewCoin("ugnot", 1000))
	testing.SetOriginSend(coins)
	idFromRealm := postAsRealm(cur, "gno.land/r/review2/payable", fooKey, 1, barKey, 1)
	testing.SetOriginSend(nil)
	cancelAsRealm(cur, "gno.land/r/review2/payable", idFromRealm)

	hExp := runtime.ChainHeight()
	var expIDs []uint64
	for i := 0; i < 550; i++ {
		expIDs = append(expIDs, postRaw(cur, dave, "fungible", fooKey, "", 1, "fungible", barKey, "", 1, hExp+1))
	}
	testing.SkipHeights(2)
	page1 := ExportGraphJSONPage(0, 10)
	uassert.True(t, strings.Contains(page1, `"hasMore":true`), "bounded scan stops and reports hasMore")
	for _, id := range expIDs {
		testing.SetRealm(testing.NewUserRealm(dave))
		PruneIntent(cross(cur), id)
	}
	cancelAs(cur, alice, idDef)
	cancelAs(cur, alice, idMax)
	// idObsA and idObsB were deleted by the aborted settlement, which an
	// in-package test does not roll back.
}

// Part 2.2: a heavy home and offer page still render (gas is measured by
// the z_review2_*_gas filetests).
func TestReview2_RenderWorstCaseGas(cur realm, t *testing.T) {
	const bigColl = "gno.land/r/review2/gascoll"
	testing.SetRealm(testing.NewCodeRealm(bigColl))
	RegisterItem(cross(cur), strings.Repeat("W", 64), r2FakeMove, r2FakeOwner)

	savedH := runtime.ChainHeight()
	addrs := make([]address, 50)
	for i := 0; i < 50; i++ {
		addrs[i] = testutils.TestAddress("gasuser_" + strconv.Itoa(i))
	}
	testing.SetHeight(0)
	for i, a := range addrs {
		testing.SetRealm(testing.NewUserRealm(a))
		_ = users.RegisterUser(cross(cur), "gasuser_"+strconv.Itoa(i), a)
	}
	testing.SetHeight(savedH)
	for _, a := range addrs {
		for _, led := range ledgers {
			mustOK(led.Mint(a, 10))
		}
	}

	var created []uint64
	for r := 0; r < 6; r++ {
		idStr := strings.Repeat("r", 60) + "-" + strconv.Itoa(r)
		uA, uB, uC := addrs[r*3], addrs[r*3+1], addrs[r*3+2]
		r2FakeOwners[idStr] = uA
		created = append(created, postRaw(cur, uA, "item", bigColl, idStr, 0, "fungible", fooKey, "", 1, 0))
		created = append(created, postRaw(cur, uB, "fungible", barKey, "", 1, "item", bigColl, idStr, 0, 0))
		created = append(created, postRaw(cur, uC, "fungible", fooKey, "", 1, "fungible", barKey, "", 1, 0))
	}
	for i := 18; i < 50; i++ {
		u := addrs[i]
		if i%2 == 0 {
			created = append(created, postRaw(cur, u, "fungible", fooKey, "", 1, "fungible", barKey, "", 999999, 0))
		} else {
			created = append(created, postRaw(cur, u, "fungible", barKey, "", 1, "fungible", fooKey, "", 999999, 0))
		}
	}

	home := Render("")
	uassert.True(t, strings.Contains(home, "## Ready to settle"))
	offerPage := Render("offer/" + u64(created[0]))
	uassert.True(t, strings.Contains(offerPage, "# Offer "+u64(created[0])))

	for _, id := range created {
		o, ok := GetOffer(id)
		if ok {
			cancelAs(cur, o.Owner, id)
		}
	}
}

// N7: fifty tokens registered from a realm whose path sorts first cannot
// lock anyone out of the post page: keys are checked by lookup, and the
// dropdown lists the demo tokens and the selected keys first.
// Named Z_ to run last because grc20reg entries persist for the test binary.
func TestReview2_Z_PostPageAssetLockoutResisted(cur realm, t *testing.T) {
	const spamRealm = "gno.land/r/g1aaa000000000000000000000000000000000/spam"
	testing.SetRealm(testing.NewCodeRealm(spamRealm))
	for i := 0; i < maxFormAssetOpts; i++ {
		sym := "S" + strconv.Itoa(100+i)
		tok, _ := grc20.NewToken("Spam "+sym, sym, 0, seqid.ID(1000+i), cur)
		grc20reg.Register(cross(cur), tok, "")
	}

	postPage := Render("post?owner=" + alice.String() +
		"&giveKind=fungible&giveKey=" + fooKey + "&giveAmount=10" +
		"&wantKind=fungible&wantKey=" + barKey + "&wantMin=10")
	uassert.True(t, strings.Contains(postPage, "Post offer (wallet / $help)"), "legitimate token locked out of :post builder")
	uassert.True(t, strings.Contains(postPage, `name="giveKey" value="`+fooKey+`"`), "selected key missing from the dropdown")

	// Pinned (demo tokens here) first, then the selected keys, then the rest.
	tokens, _ := knownAssets(fooKey, barKey)
	uassert.Equal(t, maxFormAssetOpts, len(tokens))
	pos := map[string]int{}
	for i, k := range tokens {
		pos[k] = i + 1
	}
	demo := demoRealmPath()
	uassert.Equal(t, 1, pos[demo+".DRACHMA"])
	uassert.Equal(t, 2, pos[demo+".OBOL"])
	uassert.Equal(t, 3, pos[fooKey], "selected keys right after the pinned ones")
	uassert.Equal(t, 4, pos[barKey])

	// A key that is not registered is still refused.
	uassert.Equal(t, "", allowAssetKey("gno.land/r/evil/none.FOO"))
}
