package kylix

import (
	"chain"
	"strings"
	"testing"

	"gno.land/p/nt/testutils/v0"
	"gno.land/p/nt/uassert/v0"
	"gno.land/r/sys/users"
)

const (
	evilColl   = "gno.land/r/test/evilname"
	poisonColl = "gno.land/r/test/poisoncoll"
)

func poisonMove(cur realm, from, to address, itemID string) error {
	panic("poison: move called")
}

// The poison collection panics once armed; posting (which runs its code,
// at the poster's choice and cost) happens before.
var poisonArmed bool

func poisonOwner(id ItemID) address {
	if !poisonArmed {
		return alice
	}
	panic("poison: ownerOf called")
}

func poisonApproved(id ItemID, spender address) bool {
	if !poisonArmed {
		return true
	}
	panic("poison: approved called")
}

func TestRenderEscapes(cur realm, t *testing.T) {
	evil := `<script>alert(1)</script> | [x](javascript:alert(1)) **b** # h`
	testing.SetRealm(testing.NewCodeRealm(evilColl))
	RegisterItem(cross(cur), evil, fakeMove, fakeOwner)
	fakeOwners["cup-1"] = alice
	testing.SetRealm(testing.NewUserRealm(alice))
	id := PostIntent(cross(cur), "item", evilColl, "cup-1", 0, "fungible", fooKey, "", 5, 0)

	// Pair with a matching offer from bob so evil also flows into home ring
	// cards, SVG labels, offer matching rings, and the ring page.
	b := offer(cur, bob, fooKey, 10, barKey, 1) // unrelated, check clean
	b2 := postRaw(cur, bob, "fungible", fooKey, "", 5, "item", evilColl, "cup-1", 0, 0)
	_, sBob := NextSlot(bob)
	_ = sBob
	bo2, _ := GetOffer(b2)
	approve(fooKey, bob, SlotAddress(bob, bo2.Nonce), 5)

	home := Render("")
	uassert.True(t, strings.Contains(home, "## Open offers"))
	uassert.True(t, strings.Contains(home, "## Collections"))
	uassert.True(t, strings.Contains(home, "["+u64(id)+"](/r/nym-kylix000/kylix:offer/"+u64(id)+")"), home)

	offerPage := Render("offer/" + u64(id))
	ringPage := Render("ring/" + u64(id) + "," + u64(b2))
	collsPage := Render("collections")
	postPage := Render("post?owner=%3Cscript%3Ealert(1)%3C/script%3E&giveKind=item&giveKey=" + evilColl + "&giveID=cup-1")

	for _, page := range []string{home, offerPage, ringPage, collsPage, postPage} {
		uassert.False(t, strings.Contains(page, "<script>"), "raw HTML in page")
		uassert.False(t, strings.Contains(page, "](javascript:"), "live link in page")
		uassert.False(t, strings.Contains(page, "**b**"), "unescaped emphasis in page")
	}
	uassert.True(t, strings.Contains(offerPage, "# Offer "+u64(id)))
	uassert.True(t, strings.Contains(offerPage, SlotAddress(alice, mustOpen(id).Nonce).String()))
	uassert.True(t, strings.Contains(ringPage, "data:image/svg+xml;base64,"))
	uassert.True(t, strings.Contains(ringPage, "SettleRing"))
	uassert.True(t, strings.Contains(collsPage, "Native"))

	uassert.True(t, strings.Contains(Render("offer/999999"), "not open"))
	uassert.True(t, strings.Contains(Render("offer/abc"), "No such offer"))
	uassert.True(t, strings.Contains(Render("nope"), "Not found"))
	uassert.True(t, strings.Contains(Render("?x=1"), "# Kylix"))

	testing.SetRealm(testing.NewUserRealm(alice))
	CancelIntent(cross(cur), id)
	testing.SetRealm(testing.NewUserRealm(bob))
	CancelIntent(cross(cur), b)
	CancelIntent(cross(cur), b2)
}

