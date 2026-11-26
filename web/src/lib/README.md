# The chain and wallet library

Reads the Kylix realm on onyx-1 from a browser and signs with Adena. It has no runtime dependencies: it uses `fetch`, `atob`/`btoa`, `TextEncoder`/`TextDecoder` and `AbortController`. Its tests live in `web/test/` and run from `web/`:

```sh
npm run typecheck
npm test            # unit tests against recorded fixtures
npm run test:live   # reads the real onyx-1 realm and GnoSwap pool; sends nothing
```

| File | What it does |
|---|---|
| `config.ts` | Chain id, RPC and indexer URLs, package paths, token keys, gas limits, deposit caps |
| `parse.ts` | Parses qeval's `(value type)` output and Go-quoted strings; quotes values into expressions; validates addresses |
| `rpc.ts` | JSON-RPC client: `qeval`, `qrender`, `qfuncs`, `status`, bank balances. Cache, de-duplication, at most 4 requests at once, backoff on 429 and network errors. `indexedTx` looks a transaction up in the indexer |
| `kylix.ts` | Typed reads: the book (all pages), one offer, `Deliverable`, `NextSlot`, `ApproveTarget`, collections, the ring picture, balances, relics (`relicsOf` asks `relics.BalanceOf` first and scans owners only when the account holds some), the faucet cooldown, who holds an MNS name and whether the nsnft adapter can move it (`mnsName`), how to approve an asset, ready rings (pass `quote` to include rings with a GnoSwap hop; `Deliverable` is asked about at most `maxChecks` offers, 200 by default, best rings first, and `checksCut` says when that left rings out) |
| `rings.ts` | Rings of 2 to 6 offers, ported from `solver/ring`: direct finder, finder for rings with one GnoSwap hop (`findBridgedRings`), verifier, selector (longest first, direct before bridged). `prepareBook` builds the eligible offers and neighbour lists once for both finders; a book of 6,000 offers takes well under a second |
| `gnoswap.ts` | `GnoSwapQuoter`, ported from `solver/rpc/gnoswap.go`: which fee tiers have a pool for a pair (`ExistsPoolPath`), and the best `DrySwapRoute` output among them. Tokens are named by grc20reg keys. Caps pool lookups by pair and `DrySwapRoute` calls per quoter; a pair with no pool uses no quote. `quoteCacheMs: 0` asks again instead of using the cache, for a quote taken right before signing |
| `tx.ts` | Pure builders: claim, approve and post (one transaction, two messages), settle (`SettleRingVia` for a ring with a GnoSwap hop), cancel, prune, each with gas, fee and deposit cap. Approvals: demo tokens, any token with `Approve(spender, amount)`, demo relics, and MNS names on the MNS ledger to the adapter's address |
| `wallet.ts` | The `Wallet` interface, `AdenaWallet` over `window.adena`, and `MockWallet`. `AdenaWallet` registers its change listeners the first time it sees `window.adena`, so a late injection still reaches early subscribers. `parseSendResult` treats a `check_tx` or `deliver_tx` error as a failure, and a result with no block height as sent but unconfirmed, which the app then confirms through the indexer |

## Notes

- DrySwapRoute answers an error as a pointer to a struct, which `parseQeval` cannot read. `parseDrySwap` reads the three lines one by one, as the solver does.
- The MNS ledger (`gno.land/r/nym-mnsrehearsal001/nsnft/v2`) has no way to list a holder's names, so the app asks the user to type the name and checks the holder and lease with `mnsName` before signing.

## Adena, as read in its source

Read: `onbloc/adena-wallet` at commit b4164c5 (extension 1.22.5, 24 Nov 2026), `@adena-wallet/sdk` 0.1.3, and docs.adena.app. The docs are older than the code; where they differ, this follows the code.

- `DoContract({ messages, gasFee, gasWanted, memo })` signs and broadcasts every message in one transaction. Each `/vm.m_call` keeps its own `send` and `max_deposit` through to the signed bytes (`adena-module/src/utils/messages.ts`). The wallet requires the keys `caller`, `send`, `pkg_path`, `func` and `args` on each message, and fills an empty `caller` with the account.
- Adena simulates the transaction and sets the gas limit and the fee itself: gas used times 1.1 at its default "average" setting, times the chain's gas price. The `gasWanted` and `gasFee` we pass only seed the first simulation.
- By default it broadcasts with `broadcast_tx_sync` and answers with a hash only. A request field `commit: true`, read by the approve page but missing from the SDK's types, makes it wait for the block. `AdenaWallet` sends it by default; `new AdenaWallet({ commit: false })` turns it off, and `indexedTx(hash)` then confirms the transaction. The RPC runs with `tx_index` off, so it cannot look up a hash.
- Failures come back as `{ status: 'failure', type, code, message, data }`. A user refusal is `TRANSACTION_REJECTED` (code 4000). A chain refusal is `TRANSACTION_FAILED` (4001) with `data.error` holding the panic text.
- onyx-1 is one of 1.22.5's default networks. `SwitchNetwork` answers `UNADDED_NETWORK` on a wallet that lacks it, and `AddNetwork` fixes that.
- `On('changedAccount' | 'changedNetwork')` cannot be unsubscribed, and Adena stops the event after the first listener. Use one `AdenaWallet` per page.

Not confirmed without a real wallet: that a two-message approve-and-post goes through Adena's approval screen and lands; that `commit: true` behaves as the source reads; the exact data a committed result carries; and how older Adena versions handle any of it.
