package ring

import (
	"encoding/base64"
	"strings"
	"testing"

	"gno.land/p/nt/uassert/v0"
)

func TestGraphSVGAllSizes(t *testing.T) {
	uassert.Equal(t, "", GraphSVG(nil, GraphFull))
	uassert.Equal(t, "", GraphSVG([]GraphHop{{From: "a", Give: "1"}}, GraphFull))
	uassert.Equal(t, "", GraphSVG(make([]GraphHop, MaxLegs+1), GraphFull))
	uassert.Equal(t, "", GraphDataURI(nil, GraphThumb))

	for n := MinLegs; n <= MaxLegs; n++ {
		hops := make([]GraphHop, n)
		for i := 0; i < n; i++ {
			hops[i] = GraphHop{
				From:    "@user" + string(rune('a'+i)),
				Give:    "100 OBOL",
				OfferID: uint64(i + 1),
			}
		}
		for _, sz := range []GraphSize{GraphFull, GraphThumb} {
			svg := GraphSVG(hops, sz)
			uassert.True(t, strings.HasPrefix(svg, "<svg "), "starts with <svg")
			uassert.True(t, strings.HasSuffix(svg, "</svg>"), "ends with </svg>")
			uassert.True(t, strings.Contains(svg, "@usera"), "contains owner label")
			uassert.True(t, strings.Contains(svg, "100 OBOL"), "contains asset label")
			uassert.False(t, strings.Contains(svg, "via GnoSwap"), "direct ring has no bridge badge")
			if sz == GraphFull {
				uassert.True(t, strings.Contains(svg, "offer #1"), "full size shows offer id")
			} else {
				uassert.False(t, strings.Contains(svg, "offer #1"), "thumb omits offer id")
			}
		}
	}
}

func TestGraphSVGBridged(t *testing.T) {
	hops := []GraphHop{
		{From: "@alice", Give: "1000 OBOL", Want: "≥ 990 DRACHMA", OfferID: 1, Bridged: true},
		{From: "@bob", Give: "Relic #relic-2", OfferID: 2},
		{From: "@carol", Give: "50 DRACHMA", OfferID: 3},
	}
	full := GraphSVG(hops, GraphFull)
	uassert.True(t, strings.Contains(full, "via GnoSwap"))
	uassert.True(t, strings.Contains(full, "1 via GnoSwap"))
	uassert.True(t, strings.Contains(full, `stroke-dasharray="6,4"`))
	uassert.True(t, strings.Contains(full, "ah-bridge"))
	uassert.True(t, strings.Contains(full, "1000 OBOL → ≥ 990 DRACHMA"))

	thumb := GraphSVG(hops, GraphThumb)
	uassert.True(t, strings.Contains(thumb, "via GnoSwap"))
	uassert.True(t, strings.Contains(thumb, `stroke-dasharray="6,4"`))
}

func TestGraphSVGHostileLabels(t *testing.T) {
	hops := []GraphHop{
		{
			From:    `"><script>alert(1)</script>`,
			Give:    `100 <img src=x onerror=alert(1)> & "bad" 'q'`,
			OfferID: 1,
		},
		{
			From:    "bob\u202eevil\x00\nline2",
			Give:    "Relic\u200b #1</text><svg onload=alert(1)>",
			Want:    "<script>x</script>",
			OfferID: 2,
			Bridged: true,
		},
	}
	for _, sz := range []GraphSize{GraphFull, GraphThumb} {
		svg := GraphSVG(hops, sz)
		uassert.False(t, strings.Contains(svg, "<script"), "raw script tag")
		uassert.False(t, strings.Contains(svg, "<img"), "raw img tag")
		uassert.False(t, strings.Contains(svg, "<svg onload"), "injected svg tag")
		uassert.Equal(t, 1, strings.Count(svg, "<svg "), "only root svg tag")
		uassert.False(t, strings.Contains(svg, "\u202e"), "bidi override stripped")
		uassert.False(t, strings.Contains(svg, "\u200b"), "zero-width stripped")
		uassert.False(t, strings.Contains(svg, "\x00"), "NUL stripped")
		uassert.True(t, strings.Contains(svg, "&lt;"), "escaped <")
		uassert.True(t, strings.Contains(svg, "&quot;"), "escaped quote")
	}
}

func TestGraphDataURI(t *testing.T) {
	hops := []GraphHop{
		{From: "@alice", Give: "10 OBOL", OfferID: 1},
		{From: "@bob", Give: "20 DRACHMA", OfferID: 2},
	}
	uri := GraphDataURI(hops, GraphThumb)
	const prefix = "data:image/svg+xml;base64,"
	uassert.True(t, strings.HasPrefix(uri, prefix))
	raw, err := base64.StdEncoding.DecodeString(strings.TrimPrefix(uri, prefix))
	uassert.NoError(t, err)
	uassert.Equal(t, GraphSVG(hops, GraphThumb), string(raw))
}

// The realm hint drawn under each asset (security review 2, N2) is escaped
// and clipped like every other label, keeps its start (the namespace), and
// is drawn in every size and for bridged hops too.
func TestGraphNote(t *testing.T) {
	for n := 2; n <= 6; n++ {
		hops := make([]GraphHop, n)
		for i := range hops {
			hops[i] = GraphHop{From: "@u", Give: "100 FOO", Note: "evil/faketok</text><svg onload=x>", OfferID: uint64(i + 1)}
		}
		hops[0].Bridged, hops[0].Want = true, "≥ 5 BAR"
		hops[1].Note = "evil/" + strings.Repeat("a", 80)
		hops[0].WantNote = "evil/spoofgns"
		for _, sz := range []GraphSize{GraphFull, GraphThumb} {
			svg := GraphSVG(hops, sz)
			uassert.Equal(t, 1, strings.Count(svg, "<svg "), "only root svg tag")
			uassert.True(t, strings.Contains(svg, "evil/faketok&lt;/text&gt;"), "note escaped")
			uassert.True(t, strings.Contains(svg, ">evil/aaa"), "long note keeps its namespace")
			uassert.False(t, strings.Contains(svg, strings.Repeat("a", 80)), "long note clipped")
			uassert.True(t, strings.Contains(svg, "→ evil/spoofgns"), "bridged wanted token's hint drawn")
		}
	}
}
