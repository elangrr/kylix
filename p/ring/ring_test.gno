package ring

import (
	"strings"
	"testing"

	"gno.land/p/nt/testutils/v0"
)

var (
	a = testutils.TestAddress("a")
	b = testutils.TestAddress("b")
	c = testutils.TestAddress("c")
	d = testutils.TestAddress("d")
	e = testutils.TestAddress("e")
	f = testutils.TestAddress("f")
	g = testutils.TestAddress("g")
)

const (
	foo   = "gno.land/r/t/tok.FOO"
	bar   = "gno.land/r/t/tok.BAR"
	baz   = "gno.land/r/t/tok.BAZ"
	coll  = "gno.land/r/t/coll"
	coll2 = "gno.land/r/t/other"
)

func tok(key string, amt int64) Asset { return Asset{Kind: Fungible, Key: key, Amount: amt} }
func item(key, id string) Asset       { return Asset{Kind: Item, Key: key, ID: id} }

func leg(offer uint64, owner address, give, want Asset) Leg {
	return Leg{Offer: offer, Owner: owner, Give: give, Want: want}
}

// sixLegs is a valid 6-leg ring that mixes tokens and items.
func sixLegs() []Leg {
	return []Leg{
		leg(11, a, tok(foo, 100), item(coll, "r9")),    // a gives FOO to b
		leg(12, b, tok(bar, 50), tok(foo, 90)),         // b gives BAR to c
		leg(13, c, item(coll, "r1"), tok(bar, 50)),     // c gives r1 to d
		leg(14, d, item(coll2, "x"), item(coll, "r1")), // d gives x to e
		leg(15, e, tok(baz, 7), item(coll2, "x")),      // e gives BAZ to f
		leg(16, f, item(coll, "r9"), tok(baz, 7)),      // f gives r9 to a
	}
}

