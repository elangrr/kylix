# GnoSwap Sub-Address Bridge Research

## Verdict

**Works as designed.** A Kylix realm can pull an offer's GRC20 input via its per-offer sub-address into `cur.Sub("settle")`, approve the real GnoSwap router proxy, execute `ExactInSingleSwapRoute(cross(settleSub), ...)`, reset the allowance to 0, and forward 100% of the returned net output to a third party in one atomic transaction. Two integration rules are load-bearing: call `bridge(cur, ...)` non-crossing inside `SettleRing` so both `cur` and `slot` remain current, and keep `SettleRing` rejecting native coins because the router panics if `unsafe.OriginSend()` is non-empty.

## Seven Questions

1. **Payer, recipient, and caller checks.** Both payer and output recipient are `rlm.Previous().Address()` (`router/v2/swap_single.gno:16`, `router/v2/exact_in.gno:184-187`), which is `settleSub.Address()` when called as `cross(settleSub)`. No EOA, origin-call, whitelist, or role check blocks sub-addresses on the swap path: `router/proxy.gno:43-45` forwards `cur`; `router/v2/exact_in.gno:127-139` checks `rlm.IsCurrent()`, router halt, and zero native coins; `pool/v1/swap.gno:203` + `pool/v1/assert.gno:8-16` reject EOA direct calls (`IsUserCall()`), which the router proxy satisfies; `router/v2/swap_callback.gno:53-54` only checks the callback came from `router/v2`; `referral/v1/global_keeper.gno:89-91` is a pure read when `referrer == ""`; `emission/emission.gno:87-180` and `staker/v1/reward_calculation_tick.gno:89-160` never inspect the swap caller.

2. **Allowance spender.** Approve the **router proxy** `gno.land/r/gnoswap/router` (`g1vc883gshu5z7ytk5cdynhc8c2dh67pdp4cszkp` on onyx-1), not `router/v2` or `pool`. In `router/v2/swap_callback.gno:87-94`, `transferToPool` calls `common.SafeGRC20TransferFrom(0, rlm, token, payer, poolAddr, amount)` with `rlm` = router proxy, so `common/v1/instance.gno:173-175` binds `RealmTeller` to `ROLE_ROUTER` (`rbac/v1/consts.gno:20`).

3. **Output form and `wugnot`.** Output is transferred as GRC20 from the router proxy to `rlm.Previous().Address()` (`router/v2/exact_in.gno:187`). The router never wraps or unwraps native `ugnot` and panics if `len(unsafe.OriginSend()) > 0` (`router/v2/exact_in.gno:131`, `common/v1/native_coin.gno:13-19`). Both input and output `wugnot` are ordinary GRC20 tokens (`gno.land/r/gnoland/wugnot.wugnot`), so a sub-address without coins works in both directions.

4. **Fees and return values.** Two fees apply: (a) pool LP fee (`pool.Fee()`, e.g. `3000` = 0.30%, with optional pool protocol split `slot0.FeeProtocol`, currently `0/0` on onyx-1) is taken from input inside `SwapMathComputeSwapStep` (`pool/v1/swap.gno:706-733`); (b) router fee (15 bps = 0.15% on onyx-1, max 1000 bps) is deducted from gross pool output via `floor(amountOut * swapFee / 10000)` (`router/v2/router.gno:220`, `router/v2/protocol_fee_swap.gno:83-110,167-174`). The two returned strings `(amountIn, amountOut)` are decimal `int64` strings: exact input consumed and **net** output delivered to `settleSub` after both fees (`router/v2/exact_in.gno:152-209`). Forwarding 100% of `amountOut` leaves zero balance.

5. **Argument formats and onyx-1 live pool.** Token paths are `grc20reg` keys (`pkgPath.SYMBOL`). `routeArr` is swap-directed `"<keyIn>:<keyOut>:<fee>"` (router sorts canonically at `router/v2/swap_inner.gno:31-36`). `amountIn` and `amountOutMin` are decimal base-unit strings; `sqrtPriceLimitX96 = "0"` disables price limits and enforces full `amountIn` consumption (`router/v2/router.gno:233-237`); `deadline` is Unix seconds (`now > deadline` panics, `router/v2/assert.gno:18-27`); `referrer = ""`. Working onyx-1 call on the sole live pool (`wugnot/GNS`, fee `3000`, balances `911764406` / `6574529713`):
   - `inputToken`: `"gno.land/r/gnoland/wugnot.wugnot"`, `outputToken`: `"gno.land/r/gnoswap/gns.GNS"`, `amountIn`: `"1000000"`, `routeArr`: `"gno.land/r/gnoland/wugnot.wugnot:gno.land/r/gnoswap/gns.GNS:3000"`, `amountOutMin`: `"4500000"`, `sqrtPriceLimitX96`: `"0"`, `deadline`: `time.Now().Unix()`, `referrer`: `""`.

6. **`DrySwapRoute`.** Signature: `DrySwapRoute(inputToken, outputToken, specifiedAmount, swapTypeStr, strRouteArr, quoteArr, tokenAmountLimit string) (string, string, error)` (`router/proxy.gno:109-117`, non-crossing). Realms may call it inside a transaction: it performs no writes, checks neither deadline nor halt, and catches internal panics via `defer recover()` (`router/v2/router_dry.gno:184-194`, `pool/v1/swap.gno:390-400`). Measured cost is **20.36M gas** per single-hop call, so only call it on-chain when multiple fee tiers exist.

