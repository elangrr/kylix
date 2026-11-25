package rpc

import (
	"context"
	"fmt"

	"kylix/solver/ring"
)

// DefaultRealmPath is Kylix's placeholder realm path on onyx-1.
const DefaultRealmPath = "gno.land/r/nym-kylix000/kylix"

// graphPageLimit is the page size requested from ExportGraphJSONPage; the
// realm caps a page at 500 offers. maxGraphPages bounds the loop.
const (
	graphPageLimit = 500
	maxGraphPages  = 200
)

// FetchGraph reads every open offer from the Kylix realm via vm/qeval,
// following ExportGraphJSONPage's "hasMore" and "next" fields page by page.
func FetchGraph(ctx context.Context, client *Client, realmPath string) (ring.Graph, error) {
	if client == nil {
		return ring.Graph{}, fmt.Errorf("nil rpc client")
	}
	if realmPath == "" {
		realmPath = DefaultRealmPath
	}
	var out ring.Graph
	after := uint64(0)
	for page := 0; page < maxGraphPages; page++ {
		g, err := fetchGraphPage(ctx, client, realmPath, after)
		if err != nil {
			return ring.Graph{}, err
		}
		if page == 0 {
			// Collections are emitted only on the first page (after == 0);
			// subsequent pages omit them so we keep out.Collections from page 0.
			out = g
		} else {
			out.Offers = append(out.Offers, g.Offers...)
			out.Height = g.Height
		}
		if !g.HasMore {
			out.HasMore, out.Next = false, 0
			return out, nil
		}
		if g.Next <= after {
			return ring.Graph{}, fmt.Errorf("export cursor did not advance (after=%d, next=%d)", after, g.Next)
		}
		after = g.Next
	}
	return ring.Graph{}, fmt.Errorf("offer book is longer than %d pages of %d", maxGraphPages, graphPageLimit)
}

// fetchGraphPage fetches the page of offers with id greater than after.
func fetchGraphPage(ctx context.Context, client *Client, realmPath string, after uint64) (ring.Graph, error) {
	expr := fmt.Sprintf("ExportGraphJSONPage(%d, %d)", after, graphPageLimit)
	raw, err := client.QueryEval(ctx, realmPath, expr)
	if err != nil {
		return ring.Graph{}, fmt.Errorf("query %s.%s: %w", realmPath, expr, err)
	}
	lines := ParseEvalLines(raw)
	if len(lines) != 1 {
		return ring.Graph{}, fmt.Errorf("expected 1 return value from %s, got %d", expr, len(lines))
	}
	jsonStr, err := ParseEvalString(lines[0])
	if err != nil {
		return ring.Graph{}, fmt.Errorf("decode %s string: %w", expr, err)
	}
	g, err := ring.ParseGraphJSON([]byte(jsonStr))
	if err != nil {
		return ring.Graph{}, err
	}
	if g.Realm == "" {
		g.Realm = realmPath
	}
	return g, nil
}
