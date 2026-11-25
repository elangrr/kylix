// Package ring finds, verifies, and selects settleable trade rings for Kylix.
package ring

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"sort"
	"strconv"
	"strings"
)

const (
	// MinLegs is the smallest valid Kylix ring size.
	MinLegs = 2
	// MaxLegs is the largest valid Kylix ring size.
	MaxLegs = 6
	// NoBridge indicates a ring where every hop is direct.
	NoBridge = -1
)

// Kind identifies whether an asset is a fungible GRC20 token or a single item.
type Kind string

const (
	KindFungible Kind = "fungible"
	KindItem     Kind = "item"
)

// Asset describes what an offer gives or wants.
type Asset struct {
	Kind   Kind   `json:"kind"`
	Key    string `json:"key"`
	ID     string `json:"id"`
	Amount int64  `json:"amount"`
}

// Validate checks that a matches Kylix's on-chain asset shape rules.
func (a Asset) Validate() error {
	switch a.Kind {
	case KindFungible:
		if a.Key == "" {
			return errors.New("fungible asset without a token key")
		}
		if a.ID != "" {
			return errors.New("fungible asset with an item id")
		}
		if a.Amount <= 0 {
			return errors.New("fungible amount must be positive")
		}
		return nil
	case KindItem:
		if a.Key == "" {
			return errors.New("item without a collection key")
		}
		if a.ID == "" {
			return errors.New("item without an id")
		}
		if a.Amount != 0 {
			return errors.New("item with a non-zero amount")
		}
		return nil
	default:
		return fmt.Errorf("unknown asset kind %q", a.Kind)
	}
}

// SameAs reports whether a and b refer to the same token or the same item,
// ignoring amount.
func (a Asset) SameAs(b Asset) bool {
	return a.Kind == b.Kind && a.Key == b.Key && a.ID == b.ID
}

// String returns a compact human-readable form of the asset.
func (a Asset) String() string {
	if a.Kind == KindItem {
		return a.Key + "#" + a.ID
	}
	return strconv.FormatInt(a.Amount, 10) + " " + a.Key
}

// UnmarshalJSON parses an Asset leniently: unknown fields are ignored, and
// "amount" may be a decimal string (as ExportGraphJSON emits), a JSON integer,
// an empty string, or omitted.
func (a *Asset) UnmarshalJSON(data []byte) error {
	var raw struct {
		Kind   Kind      `json:"kind"`
		Key    string    `json:"key"`
		ID     string    `json:"id"`
		Amount flexInt64 `json:"amount"`
	}
	if err := json.Unmarshal(data, &raw); err != nil {
		return err
	}
	a.Kind = raw.Kind
	a.Key = raw.Key
	a.ID = raw.ID
	a.Amount = int64(raw.Amount)
	return nil
}

// Collection describes one registered item collection or adapter from
// ExportGraphJSON's "collections" array.
type Collection struct {
	Key           string `json:"key"`
	Name          string `json:"name"`
	Adapter       bool   `json:"adapter"`
	Target        string `json:"target"`
	Official      bool   `json:"official"`
	ApprovalCheck bool   `json:"approvalCheck"`
}

// Offer represents one open offer from Kylix's ExportGraphJSON output.
type Offer struct {
	ID         uint64 `json:"id"`
	Owner      string `json:"owner"`
	Nonce      uint64 `json:"nonce"`
	Slot       string `json:"slot"`
	Give       Asset  `json:"give"`
	Want       Asset  `json:"want"`
	Expiry     int64  `json:"expiry"`
	ViaSession bool   `json:"viaSession"`
}

// UnmarshalJSON parses an Offer leniently, tolerating string- or number-encoded
// integer fields and ignoring unknown fields (including legacy fields such as
// flaggedAt or fields added by future realm versions).
func (o *Offer) UnmarshalJSON(data []byte) error {
	var raw struct {
		ID         flexUint64 `json:"id"`
		Owner      string     `json:"owner"`
		Nonce      flexUint64 `json:"nonce"`
		Slot       string     `json:"slot"`
		Give       Asset      `json:"give"`
		Want       Asset      `json:"want"`
		Expiry     flexInt64  `json:"expiry"`
		ViaSession bool       `json:"viaSession"`
	}
	if err := json.Unmarshal(data, &raw); err != nil {
		return err
	}
	o.ID = uint64(raw.ID)
	o.Owner = raw.Owner
	o.Nonce = uint64(raw.Nonce)
	o.Slot = raw.Slot
	o.Give = raw.Give
	o.Want = raw.Want
	o.Expiry = int64(raw.Expiry)
	o.ViaSession = raw.ViaSession
	return nil
}

