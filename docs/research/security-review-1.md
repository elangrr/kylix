# Kylix Independent Security Review

Reviewed snapshot: `<scratch>/kylix-lab/review/snapshot/` against Gno `v1.8.0` (`gno-v180`) and the onyx-1 GnoSwap / Sinopia3 / MNS `nsnft` / `grc20reg` sources.

Below, `S` denotes `<scratch>`.

---

## Findings

### 1. [CRITICAL] Atomic Liquidity Rug-Pull on GnoSwap Position NFTs (`r/adapters/gnft`)

- **Location:** `r/adapters/gnft/adapter.gno:38-60` (`Move`, `OwnerOf`, `Approved`)
- **Confidence:** Confirmed (demonstrated against real GnoSwap `position/v1`, `pool/v1`, `gnft`, `r/adapters/gnft`, and `r/kylix`).
- **Scenario & Attacker Steps:**
  A GnoSwap LP Position NFT (`gnft`) is a mutable container whose economic value is its underlying pool liquidity and uncollected fees. In `gno.land/r/gnoswap/position/v1/position.gno:256-289`, `position.DecreaseLiquidity` removes 100% of a position's liquidity and accrued fees **without burning the NFT and without clearing its GRC721 approval**. Because `r/adapters/gnft` identifies items solely by bare `TokenID` and checks only `gnft.OwnerOf` and `gnft.GetApproved`, a seller can steal a counterparty's entire payment atomically:
  1. Alice owns GnoSwap position `#2` holding ~20M `wugnot` + ~20M `GNS` (`liquidity = 77169226`).
  2. Alice approves `kylix.ApproveTarget(alice, nonce, gnftKey)` for token `"2"` and posts a Kylix offer: Give GNFT `"2"`, Want `30,000,000 wugnot`.
  3. Bob inspects position `#2` on-chain, sees ~40M `wugnot` of LP value, approves his slot for `30,000,000 wugnot`, and posts an offer: Give `30,000,000 wugnot`, Want GNFT `"2"`.
  4. In a single atomic `MsgRun` transaction (zero execution risk, impossible for Bob to cancel or react), Alice calls:
     - `position.DecreaseLiquidity(cross(cur), 2, "77169226", "0", "0", deadline)` — receives `19,999,999 wugnot` + `19,999,999 GNS` back while keeping GNFT `#2` and its approval to `gnftadapter.SpenderFor(slot)`.
     - `kylix.SettleRing(cross(cur), aliceOffer+","+bobOffer)` — settles the ring immediately.
  5. Settlement succeeds: Alice keeps 100% of her LP tokens **and** receives Bob's `30,000,000 wugnot`; Bob receives an empty GNFT `#2` with `liquidity == 0`.
- **Demonstration:**
  - Test: `S/kylix-lab/review/work/gnoswap-poc/kylixpoc/security_poc_test.gno` (`Test01_Critical_GNFTAtomicLiquidityRugPull`) *(note: `gnoswap-kylix` omitted `staker/v1`, so `work/gnoswap-poc/gno.land/r/gnoswap/staker/getter.gno:558` adds a 1-line `if implementation == nil { return 0 }` guard for `GetPoolTier`, which returns 0 on unassigned pools on onyx-1)*.
  - Command:
    ```bash
    cd S/kylix-lab/review/work/gnoswap-poc && GNOROOT=S/gno-v180 GNOHOME=S/kylix-lab/review/work/.gnohome gno test -v -run 'Test00|Test01' ./kylixpoc
    ```
  - Observed output:
    `EXPLOIT SUCCEEDED: drained (19999999 wugnot, 19999999 GNS) back to Alice; Alice gained +49999999 wugnot and +19999999 GNS; Bob lost -30000000 wugnot and received GNFT #2 with liquidity=0`
- **Smallest Fix:**
  Bind position invariants into `r/adapters/gnft`'s item ID format — e.g. `"<tokenID>:<tickLower>:<tickUpper>:<minLiquidity>"` (or `"<tokenID>:<minLiquidity>"`; both `:` and `-` are already permitted by `kylix.validItemID` within 64 chars). Import `gno.land/r/gnoswap/position` in `r/adapters/gnft` (acyclic: `position` imports `gnft`, not vice versa), parse the pinned parameters in `OwnerOf` / `Approved` / `Move`, and reject (`return false` / return error before `gnft.TransferFrom`) if `position.GetPositionLiquidity(tid) < minLiquidity` or tick bounds changed via `Reposition`. Also document that accrued fees (`CollectFee`) are still claimable prior to settlement so buyers must price only principal liquidity.

---

### 2. [HIGH] Hostile Collection Storage-Deposit Drain via Non-Crossing `OwnerFn` / `ApprovedFn` (and `MoveFn`)