func TestVerify(t *testing.T) {
	cases := []struct {
		name    string
		legs    []Leg
		bridge  int
		wantLeg int    // -2 = expect success
		wantErr string // substring
	}{
		{
			name: "two legs, token for token",
			legs: []Leg{
				leg(1, a, tok(foo, 100), tok(bar, 10)),
				leg(2, b, tok(bar, 10), tok(foo, 100)),
			},
			bridge: NoBridge, wantLeg: -2,
		},
		{
			name: "two legs, surplus goes to receiver",
			legs: []Leg{
				leg(1, a, tok(foo, 150), tok(bar, 10)),
				leg(2, b, tok(bar, 99), tok(foo, 100)),
			},
			bridge: NoBridge, wantLeg: -2,
		},
		{
			name: "three legs, token item token",
			legs: []Leg{
				leg(1, a, tok(foo, 100), tok(bar, 5)),
				leg(2, b, item(coll, "r1"), tok(foo, 100)),
				leg(3, c, tok(bar, 5), item(coll, "r1")),
			},
			bridge: NoBridge, wantLeg: -2,
		},
		{name: "six legs mixed", legs: sixLegs(), bridge: NoBridge, wantLeg: -2},
		{
			name:   "ring of one",
			legs:   []Leg{leg(1, a, tok(foo, 1), tok(bar, 1))},
			bridge: NoBridge, wantLeg: -1, wantErr: "at least 2 legs, got 1",
		},
		{name: "empty ring", legs: nil, bridge: NoBridge, wantLeg: -1, wantErr: "got 0"},
		{
			name:   "ring of seven",
			legs:   append(sixLegs(), leg(17, g, tok(foo, 1), tok(bar, 1))),
			bridge: NoBridge, wantLeg: -1, wantErr: "at most 6 legs, got 7",
		},
		{
			name: "same offer twice",
			legs: []Leg{
				leg(1, a, tok(foo, 100), tok(bar, 10)),
				leg(1, b, tok(bar, 10), tok(foo, 100)),
			},
			bridge: NoBridge, wantLeg: 1, wantErr: "offer already used by leg 0",
		},
		{
			name: "same owner twice",
			legs: []Leg{
				leg(1, a, tok(foo, 100), tok(bar, 10)),
				leg(2, b, tok(bar, 10), tok(baz, 1)),
				leg(3, a, tok(baz, 1), tok(foo, 100)),
			},
			bridge: NoBridge, wantLeg: 2, wantErr: "owner already trades in leg 0",
		},
		{
			name: "leg gives what it wants",
			legs: []Leg{
				leg(1, a, item(coll, "r1"), tok(bar, 10)),
				leg(2, b, tok(bar, 10), item(coll, "r1")),
				leg(3, c, item(coll, "r1"), item(coll, "r1")),
			},
			bridge: NoBridge, wantLeg: 2, wantErr: "gives the asset it wants",
		},
		{
			name: "same item given by two owners",
			legs: []Leg{
				leg(1, a, item(coll, "r1"), tok(bar, 10)),
				leg(2, b, tok(bar, 10), tok(foo, 1)),
				leg(3, c, tok(foo, 1), tok(baz, 1)),
				leg(4, d, item(coll, "r1"), tok(foo, 3)),
			},
			bridge: NoBridge, wantLeg: 3, wantErr: "item already given by leg 0",
		},
		{
			name: "amount below minimum",
			legs: []Leg{
				leg(1, a, tok(foo, 99), tok(bar, 10)),
				leg(2, b, tok(bar, 10), tok(foo, 100)),
			},
			bridge: NoBridge, wantLeg: 0, wantErr: "gives 99 but at least 100 is wanted for leg 1",
		},
		{
			name: "wrong token",
			legs: []Leg{
				leg(1, a, tok(foo, 100), tok(bar, 10)),
				leg(2, b, tok(baz, 10), tok(foo, 100)),
			},
			bridge: NoBridge, wantLeg: 1, wantErr: "gives " + baz + " but " + bar + " is wanted for leg 0",
		},
		{
			name: "wrong item id",
			legs: []Leg{
				leg(1, a, item(coll, "r2"), tok(bar, 10)),
				leg(2, b, tok(bar, 10), item(coll, "r1")),
			},
			bridge: NoBridge, wantLeg: 0, wantErr: "gives item r2 but item r1 is wanted",
		},
		{
			name: "same id other collection",
			legs: []Leg{
				leg(1, a, item(coll2, "r1"), tok(bar, 10)),
				leg(2, b, tok(bar, 10), item(coll, "r1")),
			},
			bridge: NoBridge, wantLeg: 0, wantErr: "gives " + coll2 + " but " + coll + " is wanted",
		},
		{
			name: "kind mismatch",
			legs: []Leg{
				leg(1, a, tok(coll, 1), tok(bar, 10)),
				leg(2, b, tok(bar, 10), item(coll, "r1")),
			},
			bridge: NoBridge, wantLeg: 0, wantErr: "gives fungible but item is wanted",
		},
		{
			name: "zero amount",
			legs: []Leg{
				leg(1, a, tok(foo, 0), tok(bar, 10)),
				leg(2, b, tok(bar, 10), tok(foo, 0)),
			},
			bridge: NoBridge, wantLeg: 0, wantErr: "give: fungible amount must be positive",
		},
		{
			name: "negative minimum",
			legs: []Leg{
				leg(1, a, tok(foo, 10), tok(bar, 10)),
				leg(2, b, tok(bar, 10), tok(foo, -5)),
			},
			bridge: NoBridge, wantLeg: 1, wantErr: "want: fungible amount must be positive",
		},
		{
			name: "item with amount",
			legs: []Leg{
				leg(1, a, Asset{Kind: Item, Key: coll, ID: "r1", Amount: 2}, tok(bar, 10)),
				leg(2, b, tok(bar, 10), item(coll, "r1")),
			},
			bridge: NoBridge, wantLeg: 0, wantErr: "give: item with an amount",
		},
		{
			name: "fungible with id",
			legs: []Leg{
				leg(1, a, Asset{Kind: Fungible, Key: foo, ID: "x", Amount: 2}, tok(bar, 10)),
				leg(2, b, tok(bar, 10), tok(foo, 1)),
			},
			bridge: NoBridge, wantLeg: 0, wantErr: "give: fungible asset with an item id",
		},
		{
			name: "unknown kind",
			legs: []Leg{
				leg(1, a, Asset{Kind: 9, Key: foo, Amount: 2}, tok(bar, 10)),
				leg(2, b, tok(bar, 10), tok(foo, 1)),
			},
			bridge: NoBridge, wantLeg: 0, wantErr: "unknown asset kind",
		},
		{
			name: "invalid owner",
			legs: []Leg{
				leg(1, address("nope"), tok(foo, 1), tok(bar, 10)),
				leg(2, b, tok(bar, 10), tok(foo, 1)),
			},
			bridge: NoBridge, wantLeg: 0, wantErr: "invalid owner address",
		},
		{
			name: "bridged hop accepted without amount check",
			legs: []Leg{
				leg(1, a, tok(foo, 100), tok(bar, 10)),
				leg(2, b, tok(bar, 10), tok(baz, 1_000_000)),
			},
			bridge: 0, wantLeg: -2,
		},
		{
			name: "bridged hop must be fungible on both sides",
			legs: []Leg{
				leg(1, a, item(coll, "r1"), tok(bar, 10)),
				leg(2, b, tok(bar, 10), tok(baz, 1)),
			},
			bridge: 0, wantLeg: 0, wantErr: "only a fungible-to-fungible hop can be bridged",
		},
		{
			name: "bridged hop that is direct",
			legs: []Leg{
				leg(1, a, tok(foo, 100), tok(bar, 10)),
				leg(2, b, tok(bar, 10), tok(foo, 1)),
			},
			bridge: 1, wantLeg: 1, wantErr: "is direct and needs no bridge",
		},
		{
			name: "bridge index out of range",
			legs: []Leg{
				leg(1, a, tok(foo, 100), tok(bar, 10)),
				leg(2, b, tok(bar, 10), tok(foo, 1)),
			},
			bridge: 2, wantLeg: -1, wantErr: "out of range",
		},
		{
			name: "other hops still checked when one is bridged",
			legs: []Leg{
				leg(1, a, tok(foo, 1), tok(bar, 20)),
				leg(2, b, tok(bar, 10), tok(baz, 1)),
			},
			bridge: 0, wantLeg: 1, wantErr: "gives 10 but at least 20 is wanted for leg 0",
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			hops, err := VerifyBridged(tc.legs, tc.bridge)
			if tc.wantLeg == -2 {
				if err != nil {
					t.Fatalf("unexpected error: %v", err)
				}
				checkHops(t, tc.legs, hops, tc.bridge)
				return
			}
			if err == nil {
				t.Fatalf("expected error containing %q", tc.wantErr)
			}
			re, ok := err.(*Error)
			if !ok {
				t.Fatalf("error is %T, want *ring.Error", err)
			}
			if re.Leg != tc.wantLeg {
				t.Errorf("error names leg %d, want %d (%v)", re.Leg, tc.wantLeg, err)
			}
			if re.Leg >= 0 && re.Offer != tc.legs[re.Leg].Offer {
				t.Errorf("error names offer %d, want %d", re.Offer, tc.legs[re.Leg].Offer)
			}
			if !strings.Contains(err.Error(), tc.wantErr) {
				t.Errorf("error %q does not contain %q", err.Error(), tc.wantErr)
			}
		})
	}
}

