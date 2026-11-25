package rpc

import (
	"context"
	"fmt"
	"strconv"
	"strings"
	"sync"

	"kylix/solver/ring"
)

const (
	// DefaultGnoSwapRouterPath is the GnoSwap router proxy realm on onyx-1.
	DefaultGnoSwapRouterPath = "gno.land/r/gnoswap/router"
	// DefaultGnoSwapPoolPath is the GnoSwap pool realm on onyx-1.
	DefaultGnoSwapPoolPath = "gno.land/r/gnoswap/pool"
)

// DefaultFeeTiers are the four GnoSwap pool fee tiers (in hundredths of a bip).
var DefaultFeeTiers = []uint32{100, 500, 3000, 10000}

// ValidFeeTier reports whether fee is one of the four GnoSwap pool fee tiers.
func ValidFeeTier(fee uint32) bool {
	for _, t := range DefaultFeeTiers {
		if fee == t {
			return true
		}
	}
	return false
}

// GnoSwapQuoter estimates single-hop GnoSwap swap outputs using read-only
// vm/qeval calls to pool.ExistsPoolPath and router.DrySwapRoute.
//
// Pool existence is cached per unordered token pair so missing pairs do not
// waste DrySwapRoute calls, and quotes are cached by (tokenIn, tokenOut, amountIn).
type GnoSwapQuoter struct {
	Client     *Client
	RouterPath string
	PoolPath   string
	FeeTiers   []uint32

	mu         sync.Mutex
	pairTiers  map[unorderedPair][]uint32
	quoteCache map[swapQuoteKey]swapQuoteVal
}

type unorderedPair struct {
	a string
	b string
}

func makeUnorderedPair(x, y string) unorderedPair {
	if x <= y {
		return unorderedPair{a: x, b: y}
	}
	return unorderedPair{a: y, b: x}
}

type swapQuoteKey struct {
	tokenIn  string
	tokenOut string
	amountIn int64
}

type swapQuoteVal struct {
	out int64
	fee uint32
	ok  bool
}

// NewGnoSwapQuoter creates a quoter with default GnoSwap realm paths and fee tiers.
func NewGnoSwapQuoter(client *Client) *GnoSwapQuoter {
	tiers := make([]uint32, len(DefaultFeeTiers))
	copy(tiers, DefaultFeeTiers)
	return &GnoSwapQuoter{
		Client:     client,
		RouterPath: DefaultGnoSwapRouterPath,
		PoolPath:   DefaultGnoSwapPoolPath,
		FeeTiers:   tiers,
		pairTiers:  make(map[unorderedPair][]uint32),
		quoteCache: make(map[swapQuoteKey]swapQuoteVal),
	}
}

// QuoteFunc returns a ring.QuoteFunc bound to ctx.
func (q *GnoSwapQuoter) QuoteFunc(ctx context.Context) ring.QuoteFunc {
	return func(tokenIn, tokenOut string, amountIn int64) (int64, uint32, bool, error) {
		return q.Quote(ctx, tokenIn, tokenOut, amountIn)
	}
}

// Quote quotes every existing GnoSwap fee tier for (tokenIn, tokenOut) with
// router.DrySwapRoute and returns the highest net output along with its winning
// fee tier. ok is false when no pool exists or all pools reject the swap.
func (q *GnoSwapQuoter) Quote(ctx context.Context, tokenIn, tokenOut string, amountIn int64) (int64, uint32, bool, error) {
	if tokenIn == "" || tokenOut == "" || tokenIn == tokenOut || amountIn <= 0 {
		return 0, 0, false, nil
	}
	if q.Client == nil {
		return 0, 0, false, fmt.Errorf("nil rpc client")
	}

	qk := swapQuoteKey{tokenIn: tokenIn, tokenOut: tokenOut, amountIn: amountIn}
	q.mu.Lock()
	if cached, ok := q.quoteCache[qk]; ok {
		q.mu.Unlock()
		return cached.out, cached.fee, cached.ok, nil
	}
	q.mu.Unlock()

	tiers, err := q.existingFeeTiers(ctx, tokenIn, tokenOut)
	if err != nil {
		return 0, 0, false, err
	}
	if len(tiers) == 0 {
		q.cacheQuote(qk, swapQuoteVal{out: 0, fee: 0, ok: false})
		return 0, 0, false, nil
	}

	routerPath := q.RouterPath
	if routerPath == "" {
		routerPath = DefaultGnoSwapRouterPath
	}
	amtStr := strconv.FormatInt(amountIn, 10)
	var bestOut int64
	var bestFee uint32
	found := false

	for _, fee := range tiers {
		route := fmt.Sprintf("%s:%s:%d", tokenIn, tokenOut, fee)
		expr := fmt.Sprintf("DrySwapRoute(%s,%s,%s,%s,%s,%s,%s)",
			strconv.Quote(tokenIn),
			strconv.Quote(tokenOut),
			strconv.Quote(amtStr),
			strconv.Quote("EXACT_IN"),
			strconv.Quote(route),
			strconv.Quote("100"),
			strconv.Quote("0"),
		)
		raw, err := q.Client.QueryEval(ctx, routerPath, expr)
		if err != nil {
			return 0, 0, false, fmt.Errorf("DrySwapRoute %s: %w", route, err)
		}
		_, outStr, swapErr, err := ParseDrySwapRoute(raw)
		if err != nil {
			return 0, 0, false, fmt.Errorf("parse DrySwapRoute %s: %w", route, err)
		}
		if swapErr != "" {
			continue
		}
		out, err := strconv.ParseInt(outStr, 10, 64)
		if err != nil || out <= 0 {
			continue
		}
		if !found || out > bestOut || (out == bestOut && fee < bestFee) {
			bestOut = out
			bestFee = fee
			found = true
		}
	}

	q.cacheQuote(qk, swapQuoteVal{out: bestOut, fee: bestFee, ok: found})
	return bestOut, bestFee, found, nil
}