// Graph is the offer book snapshot returned by ExportGraphJSON.
type Graph struct {
	Realm       string       `json:"realm"`
	Height      int64        `json:"height"`
	Offers      []Offer      `json:"offers"`
	Collections []Collection `json:"collections,omitempty"`

	// Paging fields from ExportGraphJSONPage: when HasMore is true, pass Next
	// as `after` to fetch the following page.
	Next    uint64 `json:"next,omitempty"`
	HasMore bool   `json:"hasMore,omitempty"`
}

// UnmarshalJSON parses a Graph leniently and ignores unknown fields.
func (g *Graph) UnmarshalJSON(data []byte) error {
	var raw struct {
		Realm       string       `json:"realm"`
		Height      flexInt64    `json:"height"`
		Offers      []Offer      `json:"offers"`
		Collections []Collection `json:"collections"`
		Next        flexInt64    `json:"next"`
		HasMore     bool         `json:"hasMore"`
	}
	if err := json.Unmarshal(data, &raw); err != nil {
		return err
	}
	g.Realm = raw.Realm
	g.Height = int64(raw.Height)
	g.Offers = raw.Offers
	g.Collections = raw.Collections
	if raw.Next > 0 {
		g.Next = uint64(raw.Next)
	}
	g.HasMore = raw.HasMore
	return nil
}

// IndexCollections builds a lookup map from collection key to Collection.
func IndexCollections(cols []Collection) map[string]Collection {
	byKey := make(map[string]Collection, len(cols))
	for _, c := range cols {
		if c.Key != "" {
			byKey[c.Key] = c
		}
	}
	return byKey
}

// IsOfficialCollection reports whether key is listed in cols with Official == true.
func IsOfficialCollection(key string, cols map[string]Collection) bool {
	if key == "" {
		return false
	}
	c, ok := cols[key]
	return ok && c.Official
}

// OfferTouchesUnofficial reports whether o gives or wants an item belonging to
// a collection that is missing from cols or has Official == false.
func OfferTouchesUnofficial(o Offer, cols map[string]Collection) bool {
	if o.Give.Kind == KindItem && !IsOfficialCollection(o.Give.Key, cols) {
		return true
	}
	if o.Want.Kind == KindItem && !IsOfficialCollection(o.Want.Key, cols) {
		return true
	}
	return false
}

// FilterOfficialOffers returns only offers that do not touch any unofficial (or
// unlisted) item collection, along with the count of skipped offers.
func FilterOfficialOffers(offers []Offer, cols map[string]Collection) (official []Offer, skipped int) {
	official = make([]Offer, 0, len(offers))
	for _, o := range offers {
		if OfferTouchesUnofficial(o, cols) {
			skipped++
			continue
		}
		official = append(official, o)
	}
	return official, skipped
}