- **Location:** `r/kylix/settle.gno:64,110,113,121-155`, `r/kylix/prune.gno:17,54`, `r/kylix/collections.gno:31-38,75-123`
- **Confidence:** Confirmed (cross-realm storage mutation demonstrated with `gno test` storage metering; deposit billing and refund verified in `gno-v180/gno.land/pkg/sdk/vm/keeper.go:2469-2600`).
- **Scenario & Attacker Steps:**
  `r/kylix/settle.gno:122` states that `undeliverable(o)` "writes nothing" because `OwnerFn` and `ApprovedFn` run without crossing. That is **false** under Gno Interrealm v2 (`gno-interrealm-v2.md` §4.1, Borrow Rule #1): any function declared in `/r/evil` borrows `m.Realm = /r/evil` when invoked from Kylix, giving it full write authority over `/r/evil`'s persisted storage.
  On Gno.land v1.8.0 (`keeper.go:2469-2598`), `processStorageDeposit` charges the **transaction sender** (`caller`) `100 ugnot/byte` for *every* realm whose storage grew during the tx, up to `msg.MaxDeposit` — and when `msg.MaxDeposit` is omitted (`0`), the VM **silently falls back to `params.DefaultDeposit`** (`keeper.go:2484-2485`). Whoever later frees those bytes receives the refund (`keeper.go:2591-2598`).
  1. Attacker deploys `/r/evil/storagebomb`, registers it via `RegisterItem` + `RegisterApprovalCheck`, and posts an undeliverable bait offer (to attract pruners/flaggers seeking Kylix's storage refund) or a bait ring (to attract settlers).
  2. Victim calls `FlagIntent`, `PruneIntent`, or `SettleRing` without a tight non-zero `MaxDeposit` (e.g., relying on wallet default or omitting `MaxDeposit`).
  3. Inside `OwnerOf` / `Approved` (during `FlagIntent`, `PruneIntent`, or `SettleRing` preflight) or `Move` (during `SettleRing`), `/r/evil/storagebomb` appends e.g. 8 KB–100 KB to a package-level slice and returns normally so the transaction succeeds.
  4. `processStorageDeposit` debits `100 ugnot/byte` from the victim into `/r/evil/storagebomb`'s storage escrow (up to `MaxDeposit` or `DefaultDeposit`).
  5. Next transaction, the attacker calls `/r/evil/storagebomb.Drain()` to clear the slice and receives the victim's locked GNOT as a storage deposit refund.
  Notice that for `FlagIntent` and `PruneIntent`, the victim never chose to want or trust the hostile collection — they were simply pruning stale offers as Kylix encourages.
- **Demonstration:**
  - Tests:
    - Cross-realm filetest: `S/kylix-lab/review/work/r/kylix/filetests/z_security_storagebomb_filetest.gno` + `S/kylix-lab/review/work/r/mocks/storagebomb/storagebomb.gno`
    - In-package test: `S/kylix-lab/review/work/r/kylix/security_review_test.gno` (`TestSecurity_Finding2_NonCrossingCallbacksWriteStorage`)
  - Commands:
    ```bash
    cd S/kylix-lab/review/work && GNOROOT=S/gno-v180 GNOHOME=S/kylix-lab/review/work/.gnohome gno test -v ./r/kylix | grep -A1 z_security_storagebomb
    cd S/kylix-lab/review/work && GNOROOT=S/gno-v180 GNOHOME=S/kylix-lab/review/work/.gnohome gno test -v -run TestSecurity_Finding2 ./r/kylix
    ```
  - Observed output:
    `--- PASS: ./r/kylix/z_security_storagebomb_filetest.gno (elapsed: 0.04s, gas: 13066801, storage: gno.land/r/nym-kylix000/kylix:+27b gno.land/r/nym-kylix000/mocks/storagebomb:+8638b)`
    (8,638 bytes = 0.8638 GNOT charged to `FlagIntent`'s caller in a single call, trivially scalable up to `MaxDeposit`/`DefaultDeposit`.)
- **Smallest Fix:**
  Gno v1.8.0 has no read-only cross-realm call mode, so Kylix cannot stop an arbitrary registered realm from writing to its own storage. Mitigate at the design and caller boundary:
  1. Correct the misleading comments/docs (`settle.gno:122`, `DESIGN.md`) and prominently warn wallets, solvers, and pruner bots to **never** auto-call `FlagIntent`, `PruneIntent` (non-expired), or `SettleRing` on untrusted (`Official == false`) collections without setting a strict tiny **non-zero** `MaxDeposit` (e.g. `1ugnot` for `PruneIntent`, since `0` falls back to `DefaultDeposit`!).
  2. Optionally add a `requireOfficial` / allowlist flag or separate entry point for automated bots, and note that `PruneIntent` on *expired* offers already skips `undeliverable(o)` and is safe.

---

### 3. [HIGH] GnoSwap Bridge Pool Selection (`bridgeFee`) Can Be Jammed (DoS) or Hijacked by a Decoy Fee-Tier Pool

- **Location:** `r/kylix/bridge.gno:40-62` (`bridgeFee`), `r/kylix/settle.gno:67-72`
- **Confidence:** Confirmed (demonstrated against real GnoSwap `pool/v1`, `position/v1`, `router/v2`, and `r/kylix`).
- **Scenario & Attacker Steps:**
  `bridgeFee(keyIn, keyOut)` iterates `{100, 500, 3000, 10000}` and hard-codes whichever pool has the highest `pool.GetBalances(path)` of `keyOut`. In GnoSwap (Uniswap v3 concentrated liquidity), `pool.GetBalances` (`pool/pool.gno:64-70`) returns total token reserves across **all ticks**, including **out-of-range positions** and uncollected fees, ignoring active liquidity, spot price, and fee tier (up to 100× fee spread). `SettleRing` accepts no fee-tier hint and has no fallback, so every bridged ring for `(keyIn, keyOut)` is locked to that one pool.
  1. Suppose `wugnot/GNS:3000` is the real market pool with ~41.8M `GNS` in-range around 1:1 (swapping 1M `wugnot` yields ~907,629 `GNS`).
  2. Attacker creates the unused `wugnot/GNS:10000` (1%) pool at tick 0 and mints a single-sided **out-of-range** position at ticks `[-60000, -40000]` depositing `51,785,087 GNS` and **`0 wugnot`** (fully withdrawable anytime via `DecreaseLiquidity`; price at tick `-40000` is ~54× worse than 1:1).
  3. `pool.GetBalances(wugnot:GNS:10000)` reports `51,785,087 GNS > 41,785,087 GNS`, so `bridgeFee` unconditionally selects fee `10000`.
  4. **Impact A (Bridge DoS):** Every bridged `wugnot -> GNS` ring with a realistic `wantMin` (e.g., `500,000 GNS` for `1,000,000 wugnot`) now permanently aborts with slippage (`got: 18105 < min: 500000`), even though the 3000-fee pool has 41.8M `GNS` and quotes `907,629 GNS`.
  5. **Impact B (Worse-Price Pool Hijacking):** If the attacker instead places out-of-range liquidity just above a victim's `wantMin`, Kylix forces the ring's swap into the attacker's 1% pool instead of the deep 0.3% pool, letting the attacker capture the spread. Even without malice, an organic pair with higher out-of-range balance in a 10000-fee pool breaks bridged rings when active liquidity lives in a 500- or 3000-fee pool.
  6. Minor sub-bug: `bestReserve` starts at `-1` (`bridge.gno:42`), so an empty pool with `reserve == 0` still passes preflight and wastes gas before failing inside the router.
- **Demonstration:**
  - Test: `S/kylix-lab/review/work/gnoswap-poc/kylixpoc/security_poc_test.gno` (`Test03_High_BridgeFeePoolHijackDoS`)
  - Command:
    ```bash
    cd S/kylix-lab/review/work/gnoswap-poc && GNOROOT=S/gno-v180 GNOHOME=S/kylix-lab/review/work/.gnohome gno test -v -run 'Test00|Test03' ./kylixpoc
    ```
  - Observed output:
    ```
    Healthy 3000-fee pool has 41785087 GNS
    Attacker created decoy 10000-fee pool using (0 wugnot, 51785087 GNS); GetBalances=51785087 GNS > 3000-pool 41785087 GNS
    3000-fee pool DrySwapRoute(1,000,000 wugnot) -> 907629 GNS (easily >= 500,000)
    BRIDGE JAMMED (DoS confirmed): SettleRing aborted with: [GNOSWAP-ROUTER-001] slippage check failed || ExactIn: too few received (min:500000, got:18105)
    ```
- **Smallest Fix:**
  Allow the settler to pass the fee tier (`SettleRingWithFee(cur realm, ids string, fee uint32)` or a `fee` arg on `SettleRing`, falling back to `bridgeFee` only when `fee == 0` and requiring `reserve > 0` in `bridgeFee`). Validate `fee` is one of `{100, 500, 3000, 10000}` and the pool exists. Off-chain solvers can call `router.DrySwapRoute` at zero gas to pick the optimal pool, and `wantMin` still protects the receiver.

---

### 4. [MEDIUM] `r/adapters/sinopia3` Panics on Unknown/Malformed Collection IDs (Unprunable Poison Offers & `Deliverable` Batch DoS) and Misses Pre-Reveal Lock in `Approved`

- **Location:** `r/adapters/sinopia3/adapter.gno:50-74` (`OwnerOf`, `Approved`), `r/kylix/deliverable.gno:46`, `r/kylix/prune.gno:17,54`
- **Confidence:** Confirmed (demonstrated against real `sinopia3/core`, `r/adapters/sinopia3`, and `r/kylix`).
- **Scenario & Attacker Steps:**
  1. **Poison CID DoS & Unprunable Offers:** `sinopia3/core.OwnerOf(cid, tid)` and `core.Token(cid)` both call `mustCollection(cid)` -> `collKey(cid)` -> `safe.ParseID("cid", cid)`, which **panics** for any `cid` that is not an existing collection (`1..core.CollectionCount()`, e.g., `"999999"` or `"abc"`). `r/adapters/sinopia3/adapter.gno:50-74` does not validate `cid` before calling `core`. Meanwhile `kylix.PostIntent` only checks `validItemID` (which accepts `"999999/1"` and `"abc/1"`).
     - Attacker calls `kylix.PostIntent(cross(cur), "item", sinopiaKey, "999999/1", 0, "fungible", obolKey, "", 1, 0)` (costs ~0.06 GNOT, no expiry).
     - `kylix.FlagIntent(id)` panics (`unknown collection "999999"`), so the offer can **never be flagged and never be pruned** (`PruneIntent` permanently fails).
     - Any solver calling `kylix.Deliverable("1,2,<poison_id>,...")` to batch-screen up to 50 open offers from `ExportGraphJSON()` **aborts the entire batch** with an unrecoverable cross-realm panic.
  2. **Pre-Reveal Lock False Positive in `Approved`:** Unlike `r/adapters/nsnft/adapter.gno:47` (which checks `nsnft.IsLocked`), `sinopia3.Approved` (`adapter.gno:63-74`) does not check whether the collection is `StateFinal`. Because `core.Approve` succeeds before Final, an approved offer on a pre-reveal locked collection reports `"deliverable": true` in `Deliverable`, refuses `FlagIntent`, passes `SettleRing` preflight, deletes all offers in the ring, executes earlier hops, and then panics inside `sinopia3/core`'s `OnTransfer` hook — wasting settler gas on every attempt.
- **Demonstration:**
  - Tests:
    - `S/kylix-lab/review/work/r/adapters/adaptertest/b_sinopia3_security_test.gno` (`TestB_Security_Sinopia3PoisonCIDAndUnprunableOffer`)
    - `S/kylix-lab/review/work/r/adapters/adaptertest/d_sinopia3_locked_approved_test.gno` (`TestD_Security_Sinopia3LockedApprovedFalsePositive`)
  - Command:
    ```bash
    cd S/kylix-lab/review/work && GNOROOT=S/gno-v180 GNOHOME=S/kylix-lab/review/work/.gnohome gno test -v ./r/adapters/adaptertest
    ```
  - Observed output: both tests PASS, confirming `FlagIntent` and batched `Deliverable` abort with `unknown collection "999999"`, `PruneIntent` is permanently blocked, and `sinopia3adapter.Approved` returns `true` for a non-Final locked token.
- **Smallest Fix:**
  In `r/adapters/sinopia3/adapter.gno`, add `validCID(cid string) bool` verifying `cid` is a canonical positive decimal `1 <= n <= core.CollectionCount()` (digits only, no leading zero) and return `""` / `false` in `OwnerOf` / `Approved` when false. In `Approved`, also check `if core.Info(cid).State != types.StateFinal { return false }`.

---

### 5. [MEDIUM] Single-Transaction Atomic Sandwiching of Bridged Rings via `MsgRun`

- **Location:** `r/kylix/bridge.gno:70-96` (`bridgeHop`), `r/kylix/settle.gno:36-98` (`SettleRing`)
- **Confidence:** Confirmed (demonstrated against real GnoSwap `router/v2` + `pool/v1` and `r/kylix`).
- **Scenario & Attacker Steps:**
  Because `SettleRing` is permissionless and Gno.land supports arbitrary multi-call transactions via `MsgRun` (and helper realms), **any unprivileged account with capital** — without needing validator/mempool control — can atomically sandwich any bridged ring in a single transaction with zero execution risk, extracting 100% of the surplus between pool price and the receiver's `wantMin`:
  1. Alice posts `10,000,000 wugnot -> >= 1,000 GNS`, Bob posts `relic-1 -> >= 6,500,000 GNS` (bridged; market output ~9M GNS), Carol posts `1,000 GNS -> relic-1`.
  2. Attacker submits one `MsgRun` transaction (0 native coins sent) that:
     - Front-runs: swaps `15,000,000 wugnot -> 13,858,301 GNS` on `router.ExactInSingleSwapRoute` to push GNS price up.
     - Calls `kylix.SettleRing(cross(cur), ringIDs)` — Bob receives `8,181,805 GNS` (still `>= 6,500,000`, so settlement succeeds).
     - Back-runs: swaps `13,858,301 GNS -> 16,274,911 wugnot` back on the router.
  3. Attacker nets `+1,274,911 wugnot` risk-free (plus the storage deposit refund from settling the ring), extracted directly from Bob's surplus. (If the front-run pushes output below `wantMin`, the entire `MsgRun` aborts and costs only gas.)
  4. Note: `wantMin` is still respected (so Bob does not receive less than his stated minimum), which is why this is Medium rather than Critical/High.
- **Demonstration:**
  - Test: `S/kylix-lab/review/work/gnoswap-poc/kylixpoc/security_poc_test.gno` (`Test02_Medium_SingleTxAtomicSandwichBridgedRing`)
  - Command:
    ```bash
    cd S/kylix-lab/review/work/gnoswap-poc && GNOROOT=S/gno-v180 GNOHOME=S/kylix-lab/review/work/.gnohome gno test -v -run 'Test00|Test02' ./kylixpoc
    ```
  - Observed output:
    `SANDWICH SUCCEEDED: front=13858301 GNS, back=16274911 wugnot, attacker net profit=+1274911 wugnot; Bob got 8181805 GNS (min 6,500,000)`
- **Smallest Fix:**
  This is inherent to on-chain AMM bridging guarded only by a static `wantMin`. Make `wantMin` warnings explicit in docs/UI (treat `wantMin` as the exact execution floor, encourage tight `wantMin` and short `expiry` for bridged offers, and prefer direct rings when available).

---

### 6. [MEDIUM] Unbounded Expired-Offer Scan in `ExportGraphJSONPage` (and Unpaginated `collections` Listing)

- **Location:** `r/kylix/export.gno:64-92` (`exportJSON`), `r/kylix/render.gno:91-102` (`collectionList`)
- **Confidence:** Confirmed (demonstrated for `ExportGraphJSONPage`; reasoned for `collections`).
- **Scenario & Attacker Steps:**
  `ExportGraphJSONPage(after, limit)` is intended to cap read gas regardless of book size (`export.gno:12-13`). However:
  1. In `exportJSON` (`export.gno:76-92`), expired offers are skipped (`if expired(o, h) { return false }`) without counting against `limit` or any scan cap. If an attacker posts `K` short-lived offers (`expiry = height + 1`, ~0.06 GNOT refundable deposit each; can be batched in `MsgRun`), once expired at `height + 2` a single `ExportGraphJSONPage(after, 1)` call decodes and scans all `K` expired offers in one query, defeating pagination and hitting read-gas limits until pruners delete them.
  2. Additionally, `if limit >= 0 && count == limit` is checked *before* `expired(o, h)`, so whenever all remaining offers after a full page are expired, `ExportGraphJSONPage` spuriously returns `"hasMore":true` and forces an extra empty page scan.
  3. Both `ExportGraphJSONPage` (`export.gno:64-71`) and `Render("")` / `Render("offers/<id>")` (`render.gno:56,96-100`) iterate the entire `collections` tree without pagination on every single page call. (Higher attack cost since each registration requires deploying a distinct realm, ~0.3+ GNOT per entry, but still unbounded.)
- **Demonstration:**
  - Test: `S/kylix-lab/review/work/r/kylix/security_review_test.gno` (`TestSecurity_Finding5_ExportGraphJSONPageExpiredScan`)
  - Command:
    ```bash
    cd S/kylix-lab/review/work && GNOROOT=S/gno-v180 GNOHOME=S/kylix-lab/review/work/.gnohome gno test -v -run TestSecurity_Finding5 ./r/kylix
    ```
  - Observed output: PASS (`ExportGraphJSONPage(0, 1)` returned `"hasMore":true` despite 0 active offers remaining, and the follow-up `ExportGraphJSONPage(active, 1)` scanned all 200 expired offers in one call).
- **Smallest Fix:**
  Count `scanned++` in `eachOfferAfter` and break once `count == limit || (limit >= 0 && scanned >= MaxExportPage)`, returning `next = last` so callers step across expired stretches in O(`MaxExportPage`) bounded gas. In `ExportGraphJSONPage`, omit `collections` when `after > 0` (or add a dedicated paginated `ExportCollectionsJSONPage`).

---

### 7. [LOW] Read-Only Re-Entrancy Window During `SettleRing`

- **Location:** `r/kylix/settle.gno:75-91`, `r/kylix/kylix.gno:159-169`, `r/kylix/deliverable.gno:26`, `r/kylix/export.gno:38-55`
- **Confidence:** Confirmed (demonstrated in `gno test`).
- **Scenario & Attacker Steps:**
  `SettleRing` sets `locked = true` and deletes all `n` offers (`settle.gno:76-78`) before moving any asset, while read-only functions (`GetOffer`, `OpenOffers`, `Deliverable`, `ExportGraphJSON`, `ExportGraphJSONPage`, `Render`) do not check `locked`. During hop `i`'s `MoveFn` callback, a hostile collection (or another realm invoked by it) can call `kylix.GetOffer(offs[j].ID)` for a later hop `j > i` and observe it already closed (`false`) even though hop `j`'s asset has not moved yet (while earlier hops' assets have already moved). This does not break Kylix's own invariants, but could mislead a third-party realm that queries `GetOffer`/`OpenOffers` mid-transaction.
- **Demonstration:**
  - Test: `S/kylix-lab/review/work/r/kylix/security_review_test.gno` (`TestSecurity_Finding6_ReadOnlyReentrancyDuringSettle`)
  - Command:
    ```bash
    cd S/kylix-lab/review/work && GNOROOT=S/gno-v180 GNOHOME=S/kylix-lab/review/work/.gnohome gno test -v -run TestSecurity_Finding6 ./r/kylix
    ```
- **Smallest Fix:**
  Add `if locked { panic("kylix: settlement in progress") }` at the top of `GetOffer`, `OpenOffers`, `Deliverable`, `ExportGraphJSON`, and `ExportGraphJSONPage`.

---

### 8. [LOW] `guard()` Unconditionally Rejects `unsafe.OriginSend()`, Breaking `MsgRun` `wugnot.Deposit` Bundling and Payable-Realm Composability

- **Location:** `r/kylix/kylix.gno:172-181` (`guard`)
- **Confidence:** Confirmed (demonstrated in `gno test`; verified against `gno-v180/gno.land/pkg/sdk/vm/keeper.go:1478`).
- **Scenario & Attacker Steps:**
  `guard()` panics whenever `len(unsafe.OriginSend()) > 0`, without checking `cur.Previous().IsUserCall()`. Because `unsafe.OriginSend()` exposes the tx-root coin envelope across the whole call stack (`chain/runtime/unsafe/unsafe.gno:55-64`), a user cannot bundle `wugnot.Deposit` (sending native `ugnot`) + `wugnot.Approve` + `kylix.PostIntent` in a single `MsgRun` transaction, and no payable realm can call `PostIntent`, `SettleRing` (direct rings), `CancelIntent`, `FlagIntent`, or `PruneIntent` after accepting GNOT from a user — even though 0 coins were sent to Kylix. (Both `nsnft/v2/nsnft.gno:258` and `sinopia3/core/core.gno:202` gate their no-send check with `cur.Previous().IsUserCall()` for exactly this reason; on Gno v1.8.0, `MsgCall` also independently rejects unobserved sends at `keeper.go:1478`.)
- **Demonstration:**
  - Test: `S/kylix-lab/review/work/r/kylix/security_review_test.gno` (`TestSecurity_Finding7_GuardRejectsOriginSendFromRealmCaller`)
  - Command:
    ```bash
    cd S/kylix-lab/review/work && GNOROOT=S/gno-v180 GNOHOME=S/kylix-lab/review/work/.gnohome gno test -v -run TestSecurity_Finding7 ./r/kylix
    ```
- **Smallest Fix:**
  Pass `cur` to `guard(cur)` and check `if cur.Previous().IsUserCall() && len(unsafe.OriginSend()) > 0` (note: bridged `SettleRing` calls still fail if `OriginSend` is non-empty because GnoSwap's `router/v2` checks `OriginSend` unconditionally).

---

### 9. [LOW] Stale `FlaggedAt` Persists After Offer Recovery, Allowing Zero-Grace Pruning on Any Future Brief Dip

- **Location:** `r/kylix/prune.gno:14-63` (`FlagIntent`, `PruneIntent`)
- **Confidence:** Confirmed (demonstrated in `gno test`).
- **Scenario & Attacker Steps:**
  1. Alice posts an offer first and approves in a second transaction (instead of bundling). In between, an attacker calls `FlagIntent(id)`, recording `o.FlaggedAt = H`.
  2. Alice approves her slot; she is unaware of the flag and never calls `FlagIntent` to clear it.
  3. After `H + PruneGraceBlocks` (17,280 blocks), the offer is healthy, so `PruneIntent` fails. However, if Alice's balance later dips below `o.Give.Amount` for even 1 block (e.g., during wallet rebalancing), an attacker can immediately call `PruneIntent(id)` with **zero grace period** and collect Alice's storage deposit.
- **Demonstration:**
  - Test: `S/kylix-lab/review/work/r/kylix/security_review_test.gno` (`TestSecurity_Finding8_StaleFlagAllowsZeroGracePrune`)
  - Command:
    ```bash
    cd S/kylix-lab/review/work && GNOROOT=S/gno-v180 GNOHOME=S/kylix-lab/review/work/.gnohome gno test -v -run TestSecurity_Finding8 ./r/kylix
    ```
- **Smallest Fix:**
  Acceptable trade-off given `FlagIntent` is callable by the owner to clear it; highlight flagged status in `offerTable` (`render.gno:75-79`) and advise wallets/UIs to bundle approve+post or call `FlagIntent` after topping up.

---

### 10. [LOW] `renderOffer` Shows `Slot` Instead of `ApproveTarget` for Adapter Offers and Omits Official/Unofficial Label

- **Location:** `r/kylix/render.gno:131-134,153-161`
- **Confidence:** Confirmed by code inspection.
- **Scenario:**
  On `offer/<id>`, `renderOffer` displays `- Slot: <SlotAddress> (nonce N)` and never prints `ApproveTarget(o.Owner, o.Nonce, o.Give.Key)`. For adapter items (`gnft`, `sinopia3`, `nsnft`), approving `SlotAddress` is wrong — the owner must approve `DerivePkgSubAddr(adapter, "k/"+slot)`. In addition, `assetNote` renders `" in " + name` without `collectionLabel(a.Key)`, so an unofficial adapter reusing the exact display name `"GnoSwap Positions (GNFT)"` is not flagged as unofficial on the offer detail page (only its key path distinguishes it).
- **Smallest Fix:**
  On `renderOffer`, emit `- Approve: ` + `sanitize.InlineText(ApproveTarget(o.Owner, o.Nonce, o.Give.Key).String())` when it differs from `SlotAddress`, and append `(" + collectionLabel(a.Key) + ")` in `assetNote`.

---

### 11. [LOW] Test Suite Gaps and Vacuous/Misleading Assertions

- **Location:** `r/kylix/helpers_test.gno:122`, `r/kylix/settle_test.gno:48,199,248-257`, `r/mocks/gnoswap/pool/pool.gno:47-55`, `r/kylix/kylix_test.gno:96-149`, `r/adapters/adaptertest/a_gnft_test.gno:24-54`, `r/adapters/adaptertest/c_sinopia3_test.gno:95-105`
- **Confidence:** Confirmed by code inspection.
- **Concrete Issues Found:**
  1. `helpers_test.gno:122`: `aborts()` unconditionally sets `locked = false` after every abort. Consequently, `uassert.False(t, locked)` in `settle_test.gno:199` is **vacuous** — it would still pass even if `SettleRing` took `locked = true` before preflight. (The `isOpen(id)` checks on lines 196–198 do genuinely prove preflight ran before `removeOffer`.)
  2. `settle_test.gno:48`: `TestTwoLegRing` checks `bal(barKey, SlotAddress(alice, 2))` — the token Alice *wanted* rather than the token she *gave* (`fooKey`), with a hardcoded nonce `2` that only matches due to prior test execution order.
  3. `r/mocks/gnoswap/pool/pool.gno:47-55`: `GetBalances` returns the pool realm's shared aggregate token balance for every fee tier, unlike real GnoSwap `pool/v1` which stores per-pool `p.balances.token0 / token1`. Furthermore, **no test** creates two pools for one pair, so `bridgeFee`'s multi-pool selection logic is completely untested.
  4. `r/kylix/bridge.gno:88-90` (`router allowance left after the swap`) is never reached in `z_bridge_partial_filetest.gno` because `used != amountIn` (`bridge.gno:83-85`) panics first.
  5. Untested guards: `collections.gno:133` (sub-identity registration rejection), `RegisterAdapter` and `RegisterApprovalCheck` in `TestLockRefusesReentry` (`settle_test.gno:248-257`), and `runtime.GetSessionInfo()` (replaced by a stub `sessionCheck` in `kylix_test.gno:98`).
  6. `a_gnft_test.gno` mints directly on `gnft` without `gnoswap/position`, missing Finding 1; `c_sinopia3_test.gno:95-105` (`TestSinopia3LockedZZ`) accepts the post-lock `OnTransfer` panic under `gno test`'s no-rollback harness and never checks `sinopia3.Approved` or invalid `cid`s (Finding 4).
- **Smallest Fix:**
  Check `locked` before clearing it in `aborts` (or add a `preflightAborts` helper that asserts `!locked`), track per-pool balances in `r/mocks/gnoswap/pool`, add multi-pool / sub-identity / `RegisterAdapter`+`RegisterApprovalCheck` lock tests, and add `position.DecreaseLiquidity` + `sinopia3` invalid-CID regression tests.

---

## Attack-Surface Coverage Summary

1. **Slot isolation:** Tested nonce monotonicity, cancel/settle non-reuse, two offers by one owner, surplus allowance, cross-owner slot approval, and hostile `MoveFn` attempting `grc20reg.TransferFrom(0, cur.Previous(), ...)`. **Held:** `nonces` never resets, `w/<owner>/<nonce>` is unique per offer, `SettleRing` deletes offers before moving, and `slot.IsCurrent()` blocks foreign realms from reusing the slot token.
2. **Economic soundness of a ring:** Audited `p/ring` (`Verify`, `VerifyBridged`, `VerifyWithBridge`, `validateLegs`, `satisfies`), `int64` overflow (`grc20` uses `overflow.Add64p`/`Sub64p`), zero/negative amounts, `give == want`, duplicate offer/owner/item, and self-trading across two addresses. **Held for core ring math** (two-address self-trade still satisfies every third party's `wantMin`), **except** mutable-value NFTs like GNFT where ownership of the same ID no longer guarantees the asset's value (**Finding 1 — Critical**).
3. **Hostile collections and adapters:** Tested `MoveFn`, `OwnerFn`, and `ApprovedFn` re-entry across all state-changing and read-only entry points, state mutation in non-crossing callbacks, `/p/` laundering via `ItemID`, and post-registration mutation. **Mixed:** `ItemID` successfully blocks `/p/` functions from gaining Kylix's storage authority (Borrow Rule #1 isolates `/r/` callbacks), and `guard()` blocks state-changing re-entry; however, non-crossing `OwnerFn`/`ApprovedFn` **can** mutate their own realm's storage (**Finding 2 — High**), read-only functions don't check `locked` (**Finding 7 — Low**), and while Kylix prevents re-registering a realm (only allowing a one-time late `RegisterApprovalCheck`), a hostile realm can still swap its internal behavior via its own mutable state.
4. **Adapters:** Audited `gnft`, `sinopia3`, `nsnft`, `ApproveTarget`, `IsOfficial`, and `validTarget`. **Mixed:** `k/<slot>` isolation and `IsOfficial` (`gno.land/r/<namespace>/` trailing slash) held against forged slots and look-alike namespaces; however, `r/adapters/gnft` allows atomic liquidity rug-pulls (**Finding 1 — Critical**), `r/adapters/sinopia3` panics on unknown/malformed `cid`s and ignores pre-reveal locks in `Approved` (**Finding 4 — Medium**), and an unofficial adapter can still copy an official adapter's display name and `target` (partially hidden on `offer/<id>`, **Finding 10 — Low**).
5. **Hostile tokens (`grc20reg`):** Audited `r/nt/grc20reg/v0` and `p/nt/grc20/v0`. **Held:** `grc20reg` stores concrete `*grc20.Token` structs with unexported fields and no transfer hooks, so a hostile token realm cannot run code, re-enter, or lie during `SettleRing`/`Deliverable`. Its `PrivateLedger` still lets it mint/burn/transfer its own token arbitrarily, which only harms traders who chose to want or hold that token (a sub-realm can register a `#`-containing key in `grc20reg`, which does not break `|` storage, `:` routing, or sanitization).
6. **GnoSwap bridge:** Audited `r/kylix/bridge.gno` against real onyx-1 `pool/v1` and `router/v2` sources. **Failed on multi-pool selection & sandwiching:** `bridgeFee` can be permanently jammed or hijacked by a single-sided out-of-range decoy pool (**Finding 3 — High**), and `MsgRun` enables single-tx atomic sandwiching down to `wantMin` (**Finding 5 — Medium**). `SettleAddress()` isolation and zero-leftover/zero-allowance invariants held across all failure paths (cross-realm panics abort atomically and no external caller can mint `cur.Sub("settle")`).
7. **Denial of service and griefing:** Tested `FlagIntent`/`PruneIntent`, expired-offer book bloat, `ExportGraphJSONPage`, `Render`, `Deliverable`, and front-running. **Found:** Sinopia3 poison-CID offers are permanently unprunable and abort 50-offer `Deliverable` batches (**Finding 4 — Medium**), `ExportGraphJSONPage` scans expired offers without bound and `collections` is unpaginated (**Finding 6 — Medium**), stale `FlaggedAt` enables zero-grace pruning on a brief dip (**Finding 9 — Low**), and competing settlers/surplus-capture front-running is inherent to permissionless settlement.
8. **Storage deposit:** Audited Gno v1.8.0 `processStorageDeposit` (`keeper.go:2469-2600`) across `PostIntent`, `CancelIntent`, `SettleRing`, `FlagIntent`, `PruneIntent`. **Found:** A hostile collection's `OwnerFn`/`ApprovedFn`/`MoveFn` can bloat its own storage during `FlagIntent`/`PruneIntent`/`SettleRing`, draining up to `MaxDeposit` (or `DefaultDeposit` when `MaxDeposit == 0`) from the caller and refunding it to the attacker next block (**Finding 2 — High**). Within Kylix itself, `bptree` split/merge refund asymmetry is minor and unavoidable.
9. **Session keys and callers:** Audited `runtime.GetSessionInfo()` (`gnovm/stdlibs/chain/runtime/native.go:62-74`, `keeper.go:1395,1692`) and realm/`MsgRun`/sub-address callers. **Held for session keys:** `SessionAccount` is tx-wide across `MsgCall` and `MsgRun`, so a session key cannot bypass `CancelIntent`'s guard via `MsgRun` or a helper realm. **Minor gap:** `guard()`'s unconditional `OriginSend()` check breaks `MsgRun` bundling of `wugnot.Deposit` + `PostIntent` and payable-realm callers (**Finding 8 — Low**).
10. **Output injection:** Audited every string reaching `Render`, `ExportGraphJSON`, `ExportGraphJSONPage`, and `Deliverable`, plus `p/nt/markdown/sanitize/v0`. **Held:** All user/collection strings in `Render` pass through `sanitize.TableCell` / `sanitize.InlineText`, and `jsonString` properly escapes `"`, `\`, controls `0x00..0x1f`, `<`, `>`, `&`, `U+2028`, `U+2029`, and invalid UTF-8. `validTarget` permits weird paths like `../r/x` or `/r/x` without a domain, but `c.target` is never placed in a link href and is sanitized with `InlineText`.
11. **Tests that prove less than they claim:** Audited all unit tests, filetests, mocks, and `adaptertest`. **Found:** Vacuous `uassert.False(t, locked)` after `aborts()`, wrong token/nonce checked in `TestTwoLegRing`, shared-balance mock pool with zero multi-pool tests, unreachable router-allowance check in `z_bridge_partial_filetest.gno`, untested sub-identity and adapter lock paths, and `a_gnft_test.gno`/`c_sinopia3_test.gno` missing real `position` and invalid-CID coverage (**Finding 11 — Low**).

---

## Top Three Fixes Before Public Testnet

1. **Fix `r/adapters/gnft` against atomic liquidity rug-pulls (Finding 1 — Critical):** Do not deploy `r/adapters/gnft` with bare `TokenID` matching. Require pinned liquidity (and tick bounds) in the item ID (e.g. `<tid>:<tickLower>:<tickUpper>:<minLiquidity>`) and verify them against `gno.land/r/gnoswap/position` in `Approved` and `Move` before calling `gnft.TransferFrom`.
2. **Fix `bridgeFee` pool selection in `r/kylix/bridge.gno` (Finding 3 — High):** Let callers specify the GnoSwap fee tier (e.g., `SettleRingWithFee` or an optional fee parameter on `SettleRing`) and ignore 0-reserve pools in the fallback, so a decoy out-of-range pool cannot jam or hijack bridged settlements.
3. **Fix `r/adapters/sinopia3` CID validation + lock check AND harden storage-deposit handling around untrusted collections (Findings 4 & 2):** Validate `1 <= cid <= core.CollectionCount()` and `State == StateFinal` in `r/adapters/sinopia3` so poison offers cannot break `Deliverable` or persist unprunably; simultaneously bound `ExportGraphJSONPage`'s expired-offer scan (Finding 6) and document/enforce strict non-zero `MaxDeposit` caps + official-collection filtering for automated settlers and pruners so hostile collections cannot drain GNOT via `OwnerFn`/`ApprovedFn`/`MoveFn` storage bloat.
