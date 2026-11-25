# Kylix Off-Chain Solver

Off-chain ring finder, CLI, and `gnomcp` agent skill for Kylix on Gno.land.

It reads open offers from `ExportGraphJSONPage` / `ExportGraphJSON` (from a JSON file or via read-only `vm/qeval`), removes offers touching unofficial collections by default before searching, pre-screens candidate offer deliverability via batched `Deliverable(ids)` queries (failing closed on unknown or failed checks), finds settleable rings of 2 to 6 offers (with at most one GnoSwap-bridged fungible hop), picks a non-overlapping set to settle, and prints the exact `gnokey maketx call` commands for `SettleRing` (direct rings) or `SettleRingVia` (bridged rings) with an explicit per-ring `-max-deposit` cap (and optional simulate-only dry-run commands). It never signs or broadcasts transactions itself.

## Layout

- `ring/` — Pure Go library: lenient graph JSON parser (including `collections`), official-collection offer/ring filter, overflow-safe expiry filter, per-owner/distinct-owner bounded ring finder, zero-RPC structural bridged candidate scanner, disjoint selector, independent verifier, and tests.
- `rpc/` — Read-only ABCI `vm/qeval` client with HTTP 429 exponential backoff, paged graph fetcher, cached multi-tier GnoSwap `DrySwapRoute` quoter, and batched `Deliverable(ids)` checker with safe summary warnings.
- `cmd/kylix-solver/` — Command-line tool (`--graph` or `--rpc`/`--realm`, `--print-simulate`, `--json`).
- `SKILL.md` — Agent runbook for running one solving round safely.
- `.mcp.json` & `profiles.toml.example` — Example `gnomcp` configuration for the `onyx-1` testnet.

## Build & Test

Requires Go 1.22+ (standard library only, no external dependencies):

```bash
cd solver
gofmt -l .
go vet ./...
go test -v -race ./...
go build -o ./kylix-solver ./cmd/kylix-solver
```

## Run

From a local `ExportGraphJSON()` snapshot (offline; bridged quoting and live deliverability checks are off automatically):

```bash
./kylix-solver --graph offers.json --key mykey
./kylix-solver --graph offers.json --print-simulate --key mykey
./kylix-solver --graph offers.json --json
```

From a Gno.land RPC node (read-only `vm/qeval`; bridged quoting and live deliverability checks are on by default):

```bash
./kylix-solver \
  --rpc https://rpc.onyx.testnets.gno.land:443 \
  --realm gno.land/r/nym-kylix000/kylix \
  --chain-id onyx-1 \
  --print-simulate \
  --key mykey
```

### Flags