// UnofficialCollections returns the sorted unique collection keys touched by r
// whose Collection entry is missing or has Official == false. Pure fungible
// rings return nil.
func UnofficialCollections(byID map[uint64]Offer, cols map[string]Collection, r Ring) []string {
	var seen map[string]struct{}
	check := func(a Asset) {
		if a.Kind != KindItem || a.Key == "" {
			return
		}
		if IsOfficialCollection(a.Key, cols) {
			return
		}
		if seen == nil {
			seen = make(map[string]struct{})
		}
		seen[a.Key] = struct{}{}
	}
	for _, id := range r.IDs {
		o, ok := byID[id]
		if !ok {
			continue
		}
		check(o.Give)
		check(o.Want)
	}
	if len(seen) == 0 {
		return nil
	}
	out := make([]string, 0, len(seen))
	for k := range seen {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}

// FilterOfficialRings splits rings into those that only touch official item
// collections (or no item collections) and those that touch at least one
// unofficial (or unlisted) item collection.
func FilterOfficialRings(rings []Ring, byID map[uint64]Offer, cols map[string]Collection) (official, unofficial []Ring) {
	for _, r := range rings {
		if len(UnofficialCollections(byID, cols, r)) > 0 {
			unofficial = append(unofficial, r)
		} else {
			official = append(official, r)
		}
	}
	return official, unofficial
}

// ParseGraphJSON decodes ExportGraphJSON output leniently.
func ParseGraphJSON(data []byte) (Graph, error) {
	var g Graph
	if err := json.Unmarshal(data, &g); err != nil {
		return Graph{}, fmt.Errorf("parse offer graph json: %w", err)
	}
	return g, nil
}

// BridgeInfo describes the single GnoSwap-bridged hop in a bridged ring.
type BridgeInfo struct {
	FromOffer   uint64 `json:"fromOffer"`
	ToOffer     uint64 `json:"toOffer"`
	TokenIn     string `json:"tokenIn"`
	TokenOut    string `json:"tokenOut"`
	AmountIn    int64  `json:"amountIn"`
	WantMin     int64  `json:"wantMin"`
	ExpectedOut int64  `json:"expectedOut"`
	Fee         uint32 `json:"fee"`
}

// Ring is a settleable cycle of 2 to 6 offers in canonical rotation order
// (smallest offer ID at index 0). Offer IDs[i] sends its Give asset to the
// owner of offer IDs[(i+1)%len(IDs)].
type Ring struct {
	IDs        []uint64    `json:"ids"`
	BridgedHop int         `json:"bridgedHop"` // NoBridge (-1) for direct rings
	Bridge     *BridgeInfo `json:"bridge,omitempty"`
}

// IsBridged reports whether the ring uses a GnoSwap-bridged hop.
func (r Ring) IsBridged() bool {
	return r.BridgedHop != NoBridge
}

// FormatIDs formats the ring's offer IDs as the comma-separated argument
// expected by Kylix's SettleRing(ids).
func (r Ring) FormatIDs() string {
	return FormatOfferIDs(r.IDs)
}

// FormatOfferIDs joins offer IDs with commas.
func FormatOfferIDs(ids []uint64) string {
	var sb strings.Builder
	for i, id := range ids {
		if i > 0 {
			sb.WriteByte(',')
		}
		sb.WriteString(strconv.FormatUint(id, 10))
	}
	return sb.String()
}

type flexInt64 int64

func (f *flexInt64) UnmarshalJSON(data []byte) error {
	b := bytes.TrimSpace(data)
	if len(b) == 0 || bytes.Equal(b, []byte("null")) {
		*f = 0
		return nil
	}
	if b[0] == '"' {
		var s string
		if err := json.Unmarshal(b, &s); err != nil {
			return err
		}
		s = strings.TrimSpace(s)
		if s == "" {
			*f = 0
			return nil
		}
		v, err := strconv.ParseInt(s, 10, 64)
		if err != nil {
			return fmt.Errorf("invalid int64 string %q: %w", s, err)
		}
		*f = flexInt64(v)
		return nil
	}
	var v int64
	if err := json.Unmarshal(b, &v); err != nil {
		return err
	}
	*f = flexInt64(v)
	return nil
}

type flexUint64 uint64

func (f *flexUint64) UnmarshalJSON(data []byte) error {
	b := bytes.TrimSpace(data)
	if len(b) == 0 || bytes.Equal(b, []byte("null")) {
		*f = 0
		return nil
	}
	if b[0] == '"' {
		var s string
		if err := json.Unmarshal(b, &s); err != nil {
			return err
		}
		s = strings.TrimSpace(s)
		if s == "" {
			*f = 0
			return nil
		}
		v, err := strconv.ParseUint(s, 10, 64)
		if err != nil {
			return fmt.Errorf("invalid uint64 string %q: %w", s, err)
		}
		*f = flexUint64(v)
		return nil
	}
	var v uint64
	if err := json.Unmarshal(b, &v); err != nil {
		return err
	}
	*f = flexUint64(v)
	return nil
}
