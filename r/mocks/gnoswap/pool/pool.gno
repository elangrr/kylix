// Package pool is a TEST-ONLY stand-in for gno.land/r/gnoswap/pool. It
// lives at the real import path so Kylix's bridge compiles and runs in this
// repo's tests unchanged. Never deploy it (the namespace is not ours anyway).
//
// It mirrors only what Kylix touches: GetPoolPath, ExistsPoolPath and
// GetBalances, with the real signatures and the real sorted-path rule. Like
// the real pool, every pool's tokens sit at this realm's one address, but
// each pool keeps its own balances, so a pair can have several pools that
// report different reserves. A pool is a fixed exchange rate plus its
// reserves; the LP fee is taken from the input, as in the real pool. Swaps
// are accepted only from the router, as the real pool rejects direct calls.
// Functions named Mock* do not exist on the real pool.
package pool

import (
	"strconv"
	"strings"

	"gno.land/p/nt/avl/v0"
	"gno.land/r/nt/grc20reg/v0"
)

const routerPath = "gno.land/r/gnoswap/router"

type mockPool struct {
	token0, token1 string
	fee            uint32
	// One token0 buys rateNum/rateDen token1.
	rateNum, rateDen int64
	bal0, bal1       int64
}

var pools avl.Tree // pool path -> *mockPool

// GetPoolPath returns the canonical pool path, tokens sorted, as the real
// pool does.
func GetPoolPath(token0Path, token1Path string, fee uint32) string {
	if strings.Compare(token1Path, token0Path) < 0 {
		token0Path, token1Path = token1Path, token0Path
	}
	return token0Path + ":" + token1Path + ":" + strconv.FormatUint(uint64(fee), 10)
}

// ExistsPoolPath reports whether a pool exists.
func ExistsPoolPath(poolPath string) bool { return pools.Has(poolPath) }

// GetBalances returns the pool's own balances of token0 and token1.
func GetBalances(poolPath string) (int64, int64, error) {
	v := pools.Get(poolPath)
	if v == nil {
		return 0, 0, errorString("pool does not exist: " + poolPath)
	}
	p := v.(*mockPool)
	return p.bal0, p.bal1, nil
}

// MockCreatePool creates an empty pool where one tokenA buys num/den
// tokenB.
func MockCreatePool(cur realm, tokenA, tokenB string, fee uint32, num, den int64) {
	path := GetPoolPath(tokenA, tokenB, fee)
	if pools.Has(path) {
		panic("[GNOSWAP-POOL] pool already exists: " + path)
	}
	p := &mockPool{token0: tokenA, token1: tokenB, fee: fee, rateNum: num, rateDen: den}
	if strings.Compare(tokenB, tokenA) < 0 { // store as token0 -> token1
		p.token0, p.token1, p.rateNum, p.rateDen = tokenB, tokenA, den, num
	}
	pools.Set(path, p)
}

// MockFund pulls amount of token from the caller into the pool's reserves.
// The caller must first approve this realm's address for amount.
func MockFund(cur realm, tokenA, tokenB string, fee uint32, token string, amount int64) {
	p := mustPool(GetPoolPath(tokenA, tokenB, fee))
	grc20reg.TransferFrom(0, cur, token, cur.Previous().Address(), cur.Address(), amount)
	switch token {
	case p.token0:
		p.bal0 += amount
	case p.token1:
		p.bal1 += amount
	default:
		panic("[GNOSWAP-POOL] token not in pool")
	}
}

// MockSwap pays out the gross output of an exact-in swap to the router. The
// router has already moved the input to this address.
func MockSwap(cur realm, tokenIn, tokenOut string, fee uint32, amountIn int64) int64 {
	if cur.Previous().PkgPath() != routerPath {
		panic("[GNOSWAP-POOL] only the router may swap")
	}
	p := mustPool(GetPoolPath(tokenIn, tokenOut, fee))
	afterFee := amountIn - amountIn*int64(p.fee)/1_000_000
	var out int64
	if tokenIn == p.token0 {
		out = afterFee * p.rateNum / p.rateDen
		if out > p.bal1 {
			panic("[GNOSWAP-POOL] insufficient liquidity")
		}
		p.bal0 += amountIn
		p.bal1 -= out
	} else {
		out = afterFee * p.rateDen / p.rateNum
		if out > p.bal0 {
			panic("[GNOSWAP-POOL] insufficient liquidity")
		}
		p.bal1 += amountIn
		p.bal0 -= out
	}
	grc20reg.Transfer(0, cur, tokenOut, cur.Previous().Address(), out)
	return out
}

func mustPool(path string) *mockPool {
	v := pools.Get(path)
	if v == nil {
		panic("[GNOSWAP-POOL] pool does not exist: " + path)
	}
	return v.(*mockPool)
}

type errorString string

func (e errorString) Error() string { return string(e) }