// Home, Collections, Post, and About must never invoke collection callbacks.
// A hostile collection whose OwnerFn/ApprovedFn panic must not break them.
func TestHomeNeverCallsCollectionCode(cur realm, t *testing.T) {
	testing.SetRealm(testing.NewCodeRealm(poisonColl))
	RegisterItem(cross(cur), "Poison", poisonMove, poisonOwner)
	RegisterApprovalCheck(cross(cur), poisonApproved)

	id1 := postRaw(cur, alice, "item", poisonColl, "p-1", 0, "fungible", fooKey, "", 10, 0)
	_, bobSlot := NextSlot(bob)
	approve(fooKey, bob, bobSlot, 10) // ring cards need offered tokens approved
	id2 := postRaw(cur, bob, "fungible", fooKey, "", 10, "item", poisonColl, "p-1", 0, 0)

	poisonArmed = true // from here on, any call into the collection panics
	defer func() { poisonArmed = false }()

	home := Render("")
	uassert.True(t, strings.Contains(home, `Poison \#p\-1`), "home lists the poison item, escaped")
	// The ring is real, but its item is a third-party one: the home page
	// does not check it (that would run its code), so it does not show it.
	uassert.False(t, strings.Contains(home, "ring/"+u64(id1)+","+u64(id2)), "home shows a ring it cannot check")
	// The offer page lists it, unverified, without calling the collection.
	uassert.True(t, strings.Contains(Render("offer/"+u64(id2)), "ring/"+u64(id2)+","+u64(id1)), "offer page lists the ring")

	uassert.True(t, strings.Contains(Render("collections"), "Poison"))
	uassert.True(t, strings.Contains(Render("post"), "Post an offer"))
	uassert.True(t, strings.Contains(Render("about"), "How Kylix works"))

	testing.SetRealm(testing.NewUserRealm(alice))
	CancelIntent(cross(cur), id1)
	testing.SetRealm(testing.NewUserRealm(bob))
	CancelIntent(cross(cur), id2)
}

func TestRenderPagesAndUsernames(cur realm, t *testing.T) {
	// Register a username at height 0, then restore height.
	savedHeight := chainHeight()
	uNamed := testutils.TestAddress("namedtrader")
	mustOK(ledgers[fooKey].Mint(uNamed, 500))
	mustOK(ledgers[barKey].Mint(uNamed, 500))
	testing.SetHeight(0)
	testing.SetRealm(testing.NewUserRealm(uNamed))
	if err := users.RegisterUser(cross(cur), "alice_kylix", uNamed); err != nil {
		t.Fatalf("RegisterUser: %v", err)
	}
	testing.SetHeight(savedHeight)

	// Three-offer ring: uNamed -> bob -> carol -> uNamed.
	a := offer(cur, uNamed, fooKey, 100, bazKey, 20)
	b := offer(cur, bob, barKey, 50, fooKey, 80)
	c := offer(cur, carol, bazKey, 20, barKey, 50)
	ids := u64(a) + "," + u64(b) + "," + u64(c)

	home := Render("")
	uassert.True(t, strings.Contains(home, `[@alice\_kylix](/u/alice_kylix)`), "home shows @alice_kylix link")
	uassert.True(t, strings.Contains(home, "data:image/svg+xml;base64,"), "home embeds ring SVG")
	uassert.True(t, strings.Contains(home, "3-offer ring"), "home shows 3-offer ring")
	uassert.True(t, strings.Contains(home, "kylixdemo"), "home links demo faucet")

	offerA := Render("offer/" + u64(a))
	uassert.True(t, strings.Contains(offerA, `[@alice\_kylix](/u/alice_kylix)`), "offer shows @alice_kylix link")
	uassert.True(t, strings.Contains(offerA, "Ready to swap"), "offer shows ready status")
	uassert.True(t, strings.Contains(offerA, "Approve step for this offer"), "offer shows approve step")
	uassert.True(t, strings.Contains(offerA, "ring/"+ids), "offer shows matching ring link")
	uassert.True(t, strings.Contains(offerA, "CancelIntent"), "offer shows cancel action")
	uassert.True(t, strings.Contains(offerA, "**Expires:** in about 7 days (block height "), "offer shows a friendly expiry")
	uassert.False(t, strings.Contains(offerA, "PruneIntent"), "no remove button before expiry")
	uassert.False(t, strings.Contains(offerA, "Flag"), "no flag button")

	ringPage := Render("ring/" + ids)
	uassert.True(t, strings.Contains(ringPage, "Ready to settle"), "ring shows ready status")
	uassert.True(t, strings.Contains(ringPage, "keeps the full amount"), "ring notes surplus")
	uassert.True(t, strings.Contains(ringPage, "Settle this ring"), "ring shows settle button")
	uassert.True(t, strings.Contains(ringPage, "data:image/svg+xml;base64,"), "ring embeds full SVG")

	// Invalid, bridged-without-pool, and closed ring pages.
	uassert.True(t, strings.Contains(Render("ring/bad"), "Invalid offer list"), "bad ring id list")
	uassert.True(t, strings.Contains(Render("ring/99999,99998"), "Cannot settle this ring"), "closed ring")
	uassert.True(t, strings.Contains(Render("ring/"+u64(a)+","+u64(a)), "Not a valid ring"), "duplicate offer ring")
	uassert.True(t, strings.Contains(Render("ring/"+u64(a)+","+u64(b)), "No GnoSwap pool"), "bridged ring without pool")

	// Post page with owner username and valid draft.
	postDraft := Render("post?owner=@alice_kylix&giveKind=fungible&giveKey=" + fooKey +
		"&giveAmount=50&wantKind=fungible&wantKey=" + barKey + "&wantMin=25&expiry=0")
	_, expectedSlot := NextSlot(uNamed)
	uassert.True(t, strings.Contains(postDraft, expectedSlot.String()), "post shows computed slot")
	uassert.True(t, strings.Contains(postDraft, "Post offer (wallet / $help)"), "post shows wallet button")
	uassert.True(t, strings.Contains(postDraft, "func=PostIntent"), "post txlink targets PostIntent")
	uassert.True(t, strings.Contains(postDraft, "0 for the default of about 7 days, at most about 30 days ahead"), "post explains expiry")
	uassert.True(t, strings.Contains(postDraft, "(expires in about 7 days)"), "draft shows default expiry")

	// About and Collections pages.
	about := Render("about")
	uassert.True(t, strings.Contains(about, "Swaps through GnoSwap"), "about explains GnoSwap fees")
	uassert.True(t, strings.Contains(about, "expect to receive exactly the minimum you asked for"), "about: the minimum is the price")
	uassert.True(t, strings.Contains(about, "An item id must fix the item's value"), "about: rule for collection authors")
	uassert.True(t, strings.Contains(about, "-max-deposit"), "about: settlers set a deposit limit")
	for _, w := range []string{"sandwich", "mev"} {
		uassert.False(t, strings.Contains(strings.ToLower(about), w), "about uses the word "+w)
	}
	uassert.True(t, strings.Contains(about, "Plug in your collection"), "about has plug-in guide")
	uassert.True(t, strings.Contains(about, "kylix.RegisterItem"), "about shows RegisterItem snippet")
	uassert.Equal(t, about, Render("how"))

	colls := Render("collections")
	uassert.True(t, strings.Contains(colls, "Third-party collection"), "collections explains third-party labels")

	// Prose jargon check: never use the words "intent" or "leg" outside API
	// function names/URLs (PostIntent, CancelIntent, PruneIntent).
	for name, page := range map[string]string{
		"home":        home,
		"offer":       offerA,
		"ring":        ringPage,
		"post":        postDraft,
		"collections": colls,
		"about":       about,
	} {
		cleaned := page
		for _, fn := range []string{"PostIntent", "CancelIntent", "PruneIntent"} {
			cleaned = strings.ReplaceAll(cleaned, fn, "")
		}
		lower := strings.ToLower(cleaned)
		uassert.False(t, hasWord(lower, "intent"), name+" contains word 'intent'")
		uassert.False(t, hasWord(lower, "intents"), name+" contains word 'intents'")
		uassert.False(t, hasWord(lower, "leg"), name+" contains word 'leg'")
		uassert.False(t, hasWord(lower, "legs"), name+" contains word 'legs'")
	}

	testing.SetRealm(testing.NewUserRealm(uNamed))
	CancelIntent(cross(cur), a)
	testing.SetRealm(testing.NewUserRealm(bob))
	CancelIntent(cross(cur), b)
	testing.SetRealm(testing.NewUserRealm(carol))
	CancelIntent(cross(cur), c)
}