func checkHops(t *testing.T, legs []Leg, hops []Hop, bridge int) {
	if len(hops) != len(legs) {
		t.Fatalf("got %d hops for %d legs", len(hops), len(legs))
	}
	for i, h := range hops {
		if h.From != i || h.To != (i+1)%len(legs) {
			t.Errorf("hop %d goes %d->%d", i, h.From, h.To)
		}
		if h.Asset != legs[i].Give || h.Want != legs[h.To].Want {
			t.Errorf("hop %d carries the wrong assets", i)
		}
		if h.Bridged != (i == bridge) {
			t.Errorf("hop %d bridged=%v", i, h.Bridged)
		}
	}
}

func TestVerifyIsVerifyBridgedWithoutBridge(t *testing.T) {
	// A ring that only works if hop 1 is bridged must fail plain Verify.
	legs := []Leg{
		leg(1, a, tok(foo, 100), tok(bar, 10)),
		leg(2, b, tok(bar, 10), tok(baz, 1)),
	}
	if _, err := Verify(legs); err == nil {
		t.Fatal("Verify accepted a hop that needs a bridge")
	}
}

func TestVerifyWithBridge(t *testing.T) {
	cases := []struct {
		name    string
		legs    []Leg
		bridged int    // expected bridged hop, or NoBridge
		wantLeg int    // -2 = expect success
		wantErr string // substring
	}{
		{
			name: "no bridge needed",
			legs: []Leg{
				leg(1, a, tok(foo, 10), tok(bar, 10)),
				leg(2, b, tok(bar, 10), tok(foo, 10)),
			},
			bridged: NoBridge, wantLeg: -2,
		},
		{
			name: "one bridged hop in a three-leg ring",
			legs: []Leg{
				leg(1, a, tok(foo, 100), item(coll, "r1")),
				leg(2, b, tok(baz, 5), tok(bar, 90)), // receives FOO, wants BAR: bridged
				leg(3, c, item(coll, "r1"), tok(baz, 5)),
			},
			bridged: 0, wantLeg: -2,
		},
		{
			name: "two bridged hops refused",
			legs: []Leg{
				leg(1, a, tok(foo, 100), tok(baz, 1)),
				leg(2, b, tok(bar, 10), tok(baz, 1)),
			},
			wantLeg: 1, wantErr: "at most 1 hop, and the hop from leg 0 is already bridged",
		},
		{
			name: "same token short of minimum is not bridged",
			legs: []Leg{
				leg(1, a, tok(foo, 5), tok(bar, 10)),
				leg(2, b, tok(bar, 10), tok(foo, 9)),
			},
			wantLeg: 0, wantErr: "gives 5 but at least 9",
		},
		{
			name: "item to token is not bridged",
			legs: []Leg{
				leg(1, a, item(coll, "r1"), tok(bar, 10)),
				leg(2, b, tok(bar, 10), tok(foo, 1)),
			},
			wantLeg: 0, wantErr: "gives item but fungible is wanted",
		},
		{
			name:    "length still checked",
			legs:    []Leg{leg(1, a, tok(foo, 1), tok(bar, 1))},
			wantLeg: -1, wantErr: "at least 2 legs",
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			hops, err := VerifyWithBridge(tc.legs)
			if tc.wantLeg == -2 {
				if err != nil {
					t.Fatalf("unexpected error: %v", err)
				}
				checkHops(t, tc.legs, hops, tc.bridged)
				return
			}
			if err == nil {
				t.Fatalf("expected error containing %q", tc.wantErr)
			}
			if re := err.(*Error); re.Leg != tc.wantLeg {
				t.Errorf("error names leg %d, want %d (%v)", re.Leg, tc.wantLeg, err)
			}
			if !strings.Contains(err.Error(), tc.wantErr) {
				t.Errorf("error %q does not contain %q", err.Error(), tc.wantErr)
			}
		})
	}
}

