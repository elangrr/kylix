// Package router is a TEST-ONLY stand-in for gno.land/r/gnoswap/router, the
// GnoSwap router proxy. It lives at the real import path so Kylix's bridge
// compiles and runs in this repo's tests unchanged. Never deploy it.
//
// ExactInSingleSwapRoute mirrors the real proxy (router/v2 behind it) in
// what Kylix relies on (see docs/research/gnoswap-bridge.md):
//   - same signature; amounts and results are decimal strings;
//   - payer and recipient are cur.Previous();
//   - the input is pulled with the ROUTER's own allowance, so the payer must
//     approve this realm's address;
//   - panics when native coins are attached, when halted, past the deadline,
//     on a malformed route or a missing pool;
//   - with sqrtPriceLimitX96 "0" the whole input must be consumed;
//   - a 15 bps router fee is taken from the gross output, and the net output
//     must be at least amountOutMin.
//
// Functions named Mock* do not exist on the real router.
package router

import (
	"chain"
	"chain/runtime/unsafe"
	"strconv"
	"strings"
	"time"

	"gno.land/r/gnoswap/pool"
	"gno.land/r/nt/grc20reg/v0"
)

const feeBps = 15

var (
	halted bool
	// inputShortfall makes the next swaps report less input consumed than
	// asked, to test that Kylix refuses a partial fill.
	inputShortfall int64
	// underpull makes the next swaps pull less than they report using, which
	// leaves part of the payer's allowance unspent, to test that Kylix
	// refuses to finish with an allowance left on the router.
	underpull int64
)

// MockSetHalted switches the router halt, like halt.OpTypeRouter.
func MockSetHalted(cur realm, h bool) { halted = h }

// MockSetInputShortfall makes swaps report n fewer input units consumed.
func MockSetInputShortfall(cur realm, n int64) { inputShortfall = n }

// MockSetUnderpull makes swaps pull n fewer units than they report using.
func MockSetUnderpull(cur realm, n int64) { underpull = n }

func ExactInSingleSwapRoute(cur realm, inputToken string, outputToken string, amountIn string, routeArr string, amountOutMin string, sqrtPriceLimitX96 string, deadline int64, referrer string) (string, string) {
	if halted {
		panic("[GNOSWAP-ROUTER] router is halted")
	}
	if len(unsafe.OriginSend()) > 0 {
		panic("[GNOSWAP-COMMON] native coin is not supported")
	}
	parts := strings.Split(routeArr, ":")
	if len(parts) != 3 || parts[0] != inputToken || parts[1] != outputToken {
		panic("[GNOSWAP-ROUTER] invalid route " + routeArr)
	}
	fee, err := strconv.ParseUint(parts[2], 10, 32)
	if err != nil {
		panic("[GNOSWAP-ROUTER] invalid fee in route")
	}
	if time.Now().Unix() > deadline {
		panic("[GNOSWAP-ROUTER] transaction too old")
	}
	if sqrtPriceLimitX96 != "0" {
		panic("[GNOSWAP-ROUTER] the stand-in supports only sqrtPriceLimitX96 = 0")
	}
	if !pool.ExistsPoolPath(pool.GetPoolPath(inputToken, outputToken, uint32(fee))) {
		panic("[GNOSWAP-ROUTER] pool does not exist")
	}
	in := mustInt(amountIn)
	min := mustInt(amountOutMin)

	payer := cur.Previous().Address()
	poolAddr := chain.PackageAddress("gno.land/r/gnoswap/pool")
	used := in - inputShortfall
	grc20reg.TransferFrom(0, cur, inputToken, payer, poolAddr, used-underpull)
	gross := pool.MockSwap(cross(cur), inputToken, outputToken, uint32(fee), used)
	net := gross - gross*feeBps/10_000
	if net < min {
		panic("[GNOSWAP-ROUTER] slippage: output " + strconv.FormatInt(net, 10) + " < minimum " + amountOutMin)
	}
	grc20reg.Transfer(0, cur, outputToken, payer, net)
	return strconv.FormatInt(used, 10), strconv.FormatInt(net, 10)
}

func mustInt(s string) int64 {
	n, err := strconv.ParseInt(s, 10, 64)
	if err != nil || n < 0 {
		panic("[GNOSWAP-ROUTER] invalid amount " + s)
	}
	return n
}
