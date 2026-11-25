package kylix

import (
	"chain"
	"chain/runtime"
	"strings"
	"testing"

	"gno.land/p/nt/markdown/sanitize/v0"
	"gno.land/p/nt/uassert/v0"
)

func adapterAs(cur realm, rlm runtime.Realm, target, name string) {
	testing.SetRealm(rlm)
	RegisterAdapter(cross(cur), target, name, fakeMove, fakeOwner)
}

func approvalCheckAs(cur realm, rlm runtime.Realm, fn ApprovedFn) {
	testing.SetRealm(rlm)
	RegisterApprovalCheck(cross(cur), fn)
}

func fakeApproved(id ItemID, spender address) bool { return true }

const (
	officialAdapter   = "gno.land/r/nym-kylix000/adapters/test"
	unofficialAdapter = "gno.land/r/someone/kylixadapter"
	someTarget        = "gno.land/r/someone/collection"
	nativeColl        = "gno.land/r/test/nativecoll"
)

func TestRegisterAdapter(cur realm, t *testing.T) {
	bad := []struct{ target, want string }{
		{"", "target must be"},
		{"gno.land/p/someone/lib", "target must be"},
		{"gno.land/r/Someone/x", "target must be"},
		{"gno.land/r/x//y", "target must be"},
		{"gno.land/r/x/", "target must be"},
		{"gno.land/r/x#sub", "target must be"},
		{officialAdapter, "cannot target itself"},
	}
	for _, b := range bad {
		b := b
		aborts(t, cur, b.want, func() {
			adapterAs(cur, testing.NewCodeRealm(officialAdapter), b.target, "Test adapter")
		})
	}
	adapterAs(cur, testing.NewCodeRealm(officialAdapter), someTarget, "Official adapter")
	adapterAs(cur, testing.NewCodeRealm(unofficialAdapter), someTarget, "Unofficial adapter")
	aborts(t, cur, "already registered", func() {
		adapterAs(cur, testing.NewCodeRealm(unofficialAdapter), someTarget, "Again")
	})

	o, ok := GetCollection(officialAdapter)
	uassert.True(t, ok)
	uassert.True(t, o.Adapter && o.Official && !o.ApprovalCheck)
	uassert.Equal(t, someTarget, o.Target)
	u, _ := GetCollection(unofficialAdapter)
	uassert.True(t, u.Adapter && !u.Official)
	registerAs(cur, testing.NewCodeRealm(nativeColl), "Native", fakeMove, fakeOwner)
	n, _ := GetCollection(nativeColl)
	uassert.True(t, !n.Adapter && !n.Official && n.Target == "")
	uassert.True(t, IsOfficial("gno.land/r/nym-kylix000/kylixdemo"))
	uassert.False(t, IsOfficial("gno.land/r/nym-kylix000x/evil"), "prefix must end at a path segment")

	// Labels reach the page and the export; nothing is blocked on them.
	home := Render("")
	escTarget := sanitize.InlineText(someTarget)
	uassert.True(t, strings.Contains(home, "): official adapter for "+escTarget), home)
	uassert.True(t, strings.Contains(home, "): third-party adapter for "+escTarget), home)
	uassert.True(t, strings.Contains(home, "third-party collection"))
	js := ExportGraphJSON()
	uassert.True(t, strings.Contains(js, `{"key":"`+unofficialAdapter+`","name":"Unofficial adapter","adapter":true,"target":"`+someTarget+`","official":false,"label":"third-party adapter","approvalCheck":false}`), js)
	fakeOwners["u-1"] = alice // fakeOwner backs both test adapters
	testing.SetRealm(testing.NewUserRealm(alice))
	id := PostIntent(cross(cur), "item", unofficialAdapter, "u-1", 0, "fungible", fooKey, "", 1, 0)
	CancelIntent(cross(cur), id)
}

func TestApproveTarget(cur realm, t *testing.T) {
	slot := SlotAddress(alice, 7)
	uassert.Equal(t, slot.String(), ApproveTarget(alice, 7, fooKey).String(), "token: the slot")
	uassert.Equal(t, slot.String(), ApproveTarget(alice, 7, fakeColl).String(), "native collection: the slot")
	want := chain.DerivePkgSubAddr(officialAdapter, "k/"+slot.String())
	uassert.Equal(t, want.String(), ApproveTarget(alice, 7, officialAdapter).String(), "adapter: k/<slot>")
	uassert.NotEqual(t, want.String(), ApproveTarget(alice, 8, officialAdapter).String(), "one address per offer")
	uassert.NotEqual(t, want.String(), ApproveTarget(alice, 7, unofficialAdapter).String(), "one address per adapter")
}