- `--max-deposit` (default `"auto"`, or a positive integer in `ugnot`; `0` is rejected) — Explicit `-max-deposit <N>ugnot` storage-deposit cap emitted on every printed `gnokey maketx call` command. `"auto"` computes a tight cap per ring from its token hops, item hops, and whether a GnoSwap bridge runs. See [Storage Deposit Cap](#storage-deposit-cap) below.
- `--print-simulate` (default `false`) — Also print a simulate-only dry-run command (`gnokey maketx call ... -broadcast -simulate only`) next to each settle command (and include `simulateCommand` in `--json` output) so the settler can inspect `STORAGE DELTA`, `STORAGE FEE`/`STORAGE REFUND`, and `TOTAL TX COST` before broadcasting.
- `--allow-unofficial` (default `false`) — Include offers touching item collections whose `official` flag is `false` (or whose collection key is missing from `collections`). By default such offers are filtered out before the search and counted; when enabled, a warning is printed next to each unofficial ring.
- `--expiry-margin` (default `10`, in blocks) — Skip offers whose `expiry` is within this many blocks of the current chain height (`expiry - height < expiryMargin`, overflow-safe), since a settlement transaction would likely land too late. Old exports with `expiry: 0` ("never") still load cleanly.
- `--check-deliverable` (default `true` with `--rpc`, `false` automatically with `--graph`) — Pre-screen candidate offers and verify selected rings via Kylix's read-only `Deliverable(ids)` (at most 50 offer IDs per query), failing closed on any undeliverable, failed, or omitted offer. Pass `--check-deliverable=false` to skip in RPC mode.
- `--bridge` (default `true` with `--rpc`, `false` automatically with `--graph`) — Query GnoSwap `ExistsPoolPath` and `DrySwapRoute` for single bridged hops. Pass `--bridge=false` for direct-only rings and fewer RPC calls.
- `--fee-tiers` (default `100,500,3000,10000`) — Comma-separated GnoSwap pool fee tiers to probe.
- `--max-per-owner` (default `4`) — Max offers kept per owner for each wanted asset, preventing one address from filling a neighbor list.
- `--verbose` (default `false`) — Include raw RPC and collection error strings in deliverability warnings and drop reasons. Intended only for human debugging; AI agents must not enable it because third-party collection panic text can contain prompt-injection payloads.
- `--json` — Emit machine-readable JSON with candidate counts, skipped/dropped counts, per-ring `maxDeposit`, chosen GnoSwap fee tier and quoted output, hop details, and `gnokey` commands.

## Safety Defaults

### Storage Deposit Cap (`-max-deposit`)

On Gno.land, the transaction sender pays `100 ugnot` per byte that any realm's storage grows during the transaction, and whoever later frees those bytes receives the refund. Leaving `-max-deposit` unset (or passing `0`) does **not** disable the deposit — the VM silently falls back to the chain's `vm:p:default_deposit` (`100000000ugnot` = 100 GNOT = 1 MB by default).

Even a 100% official-only canonical GRC20 ring can grow storage:
- On Gno v1.8.0 (`gno.land/pkg/sdk/vm/keeper.go`), `processStorageDeposit` charges positive storage growth per realm without netting Kylix's refund against another realm's deposit, and `lockStorageDeposit` deducts every positive deposit from a session key's `SpendLimit` without crediting refunds back.
- A first-time receiver in a canonical GRC20 token realm allocates a new balance AVL node of about **2,058 bytes** (~0.206 GNOT). In testing, a 6-offer canonical token ring with six first-time receivers and surplus approvals grew token storage by **12,348 bytes (~1.235 GNOT)**. Requiring exact approvals in Kylix deletes the allowance node (~1,100 bytes) in the same token realm and removes most of that net growth, but a fresh receiver can still net ~+1,000 bytes in a direct token hop, and a bridged hop's output token realm has no offer allowance to delete (plus GnoSwap pool/router observation writes).
- Settlers should therefore never assume a ring is net-positive without simulating first.

A single flat default cap is awkward in both directions: too low (such as `500000ugnot`) rejects honest 6-leg token rings with several first-time holders, while too high lets a crafted ring cost the settler more than necessary on a small 2-leg or item-only ring.

By default (`--max-deposit auto`), `kylix-solver` therefore computes `-max-deposit` **per ring**:
- **`250000ugnot` (`0.25 GNOT` = 2,500 B) per fungible token hop** — covers a first-time receiver's ~2,058 B GRC20 balance node with ~20% headroom even when no allowance node is freed in that realm.
- **`100000ugnot` (`0.10 GNOT` = 1,000 B) per item hop** — tight headroom for an honest NFT/adapter ownership update.
- **`+250000ugnot` (`0.25 GNOT` = 2,500 B) for a GnoSwap-bridged hop** — headroom for pool observation and emission writes.

| Ring shape | Auto `-max-deposit` | Bytes covered | vs 100 GNOT chain default |
|---|---|---|---|
| 2-leg item-for-item | `200000ugnot` (0.20 GNOT) | 2,000 B | 500x lower |
| 2-leg token-for-item | `350000ugnot` (0.35 GNOT) | 3,500 B | 285x lower |
| 2-leg token-for-token | `500000ugnot` (0.50 GNOT) | 5,000 B | 200x lower |
| 2-leg bridged token-for-item | `600000ugnot` (0.60 GNOT) | 6,000 B | 167x lower |
| 3-leg token ring | `750000ugnot` (0.75 GNOT) | 7,500 B | 133x lower |
| 6-leg token ring | `1500000ugnot` (1.50 GNOT) | 15,000 B | 67x lower |
| 6-leg bridged token ring | `1750000ugnot` (1.75 GNOT) | 17,500 B | 57x lower |

Pass `--max-deposit <N>` (e.g. `--max-deposit 500000`) to set a fixed cap on every ring; `--max-deposit 0` is rejected.

### Simulating Before Settling

Pass `--print-simulate` to emit a dry-run command alongside each settle command:

```bash
gnokey maketx call ... -max-deposit '350000ugnot' ... -broadcast -simulate only <your-key>
```

Confirmed against Gno v1.8.0 (`tm2/pkg/crypto/keys/client/maketx.go`, `broadcast.go`, and `gno.land/pkg/keyscli/call.go`, `root.go`):
- `-broadcast -simulate only` queries `.app/simulate` without broadcasting (and blanks signature bytes for `MsgCall` before sending to the RPC node).
- It enforces `-max-deposit` against each per-realm positive deposit and prints `GAS WANTED`, `GAS USED`, `STORAGE DELTA` (bytes), `STORAGE FEE` or `STORAGE REFUND`, `TOTAL TX COST` (net storage delta + gas fee), `EVENTS` (every per-realm `StorageDepositEvent` and `StorageUnlockEvent`), and `INFO` (estimated gas usage and fee).
- By contrast, `gnomcp`'s `gno_call` with `simulate: true` (`github.com/gnoverse/gno-mcp`, `v0.0.0-20261120141949-b911f1a8781b`) returns only success/error, `GasUsed`, and the return `Result` — it does **not** report storage delta, storage deposit/refund, events, or total tx cost, and has no `max_deposit` parameter.

### Official Collections by Default (Pre-Filtered Before Search)

The first page of `ExportGraphJSONPage` includes a `collections` array with `{"key","name","adapter","target","official","approvalCheck"}`, where `official: true` marks collections and adapters published under Kylix's own namespace. Because unofficial collections run arbitrary third-party code during settlement, `kylix-solver` filters out offers touching unofficial (or unlisted) collections **before** building adjacency or running DFS, preventing dense unofficial clusters from exhausting `--max-rings` or `--max-steps`. Pass `--allow-unofficial` only if you intentionally want to inspect or settle rings with unofficial collections; each such ring is printed with an explicit warning.

### Explicit GnoSwap Pool Selection (`SettleRingVia`)

On-chain automatic pool choice by total pool balance can be jammed or hijacked by a decoy fee-tier pool holding large out-of-range liquidity. For every bridged hop, `kylix-solver` queries `DrySwapRoute` across **every existing fee tier** for the pair (`100`, `500`, `3000`, `10000`), selects the tier with the highest net output, requires that output to meet the receiver's `wantMin`, and prints a `SettleRingVia(ids, fee)` command naming that exact pool tier. Direct rings (no bridged hop) continue to print `SettleRing(ids)`.

### Bridged-Ring Execution Price (Sandwich Note)

Because settlement is permissionless and Gno.land supports atomic multi-call `MsgRun` transactions, any third party with capital can sandwich a bridged ring's GnoSwap swap in a single transaction, pushing the swap price down to the receiver's stated `wantMin`. For a bridged ring, the receiver should expect to get their stated minimum (`wantMin`) and no more (set a tight `wantMin` and a short expiry). The solver settling such a ring is not taking anything from the receiver beyond what the offer explicitly allowed (`got >= wantMin` is enforced on-chain, and 100% of the swap output goes to the receiver).

### Live Deliverability Screening (Fail-Closed, Bounded Queries)

In RPC mode (`--check-deliverable`, on by default), `kylix-solver` screens candidate offers **before** spending GnoSwap quote calls, in up to 10 rounds (capped at 500 offers/round and 1,000 offers = 20 `Deliverable(ids)` queries total at 50 IDs/batch):
1. Each round finds direct rings (0 RPC calls) and structurally bridgeable candidate offers (0 RPC calls, distinct-owner order), batch-queries `Deliverable(ids)` on unchecked offers, and removes undeliverable or unknown offers from the working graph before the next round and before quoting.
2. **Fail closed:** if a `Deliverable` batch fails on both the initial attempt and its single retry, or omits an offer ID, those offers are treated as undeliverable (with reason naming the offer ID that the check failed) and any ring touching them is dropped so the selection loop can try alternative disjoint rings.
3. **Safe summaries by default:** raw panic/error text from collection code is omitted from default warnings and drop reasons (reduced to short summaries naming the offer ID), and is only shown behind `--verbose`.

Pass `--check-deliverable=false` to explicitly skip deliverability checks in RPC mode.

### Hostile Input Hardening

- **`--graph` realm handling:** when `--realm` is passed explicitly, the solver never overrides it from the graph file. When `--realm` is omitted, a file's `realm` field is accepted only if it is a well-formed `gno.land/r/...` path, and a warning is printed whenever it differs from the default (or is ignored as malformed).
- **Overflow-safe expiry check:** expiry filtering checks `height > expiry || expiry - height < expiryMargin`, avoiding `int64` wraparound on huge heights.
- **Terminal sanitization:** text output strips ANSI/VT escape sequences, C0/C1 control bytes, and Unicode bidi/line controls from chain-derived strings and RPC errors (and JSON output escapes control bytes via `encoding/json`).

## Selection Rule (Overlapping Rings)

When candidate rings share an offer, `ring.SelectRings` picks a disjoint subset greedily after sorting candidates by:

1. **Longest ring first** (6 legs down to 2) — settles more offers per transaction and prioritizes multi-party cycles that cannot clear bilaterally.
2. **Direct before bridged** — for equal length, prefers direct rings (lower gas, no GnoSwap fee or slippage).
3. **Oldest offers first** — lexicographic comparison of each ring's offer IDs sorted ascending (fair FIFO tie-break, deterministic).

No optimisation solver is used.

## Search Bounds & Limits

To stay fast on books of several thousand offers (and avoid hitting onyx-1 HTTP 429 rate limits), `ring.FindRings` enforces explicit, configurable bounds:

- **Direct-path decomposition for bridges:** Because a ring may have at most one bridged hop, deleting that hop leaves a pure direct path of 2..6 offers. The finder only traverses direct edges during DFS and evaluates the closing bridge at path ends — never branching over $O(N^2)$ bridged pairs mid-search.
- **`--max-per-owner` (default `4`):** Caps how many offers a single owner can occupy per wanted asset, and orders neighbors and bridged starts in distinct-owner rounds before applying `--max-fanout` or spending quotes.
- **`--max-fanout` (default `64`):** Caps direct out-neighbors per offer (distinct owners first, oldest offers within each round).
- **`--max-steps` (default `500000`):** Caps total DFS visits across the run, split fairly across start offers via **`--max-steps-per-start` (default `2000`)** so dense token clusters cannot starve isolated rings elsewhere in the book.
- **`--max-rings` (default `10000`):** Caps candidate rings collected before selection, with **`--max-rings-per-start` (default `100`)** capping rings per start offer so a few starts cannot exhaust the global limit.
- **`--max-quotes` (default `200` in CLI):** Caps distinct uncached GnoSwap quote calls. `rpc.GnoSwapQuoter` caches pool existence per unordered token pair and quotes (output + winning fee tier) per `(tokenIn, tokenOut, amountIn)`.

When any bound is hit, `stats.truncated` is `true` with `stats.truncatedReason` set.

**Current limits:**
- From the chain, the book is read with `ExportGraphJSONPage(after, 500)`, page by page, up to 200 pages (preserving `collections` from the first page).
- `Deliverable(ids)` checks live on-chain deliverability at query time, but state can still change between the query and transaction inclusion; any newly undeliverable offer reverts cleanly on-chain during settlement.

## What settling costs, and what the solver cannot promise

The storage deposits freed by a settlement go to the settler. In honest rings measured on a local chain that covered the minimum fee, by a margin from about 0.02 GNOT upward. It is an offset, not a guaranteed profit.

- A simulation is a snapshot. A ring's assets can change between the simulation and the real transaction, so the deposit cap is what bounds the loss, not the simulation. A crafted ring can cost the settler up to that cap.
- Dead offers can crowd the search. When a search bound is full (fan-out, per-owner, step, ring or quote limits), the solver checks the offers occupying it with `Deliverable`, drops the dead ones and searches again, for at most `--max-screen-rounds` (default 10) rounds and `--max-screen-queries` (default 20) queries of 50 ids each (shared with the final deliverability check). If a search bound is still full or that query budget runs out before every selected ring is confirmed, the output says the result may be incomplete (`mayBeIncomplete` and `incompleteReason` in JSON). A book with nothing dead and nothing truncated costs no extra queries.
- Gas is sized to the ring: 25M, plus 5M per token offer, 14M per item offer and 50M for a GnoSwap hop, and the fee is the minimum for that limit (limit divided by 1,000, in ugnot). `--gas-wanted` and `--bridge-gas-wanted` override it. The GnoSwap figure has not been measured on a chain.
