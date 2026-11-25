package ring

import "fmt"

// VerifyRing independently checks that r satisfies every Kylix ring rule
// against graph g and quote. It does not share adjacency or search state with
// FindRings and mirrors p/ring.VerifyBridged plus r/kylix expiry and bridge
// output checks.
func VerifyRing(g Graph, r Ring, quote QuoteFunc) error {
	byID := IndexOffers(g.Offers)
	return VerifyRingIndexed(byID, g.Height, r, quote)
}

// IndexOffers builds an offer-ID lookup map (keeping the first offer for each
// ID) for repeated VerifyRingIndexed calls.
func IndexOffers(offers []Offer) map[uint64]Offer {
	byID := make(map[uint64]Offer, len(offers))
	for _, o := range offers {
		if _, exists := byID[o.ID]; !exists {
			byID[o.ID] = o
		}
	}
	return byID
}

// VerifyRingIndexed is VerifyRing using a pre-indexed offer map.
func VerifyRingIndexed(byID map[uint64]Offer, height int64, r Ring, quote QuoteFunc) error {
	n := len(r.IDs)
	if n < MinLegs || n > MaxLegs {
		return fmt.Errorf("ring length %d outside [%d, %d]", n, MinLegs, MaxLegs)
	}
	if r.BridgedHop != NoBridge && (r.BridgedHop < 0 || r.BridgedHop >= n) {
		return fmt.Errorf("bridged hop %d out of range for %d-ring", r.BridgedHop, n)
	}

	legs := make([]Offer, n)
	for i, id := range r.IDs {
		if id == 0 {
			return fmt.Errorf("leg %d: zero offer id", i)
		}
		o, ok := byID[id]
		if !ok {
			return fmt.Errorf("leg %d: offer %d not found in graph", i, id)
		}
		if height > 0 && o.Expiry > 0 && height > o.Expiry {
			return fmt.Errorf("leg %d (offer %d): expired at %d (height %d)", i, id, o.Expiry, height)
		}
		if o.Owner == "" {
			return fmt.Errorf("leg %d (offer %d): empty owner", i, id)
		}
		if err := o.Give.Validate(); err != nil {
			return fmt.Errorf("leg %d (offer %d): give: %w", i, id, err)
		}
		if err := o.Want.Validate(); err != nil {
			return fmt.Errorf("leg %d (offer %d): want: %w", i, id, err)
		}
		if o.Give.SameAs(o.Want) {
			return fmt.Errorf("leg %d (offer %d): gives what it wants", i, id)
		}
		for j := 0; j < i; j++ {
			if legs[j].ID == o.ID {
				return fmt.Errorf("leg %d: duplicate offer %d", i, o.ID)
			}
			if legs[j].Owner == o.Owner {
				return fmt.Errorf("leg %d (offer %d): duplicate owner %q (also leg %d)", i, o.ID, o.Owner, j)
			}
			if o.Give.Kind == KindItem && legs[j].Give.Kind == KindItem && legs[j].Give.SameAs(o.Give) {
				return fmt.Errorf("leg %d (offer %d): duplicate given item %s", i, o.ID, o.Give.String())
			}
		}
		legs[i] = o
	}

	for i := 0; i < n; i++ {
		to := (i + 1) % n
		give := legs[i].Give
		want := legs[to].Want

		if i == r.BridgedHop {
			if give.Kind != KindFungible || want.Kind != KindFungible {
				return fmt.Errorf("hop %d->%d: bridged hop must be fungible->fungible", i, to)
			}
			if give.Key == want.Key {
				return fmt.Errorf("hop %d->%d: bridged hop has identical token key %q", i, to, give.Key)
			}
			if quote == nil {
				return fmt.Errorf("hop %d->%d: bridged hop requires a quote function", i, to)
			}
			out, fee, ok, err := quote(give.Key, want.Key, give.Amount)
			if err != nil {
				return fmt.Errorf("hop %d->%d: quote error: %w", i, to, err)
			}
			if !ok {
				return fmt.Errorf("hop %d->%d: no pool for %s -> %s", i, to, give.Key, want.Key)
			}
			if out < want.Amount {
				return fmt.Errorf("hop %d->%d: quote output %d < want min %d", i, to, out, want.Amount)
			}
			if r.Bridge != nil && r.Bridge.Fee != 0 && fee != 0 && r.Bridge.Fee != fee {
				return fmt.Errorf("hop %d->%d: bridge fee %d != quoted best fee %d", i, to, r.Bridge.Fee, fee)
			}
			continue
		}

		if give.Kind != want.Kind {
			return fmt.Errorf("hop %d->%d: kind mismatch (%s != %s)", i, to, give.Kind, want.Kind)
		}
		if give.Key != want.Key {
			return fmt.Errorf("hop %d->%d: key mismatch (%s != %s)", i, to, give.Key, want.Key)
		}
		if give.Kind == KindItem {
			if give.ID != want.ID {
				return fmt.Errorf("hop %d->%d: item id mismatch (%s != %s)", i, to, give.ID, want.ID)
			}
		} else if give.Amount < want.Amount {
			return fmt.Errorf("hop %d->%d: fungible amount %d < want min %d", i, to, give.Amount, want.Amount)
		}
	}

	return nil
}