func hasWord(s, w string) bool {
	idx := 0
	for {
		pos := strings.Index(s[idx:], w)
		if pos < 0 {
			return false
		}
		start := idx + pos
		end := start + len(w)
		beforeOK := start == 0 || !isAlpha(s[start-1])
		afterOK := end == len(s) || !isAlpha(s[end])
		if beforeOK && afterOK {
			return true
		}
		idx = start + 1
	}
}

func isAlpha(c byte) bool {
	return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z')
}

func TestMatchRingsBounded(cur realm, t *testing.T) {
	// Direct 2-offer ring + direct 3-offer ring + expired offer + shortfall offer.
	h := chainHeight()
	a := offer(cur, alice, fooKey, 100, barKey, 50)
	b := offer(cur, bob, barKey, 50, fooKey, 100)
	// Expired offer that would otherwise match alice.
	expID := postRaw(cur, carol, "fungible", barKey, "", 60, "fungible", fooKey, "", 100, h+1)
	// Shortfall offer (gives 40 < alice's 50).
	shortID := offer(cur, dave, barKey, 40, fooKey, 100)

	// 3-offer ring among erin, frank, grace.
	e := offer(cur, erin, fooKey, 10, bazKey, 10)
	f := offer(cur, frank, barKey, 10, fooKey, 10)
	g := offer(cur, grace, bazKey, 10, barKey, 10)

	testing.SkipHeights(2) // expire expID

	rings := findHomeRings()
	uassert.Equal(t, 2, len(rings), "expected 3-offer ring and 2-offer ring")
	uassert.Equal(t, 3, len(rings[0]), "3-offer ring sorted first")
	uassert.Equal(t, 2, len(rings[1]), "2-offer ring second")

	forA := findRingsForOffer(mustOpen(a))
	uassert.Equal(t, 1, len(forA), "only bob matches alice after carol expires and dave is short")
	uassert.Equal(t, u64(a)+","+u64(b), offerIDList(forA[0]))

	uassert.Equal(t, 0, len(findRingsForOffer(mustOpen(expID))), "expired offer returns no rings")

	for _, x := range []struct {
		who address
		id  uint64
	}{{alice, a}, {bob, b}, {carol, expID}, {dave, shortID}, {erin, e}, {frank, f}, {grace, g}} {
		testing.SetRealm(testing.NewUserRealm(x.who))
		CancelIntent(cross(cur), x.id)
	}
}