func TestParseOfferIDs(t *testing.T) {
	cases := []struct {
		in      string
		want    string
		wantErr string
	}{
		{in: "1,2", want: "1,2"},
		{in: " 3 , 7,12 ", want: "3,7,12"},
		{in: "1,2,3,4,5,6", want: "1,2,3,4,5,6"},
		{in: "18446744073709551615,1", want: "18446744073709551615,1"},
		{in: "", wantErr: "no offer ids"},
		{in: "  ", wantErr: "no offer ids"},
		{in: "1,2,3,4,5,6,7", wantErr: "at most 6 legs, got 7"},
		{in: "1,,2", wantErr: "bad offer id"},
		{in: "0,1", wantErr: "bad offer id \"0\""},
		{in: "-1,2", wantErr: "bad offer id"},
		{in: "1;2", wantErr: "bad offer id"},
		{in: "0x10,2", wantErr: "bad offer id"},
		{in: "18446744073709551616,1", wantErr: "bad offer id"},
		{in: strings.Repeat("1", 200), wantErr: "too long"},
	}
	for _, tc := range cases {
		ids, err := ParseOfferIDs(tc.in)
		if tc.wantErr != "" {
			if err == nil || !strings.Contains(err.Error(), tc.wantErr) {
				t.Errorf("ParseOfferIDs(%q) error = %v, want %q", tc.in, err, tc.wantErr)
			}
			continue
		}
		if err != nil {
			t.Errorf("ParseOfferIDs(%q): %v", tc.in, err)
			continue
		}
		if got := FormatOfferIDs(ids); got != tc.want {
			t.Errorf("ParseOfferIDs(%q) = %s, want %s", tc.in, got, tc.want)
		}
	}
}

func TestKind(t *testing.T) {
	for _, k := range []Kind{Fungible, Item} {
		got, ok := ParseKind(k.String())
		if !ok || got != k {
			t.Errorf("round trip of %v failed", k)
		}
	}
	if _, ok := ParseKind("Fungible"); ok {
		t.Error("ParseKind is case sensitive")
	}
	if Kind(0).String() != "invalid" {
		t.Error("zero kind must not print as a real kind")
	}
}

func TestAssetString(t *testing.T) {
	if s := tok(foo, 42).String(); s != "42 "+foo {
		t.Errorf("got %q", s)
	}
	if s := item(coll, "r1").String(); s != coll+"#r1" {
		t.Errorf("got %q", s)
	}
}