func (q *GnoSwapQuoter) existingFeeTiers(ctx context.Context, tokenIn, tokenOut string) ([]uint32, error) {
	pk := makeUnorderedPair(tokenIn, tokenOut)
	q.mu.Lock()
	if tiers, ok := q.pairTiers[pk]; ok {
		q.mu.Unlock()
		return tiers, nil
	}
	q.mu.Unlock()

	poolPath := q.PoolPath
	if poolPath == "" {
		poolPath = DefaultGnoSwapPoolPath
	}
	feeTiers := q.FeeTiers
	if len(feeTiers) == 0 {
		feeTiers = DefaultFeeTiers
	}

	var existing []uint32
	for _, fee := range feeTiers {
		expr := fmt.Sprintf("ExistsPoolPath(GetPoolPath(%s,%s,%d))",
			strconv.Quote(pk.a),
			strconv.Quote(pk.b),
			fee,
		)
		raw, err := q.Client.QueryEval(ctx, poolPath, expr)
		if err != nil {
			return nil, fmt.Errorf("ExistsPoolPath %s/%s:%d: %w", pk.a, pk.b, fee, err)
		}
		lines := ParseEvalLines(raw)
		if len(lines) != 1 {
			return nil, fmt.Errorf("ExistsPoolPath returned %d values, want 1", len(lines))
		}
		exists, err := ParseEvalBool(lines[0])
		if err != nil {
			return nil, err
		}
		if exists {
			existing = append(existing, fee)
		}
	}

	q.mu.Lock()
	if q.pairTiers == nil {
		q.pairTiers = make(map[unorderedPair][]uint32)
	}
	q.pairTiers[pk] = existing
	q.mu.Unlock()
	return existing, nil
}

func (q *GnoSwapQuoter) cacheQuote(k swapQuoteKey, v swapQuoteVal) {
	q.mu.Lock()
	if q.quoteCache == nil {
		q.quoteCache = make(map[swapQuoteKey]swapQuoteVal)
	}
	q.quoteCache[k] = v
	q.mu.Unlock()
}

// ParseDrySwapRoute parses the 3-tuple vm/qeval output of
// router.DrySwapRoute(...) -> (amountIn string, amountOut string, err error).
//
// Success shape (from onyx-1):
//
//	("1000000" string)
//	("4556245" string)
//	(undefined)
//
// Domain error shape (e.g. missing pool):
//
//	("0" string)
//	("0" string)
//	(&(struct{("[GNOSWAP-ROUTER-004] ..." string)} ...) *...)
func ParseDrySwapRoute(raw string) (amountIn, amountOut, swapErr string, err error) {
	lines := ParseEvalLines(raw)
	if len(lines) != 3 {
		return "", "", "", fmt.Errorf("expected 3 values from DrySwapRoute, got %d: %q", len(lines), truncateForErr(raw))
	}
	amountIn, err = ParseEvalString(lines[0])
	if err != nil {
		return "", "", "", fmt.Errorf("DrySwapRoute amountIn: %w", err)
	}
	amountOut, err = ParseEvalString(lines[1])
	if err != nil {
		return "", "", "", fmt.Errorf("DrySwapRoute amountOut: %w", err)
	}
	if strings.TrimSpace(lines[2]) != "(undefined)" {
		swapErr = strings.TrimSpace(lines[2])
	}
	return amountIn, amountOut, swapErr, nil
}