func TestEnableNotificationsGuards(cur realm, t *testing.T) {
	locked = true
	uassert.AbortsContains(t, cur, "re-entrant call during settlement", func() { enableAs(cur, alice) })
	locked = false
	aborts(t, cur, "do not send coins", func() {
		testing.SetOriginSend(chain.NewCoins(chain.NewCoin("ugnot", 1)))
		enableAs(cur, alice)
	})
}

func TestExportGraphJSON(cur realm, t *testing.T) {
	a := offer(cur, alice, fooKey, 100, barKey, 40)
	e := postRaw(cur, bob, "fungible", barKey, "", 1, "fungible", fooKey, "", 1, chainHeight()+1)
	fakeOwners["r-1"] = carol
	testing.SetRealm(testing.NewUserRealm(carol))
	it := PostIntent(cross(cur), "item", fakeColl, "r-1", 0, "fungible", bazKey, "", 7, 0)

	o, _ := GetOffer(a)
	js := ExportGraphJSON()
	uassert.True(t, strings.HasPrefix(js, `{"realm":"gno.land/r/nym-kylix000/kylix","height":`), js)
	uassert.True(t, strings.Contains(js, `{"key":"`+fakeColl+`","name":"Fake","adapter":false,"target":"","official":false,"label":"third-party collection","approvalCheck":false}`), js)
	uassert.True(t, strings.Contains(js, `{"id":`+u64(a)+`,"owner":"`+alice.String()+`","nonce":`+u64(o.Nonce)+
		`,"slot":"`+SlotAddress(alice, o.Nonce).String()+`","approve":"`+SlotAddress(alice, o.Nonce).String()+
		`","give":{"kind":"fungible","key":"`+fooKey+
		`","id":"","amount":"100"},"want":{"kind":"fungible","key":"`+barKey+`","id":"","amount":"40"},"expiry":`+i64(o.Expiry)+`,"viaSession":false}`), js)
	uassert.True(t, strings.Contains(js, `"give":{"kind":"item","key":"`+fakeColl+`","id":"r-1","amount":"0"}`), js)
	uassert.True(t, strings.Contains(js, `"id":`+u64(e)+`,`), "unexpired offer listed")
	uassert.True(t, strings.HasSuffix(js, `}],"hasMore":false,"next":0,"total":3}`), js)

	testing.SkipHeights(2)
	js = ExportGraphJSON()
	uassert.False(t, strings.Contains(js, `"id":`+u64(e)+`,`), "expired offer listed")

	for _, x := range []struct {
		who address
		id  uint64
	}{{alice, a}, {bob, e}, {carol, it}} {
		testing.SetRealm(testing.NewUserRealm(x.who))
		CancelIntent(cross(cur), x.id)
	}
	uassert.True(t, strings.HasSuffix(ExportGraphJSON(), `"offers":[],"hasMore":false,"next":0,"total":0}`))
}

func TestJSONString(t *testing.T) {
	// Expected values are interpreted strings: write \\u for a literal \u.
	cases := map[string]string{
		"":               "\"\"",
		"plain":          "\"plain\"",
		"q\"b\\":         "\"q\\\"b\\\\\"",
		"a\nb\tc\rd":     "\"a\\nb\\tc\\rd\"",
		"\x00\x1f":       "\"\\u0000\\u001f\"",
		"<a>&":           "\"\\u003ca\\u003e\\u0026\"",
		"x\u2028y\u2029": "\"x\\u2028y\\u2029\"",
		"\xff":           "\"\ufffd\"",
		"κύλιξ":          "\"κύλιξ\"",
	}
	for in, want := range cases {
		uassert.Equal(t, want, jsonString(in), "input "+in)
	}
}

func enableAs(cur realm, who address) {
	testing.SetRealm(testing.NewUserRealm(who))
	EnableNotifications(cross(cur))
}