func TestRegisterApprovalCheck(cur realm, t *testing.T) {
	aborts(t, cur, "register the collection first", func() {
		approvalCheckAs(cur, testing.NewCodeRealm("gno.land/r/test/nobody"), fakeApproved)
	})
	aborts(t, cur, "approved is required", func() {
		approvalCheckAs(cur, testing.NewCodeRealm(officialAdapter), nil)
	})
	approvalCheckAs(cur, testing.NewCodeRealm(officialAdapter), fakeApproved)
	aborts(t, cur, "already registered", func() {
		approvalCheckAs(cur, testing.NewCodeRealm(officialAdapter), fakeApproved)
	})
	c, _ := GetCollection(officialAdapter)
	uassert.True(t, c.ApprovalCheck)
}

func TestPaging(cur realm, t *testing.T) {
	// Start from an empty book so ids are predictable relative to first.
	var ids []uint64
	for i := 0; i < 7; i++ {
		ids = append(ids, post(cur, bob, fooKey, int64(i+1), barKey, 1))
	}
	first, last := ids[0], ids[6]

	// Export pages of three: 3, 3, 1, with "next" chaining them.
	page := ExportGraphJSONPage(first-1, 3)
	uassert.True(t, strings.Contains(page, `"id":`+u64(first)+`,`))
	uassert.True(t, strings.Contains(page, `"id":`+u64(first+2)+`,`))
	uassert.False(t, strings.Contains(page, `"id":`+u64(first+3)+`,`))
	uassert.True(t, strings.Contains(page, `"hasMore":true,"next":`+u64(first+2)+`,"total":7}`), page)
	page = ExportGraphJSONPage(first+2, 3)
	uassert.True(t, strings.Contains(page, `"hasMore":true,"next":`+u64(first+5)+`,`), page)
	page = ExportGraphJSONPage(first+5, 3)
	uassert.True(t, strings.Contains(page, `"id":`+u64(last)+`,`))
	uassert.True(t, strings.Contains(page, `"hasMore":false,"next":0,`), page)
	uassert.True(t, strings.Contains(ExportGraphJSONPage(last, 0), `"offers":[],"hasMore":false,"next":0,`))

	// Render pages newest first, linking to older offers.
	table, next := offerTable(0, 4)
	uassert.True(t, strings.Contains(table, ":offer/"+u64(last)+")"))
	uassert.False(t, strings.Contains(table, ":offer/"+u64(last-4)+")"))
	uassert.Equal(t, last-3, next)
	table, _ = offerTable(next, 4)
	uassert.True(t, strings.Contains(table, ":offer/"+u64(last-4)+")"))
	uassert.False(t, strings.Contains(table, ":offer/"+u64(last-3)+")"))
	older := Render("offers/" + u64(next))
	uassert.True(t, strings.Contains(older, ":offer/"+u64(last-4)+")"), older)
	uassert.True(t, strings.Contains(Render("offers/x"), "No such page"))

	for _, id := range ids {
		testing.SetRealm(testing.NewUserRealm(bob))
		CancelIntent(cross(cur), id)
	}
}

func TestDeliverable(cur realm, t *testing.T) {
	ok := offer(cur, alice, fooKey, 10, barKey, 10)
	unapproved := post(cur, bob, fooKey, 10, barKey, 10)
	bo, _ := GetOffer(unapproved)
	exp := postRaw(cur, carol, "fungible", fooKey, "", 1, "fungible", barKey, "", 1, chainHeight()+1)
	testing.SkipHeights(2)

	got := Deliverable(u64(ok) + ", " + u64(unapproved) + "," + u64(exp) + ",999999")
	uassert.True(t, strings.Contains(got, `{"id":`+u64(ok)+`,"deliverable":true,"reason":""}`), got)
	uassert.True(t, strings.Contains(got, `{"id":`+u64(unapproved)+`,"deliverable":false,"reason":"slot `+
		SlotAddress(bob, bo.Nonce).String()+` may spend 0 of `+fooKey+`; approve exactly 10, the amount this offer gives"}`), got)
	uassert.True(t, strings.Contains(got, `{"id":`+u64(exp)+`,"deliverable":false,"reason":"expired"}`), got)
	uassert.True(t, strings.Contains(got, `{"id":999999,"deliverable":false,"reason":"not open"}`), got)

	many := "1"
	for i := 0; i < MaxDeliverableBatch; i++ {
		many += ",1"
	}
	uassert.PanicsContains(t, nil, "takes 1 to 50 offer ids", func() { Deliverable(many) })
	uassert.PanicsContains(t, nil, "bad offer id", func() { Deliverable("1,x") })
	uassert.PanicsContains(t, nil, "takes 1 to 50", func() { Deliverable(" ") })

	for _, x := range []struct {
		who address
		id  uint64
	}{{alice, ok}, {bob, unapproved}, {carol, exp}} {
		testing.SetRealm(testing.NewUserRealm(x.who))
		CancelIntent(cross(cur), x.id)
	}
}