7. **Halt and upgrade behavior.** Halting `OpTypeRouter` (`router/v2/exact_in.gno:129`) or `OpTypePool` (`pool/v1/swap.gno:201`) panics and reverts `SettleRing` atomically; halting `OpTypeProtocolFee` or `OpTypeEmission` does not block swaps (`router/v2/protocol_fee_swap.gno:139-143`, `emission/emission.gno:88-90`). Upgrades via `router.UpgradeImpl` (`router/upgrade.gno:41-55`, `version_manager.gno:146-173`) hot-swap the implementation behind the same proxy address and `IRouter` ABI (onyx-1 already runs `router/v2`), transparent to Kylix except that governance could change fee rates (bounded by `wantMin`) or future caller rules.

## Paste-Ready Gno Bridge

```go
package kylix

import (
	"chain"
	"strconv"
	"time"

	"gno.land/r/gnoswap/pool"
	"gno.land/r/gnoswap/router"
	"gno.land/r/nt/grc20reg/v0"
)

const gnoswapRouterPath = "gno.land/r/gnoswap/router"

var gnoswapFeeTiers = [4]uint32{100, 500, 3000, 10000}

// Call non-crossing from SettleRing as bridge(cur, ...) so cur and slot stay current.
func bridge(cur realm, keyIn, keyOut string, from, to address, slot realm, amountIn, wantMin int64) int64 {
	if keyIn == keyOut {
		panic("kylix: bridge requires distinct tokens")
	}
	if amountIn <= 0 || wantMin < 0 {
		panic("kylix: invalid bridge amounts")
	}

	amtInStr := strconv.FormatInt(amountIn, 10)
	minStr := strconv.FormatInt(wantMin, 10)
	route := pickRoute(keyIn, keyOut, amtInStr, minStr)

	settleSub := cur.Sub("settle")
	routerAddr := chain.PackageAddress(gnoswapRouterPath)

	grc20reg.TransferFrom(0, slot, keyIn, from, settleSub.Address(), amountIn)
	grc20reg.Approve(0, settleSub, keyIn, routerAddr, amountIn)
	inUsedStr, outStr := router.ExactInSingleSwapRoute(
		cross(settleSub),
		keyIn,
		keyOut,
		amtInStr,
		route,
		minStr,
		"0",
		time.Now().Unix(),
		"",
	)
	grc20reg.Approve(0, settleSub, keyIn, routerAddr, 0)

	inUsed, err := strconv.ParseInt(inUsedStr, 10, 64)
	if err != nil || inUsed != amountIn {
		panic("kylix: unexpected router input consumed")
	}
	got, err := strconv.ParseInt(outStr, 10, 64)
	if err != nil || got < wantMin || got <= 0 {
		panic("kylix: insufficient bridge output")
	}

	grc20reg.Transfer(0, settleSub, keyOut, to, got)
	return got
}

func pickRoute(keyIn, keyOut, amtInStr, minStr string) string {
	var found []uint32
	for _, fee := range gnoswapFeeTiers {
		if pool.ExistsPoolPath(pool.GetPoolPath(keyIn, keyOut, fee)) {
			found = append(found, fee)
		}
	}
	if len(found) == 0 {
		panic("kylix: no gnoswap pool for pair")
	}
	if len(found) == 1 {
		return keyIn + ":" + keyOut + ":" + strconv.FormatUint(uint64(found[0]), 10)
	}

	bestRoute := ""
	bestOut := int64(-1)
	for _, fee := range found {
		route := keyIn + ":" + keyOut + ":" + strconv.FormatUint(uint64(fee), 10)
		_, outStr, err := router.DrySwapRoute(keyIn, keyOut, amtInStr, "EXACT_IN", route, "100", minStr)
		if err != nil {
			continue
		}
		out, err := strconv.ParseInt(outStr, 10, 64)
		if err == nil && out > bestOut {
			bestOut = out
			bestRoute = route
		}
	}
	if bestRoute == "" {
		panic("kylix: no gnoswap pool satisfies bridge")
	}
	return bestRoute
}
```

## Proof Run and Remaining Gaps

Copied all 33 real onyx-1 GnoSwap packages unmodified into `S/kylix-lab/gnoswap` and ran `GNOROOT=S/gno-v180 gno test -v -print-runtime-metrics ./kylixbridge`:

```text
Test01_RealGnoSwapBridgeFromSubAddress  PASS  187,536,891 gas  (upgrade v1->v2, wugnot->GNS 1000000->990387 + 1487 fee, GNS->wugnot 990387->991051 with 0 native ugnot moved, 0 settleSub leftovers/allowances, ProtocolFee halt passes, Router halt panics)
Test02_DrySwapRouteIsolatedGas          PASS   20,358,508 gas  (in=100000 out=99392)
Test03_SettleBridgeIsolatedGas          PASS   33,547,612 gas  (in=100000 out=99392)
```

Live read-only onyx-1 queries confirmed `router/v2` active (`15 bps`), `pool/v1` active (`1` pool, `0/0` pool protocol fee), and `DrySwapRoute` returning `("1000000", "4556245", nil)` on `wugnot->GNS:3000`.

**Unverified:** live on-chain transaction execution (prohibited here), and active `staker/v1` tick-cross hooks / live `emission` minting during a swap (audited in source as caller-agnostic, not activated in the local test).
