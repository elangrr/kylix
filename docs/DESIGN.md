# Kylix: design spec

Kylix lets people swap tokens and collectibles in a circle. Each person posts "I give X, I want at least Y". When two to six offers form a closed ring, all of them settle in one transaction or nothing moves. Kylix never holds anyone's assets between swaps.

The name is the Greek wine cup that was passed round the circle at a drinking party. The project was called Rondo during design.

Built for the Gnome Tavern Hackathon on Gno.land. Submissions close 2026-12-18 01:00 UTC. Judged by the Gno.land core team: technical quality 40%, user appeal 20%, creativity 20%, docs and demo 20%.

## Decisions already made

Do not reopen these without a concrete reason found in code or tests.

1. **No custody.** Tokens and collectibles stay in the owner's wallet until the ring settles. The owner approves a per-offer sub-address of the Kylix realm, and only that sub-address can pull that one offer's asset.
2. **No native GNOT offers in v1.** A native-coin offer would have to sit in a Kylix-controlled address. GNOT traders use wugnot. This also removes tips paid in ugnot.
3. **No pricing maths.** A leg gives its whole offered amount. The receiver gets all of it. The only check is integer `got >= wantMin`. No partial fills.
4. **Rings of 2 to 6 legs.** Anyone may submit a ring; the realm verifies it. Searching for rings happens off chain (a solver) or on the page for short rings.
5. **Collections plug in by registering a move function.** Kylix calls it while crossing as the offer's sub-address and never passes its own `cur`.
6. **GnoSwap bridges one missing fungible hop** (give token A, receiver wants token B). At most one per ring, because a swap costs about 33 million gas. `SettleRing` picks the pool itself, which is convenient but can be jammed by a decoy pool when a pair has several; `SettleRingVia` lets the settler name the pool, and the solver does that from a quote. Rings with no such hop never touch GnoSwap. The receiver's minimum is their only price protection on a swap hop, so the page tells them to treat the minimum as the price.
7. **Session keys may post and settle but never cancel.** `CancelIntent` calls no foreign code, so it can never be blocked.
8. **Existing collections join through adapter realms.** The owner approves an address derived from the adapter and their offer's slot, so per-offer isolation holds. See `docs/research/collections.md`.
9. **No admin key anywhere.** An adapter is "official" when its package path is under the same namespace as the Kylix realm; anything else is listed as unofficial. This is a label, not a gate.
10. **The storage deposit offsets the settler's fee.** Settling deletes the ring's offers and consumed approvals, and the chain refunds their deposits to whoever sent the settle transaction. In honest rings measured on a local chain that covered the minimum fee by 0.06 to 1.3 GNOT. It is not a guaranteed profit: first-time receivers' entries are charged to the settler, and a crafted ring can cost up to the settler's deposit cap. Hence three rules: an approval Kylix uses must be consumed by the move (exact token amounts, single-item approvals), commands carry a deposit cap, and settlers simulate first. There is no separate tip.
11. **Every offer expires, and a token or official-collection offer must be deliverable when posted.** The default life is 7 days and the maximum 30. For those assets `PostIntent` runs the same check as settlement, so an account that does not hold and has not approved the asset cannot post. An offer of a third-party item is stored unchecked; such items are kept off the home page and out of the solver's default search. There is no flagging: only an expired offer can be pruned, by anyone.
12. **Posting, cancelling and pruning never run third-party collection code; settling does, at the settler's cost.** Posting checks deliverability for tokens and for items of official collections only. Nobody can be made to pay for, or be blocked by, a collection they did not choose to settle.
13. **Kylix trades only items whose value the id fixes.** An item whose contents the owner can change while it is listed (a GnoSwap liquidity position, for example) is not supported, because the owner could empty it in the same transaction that settles the ring. The official adapters are Sinopia3 artworks (final, non-living engines only) and MNS names.

## Packages

Namespace `nym-kylix000` is a placeholder until a namespace is claimed on the testnet. Keep it in one place per module (`gnomod.toml` plus imports) so it can be replaced by search.

| Directory | Module path | Purpose |
|---|---|---|
| `p/ring` | `gno.land/p/nym-kylix000/ring/v0` | Pure ring verifier and SVG graph. No realm state, no `crypto/*` imports. |
| `r/kylix` | `gno.land/r/nym-kylix000/kylix` | The offer book and settlement realm. |
| `r/kylixdemo` | `gno.land/r/nym-kylix000/kylixdemo` | Demo collection (GRC721 "Relics") and two demo GRC20 tokens with a faucet, so a newcomer can trade in two minutes. |
| `r/adapters/{sinopia3,nsnft}` | `gno.land/r/nym-kylix000/adapters/...` | Official adapters that let existing testnet collections trade: Sinopia3 artworks and MNS name NFTs. Only items whose value an id fixes are supported; GnoSwap position NFTs are not (their liquidity can be withdrawn while the id stays the same). Sinopia3: only Final collections whose engine is not living and is reviewed (by the Sinopia3 admin, or by Kylix: the Genesis engine). MNS: real token ids (`label*domain`), and only names whose lease, read from the MNS registry `nsdata/v2`, is valid and has at least 31 days left (exactly 31 passes). Both adapters use only an approval of the one item, which the transfer clears; an approval for all items is refused. |
| `r/adapters/adaptertest` | | Integration tests that run the adapters against the real collection source, fetched from the testnet by `make deps`. Sinopia3 tokens are bought through the platform's real minter (`mint/v1`). MNS names cannot be registered under `gno test` (the registry has no admin there, so no logic realm is trusted); the tests cover refusals, and the trade of a name registered and paid for through `nslogic` is rehearsed on a local chain (`scripts/README.md`). |
| `r/mocks/*` | `gno.land/r/nym-kylix000/mocks/...`, and `gno.land/r/gnoswap/{router,pool}` for the GnoSwap stand-ins | Test-only stand-ins (GnoSwap router and pool, hostile collection, legacy collection and adapter, a living and an unreviewed Sinopia3 engine). Never deployed. |
| `solver/` | Go module `kylix/solver` | Off-chain ring finder, command-line tool that prints settle commands, and the gnomcp agent skill. |
| `tools/` | | Generator for the filetests in `r/kylix/filetests` (`make filetests`). |

A `gnowork.toml` at the repo root lists the modules.

## Model

```go
// p/ring (pure: no state, no realm imports, no crypto)
type Kind uint8 // Fungible = 1, Item = 2; wire names "fungible", "item"
type Asset struct {
    Kind   Kind
    Key    string // Fungible: grc20reg key. Item: collection key (see RegisterItem).
    ID     string // Item only: the item's id.
    Amount int64  // Fungible only, > 0. In Give: exact amount. In Want: minimum.
}
type Leg struct {
    Offer uint64 // offer id, so an offer used twice is caught
    Owner address
    Give  Asset
    Want  Asset
}
type Hop struct {
    From, To int   // legs[From].Owner sends Asset to legs[To].Owner
    Asset    Asset // = legs[From].Give
    Want     Asset // = legs[To].Want
    Bridged  bool  // Asset and Want are different tokens; settler checks got >= Want.Amount after the swap
}
// All three check: 2..6 legs; no offer, owner or given item twice; every
// asset well formed and no leg giving what it wants; every direct hop gives
// what the next leg wants, with amount >= minimum. Errors are *ring.Error
// carrying the leg index and offer id.
func Verify(legs []Leg) ([]Hop, error)                          // every hop direct
func VerifyBridged(legs []Leg, bridgedHop int) ([]Hop, error)   // hop i is bridged
func VerifyWithBridge(legs []Leg) ([]Hop, error)                // detects the bridged hop: one that gives
                                                                // a token where a different token is wanted;
                                                                // at most MaxBridgedHops (1) per ring
func ParseOfferIDs(s string) ([]uint64, error)                  // "3,7,12", at most 6 ids
```

An offer in the realm (`kylix.Offer`) adds: id, owner, per-owner nonce, expiry height (the last height at which it may settle) and whether it was posted through a session key.

Every offer expires. `PostIntent` with expiry 0 gives `DefaultExpiryBlocks` (7 days) from now, and the latest allowed is `MaxExpiryBlocks` (30 days) from now, both counted with `BlocksPerDay` = 17,280 (5-second blocks). After its expiry anyone may prune an offer, so no offer stays in the book longer than about 30 days.

An item id must fix the item's value. Between posting and settlement the owner keeps the item, so anything of value that can change while the id stays the same (withdrawable contents, unrevealed art, transfer-history-dependent art, a lease the owner can shorten) lets a buyer pay for one thing and receive another. A collection whose items can change this way must put what decides the value into the id, or answer "not approved" from its approval check while the value can change.

Only open offers are stored. Settling, cancelling or pruning an offer deletes it, which releases its storage deposit to whoever sent that transaction, and the event emitted records which of the three happened. So there is no stored status: "settled" and "cancelled" exist as events, and a lookup of a closed offer answers "not open".

Storage: each open offer is one `|`-separated string (owner, nonce, give kind/key/id/amount, want kind/key/id/minimum, expiry, session flag) in a `p/nt/bptree` B+ tree keyed by a short, numerically sorted id key. The same data as a struct with nested `ring.Asset` values in an `avl.Tree` cost about 4.3 KB per offer; the string costs about 580 bytes (about 1 KB for an owner's first offer, which also stores their nonce). At 100 ugnot per byte that is 0.06 to 0.10 GNOT per offer. The owner also pays for the approval in the token or collection realm, about 1.1 KB (0.11 GNOT).

Storage refunds go to the sender of the transaction that frees the bytes (onyx lists no restricted denoms, so refunds are not diverted to the fee collector):

| Path | Who receives | What is freed |
|---|---|---|
| `SettleRing` | the settler | every offer in the ring, plus each approval the ring consumes: a GRC20 allowance is used to exactly 0 and deleted (Kylix requires the allowance to equal the offered amount), a GRC721 token approval is cleared by the transfer |
| `CancelIntent` | the owner | the offer only; the approval stays until the owner revokes it |
| `PruneIntent` | the pruner | the offer only |

Measured with other offers left in the book, a 3-leg ring (two tokens, one relic) freed 1,579 bytes in Kylix and 7,371 bytes in the token and collection realm: about 0.9 GNOT, or 0.3 GNOT per leg. The refund is per realm and net: if the same settlement creates a balance entry for a first-time holder in a token realm, that is charged against the token realm's refund. Refunds are proportional to each realm's deposit-to-storage ratio, so they track the price at which the bytes were bought.

Settling also runs collection code (see Threats), and any storage that code adds in its own realm is charged to the settler, against the refund above.

Exact allowances (security review 2, N3). A token offer is deliverable only if its slot's allowance equals the offered amount: `Deliverable`, `SettleRing`'s preflight and the pages say "approve exactly N" otherwise. A larger allowance is not used up, so the token realm keeps its entry and its deposit, while each receiver who never held the token gets a new balance entry (about 2 KB) charged to the settler. With surplus allowances on all six legs of a 6-offer ring of six first-time receivers, a settler paid for +12,348 B in the token realm against -3,180 B in Kylix (the review's adversarial case: the attacker then empties the new balances and collects their deposits). With exact allowances the deleted allowance entries offset most of the new balance entries.

Measured on a local gnodev chain built from the same gno commit as the testnet (v1.8.0), with real gnokey transactions from separate accounts. The fee is paid in full whatever gas is used, and must be at least gas-wanted times the block gas price (1 ugnot per 1,000 gas at the base price), so the cheapest fee is about gas used / 1,000 ugnot. Deposits are 100 ugnot per byte.

| Transaction | Gas used | Storage | Deposit (+) or refund (-) |
|---|---|---|---|
| Approve a token (first time / again) | 5.6M to 7.6M | +1,076 to +2,133 B | +0.11 to +0.21 GNOT |
| Approve a relic | 6.3M to 6.7M | +1,070 to +1,084 B | +0.11 GNOT |
| Post, first offer in an empty book | 15M | +10,014 B | +1.0 GNOT, once per deployment |
| Post a token offer (checks balance and exact approval) | 18.6M to 21M | +529 to +954 B | +0.05 to +0.10 GNOT |
| Post an item offer (runs the collection's owner and approval checks) | 20M to 22M | +542 to +986 B | +0.05 to +0.10 GNOT |
| Approve and post in one transaction (MsgRun / two messages) | 38.3M / 20.1M | +2,650 / +2,668 B | +0.27 GNOT |
| Cancel | 10.2M | -517 to -535 B | -0.052 GNOT to the owner |
| Prune | 10.35M | -526 B | -0.053 GNOT to the pruner |

Gas limits (one formula, used by the ring page and meant for the solver too). A settle command's gas limit is 25M, plus 5M per token offer, 25M per MNS name (the adapter reads the registry; a token and an MNS name used 44M on the onyx-1 testnet, against 37M locally), 8M per other item, plus 150M for a GnoSwap hop; the fee printed is the minimum for that limit, limit / 1,000 ugnot. Measured: 2 token offers 24 to 29M; a token and a relic 30M; a token and an MNS name 37M; 3 offers 35M; 6 token offers 39M; 3 relics and 3 tokens 59M; 6 items 52 to 60M (6 Sinopia3 tokens 53M in a filetest); on the onyx-1 testnet a 2-offer ring with a real GnoSwap swap 146M, so the swap alone is about 118M (a test run of GnoSwap's source, `docs/research/gnoswap-bridge.md`, had suggested 34M; chain storage reads cost far more). A limit that is too low fails in simulation and costs nothing.

Settling, with the settler's net after the fee the ring page prints:

| Settle | Gas used | Storage | Refund | Limit | Net |
|---|---|---|---|---|---|
| 2 token offers, receivers already hold the tokens | 23.8M | -3,206 B | 320,600 | 35M | +285,600 |
| 2 token offers, both receivers first-time holders (worst honest) | 29.0M | -1,206 B | 120,600 | 35M | +85,600 |
| a token and a relic | 30.1M | -6,277 B | 627,700 | 38M | +589,700 |
| a token and an MNS name (demo, fresh buyer) | 36.6M | -4,286 B | 428,600 | 44M | +384,600 |
| 3 offers: two tokens, one relic | 34.9M | -7,815 B | 781,500 | 43M | +738,500 |
| 6 token offers, six first-time receivers (worst honest): Kylix -3,186 B, token realm +1,607 B | 39.2M | -1,579 B | 157,900 | 55M | +102,900 |
| 6 item offers in two collections, single-item approvals, six first-time receivers, every giver keeps another item (the review's ring R3-1 with the approvals Kylix now requires): Kylix -3,216 B, collections +952 and +960 B | 60.2M | -1,304 B | 130,400 | 73M | +57,400 |
| the same, every giver's last item | 52.3M | -13,490 B | 1,349,000 | 73M | +1,276,000 |
| 3 relics and 3 token offers, first-time receivers (the review's mixed ring with single approvals): Kylix -3,180 B, demo realm +732 B | 59.3M | -2,448 B | 244,800 | 64M | +180,800 |
| 3 offers with one GnoSwap hop (stand-in router) | 48.1M | -4,849 B | 484,900 | 93M | +391,900 |
| a ring with surplus allowances, or an item approved only for all | refused | 0 | | | the preflight names the offer |

Amounts are ugnot. The item rings used the demo relics and the test-only legacy collection on a local chain: Sinopia3's admin key is hard-coded, so a local chain cannot make a Sinopia3 collection; the same two Sinopia3 rings with single-item approvals are filetests (`r/adapters/adaptertest/filetests/z_review3_sinopia_single` and `_mixed_single`): Sinopia3 +1,968 B against Kylix -3,228 B, and Sinopia3 +981 B, demo -246 B against Kylix -3,198 B, both a net refund.

So posting costs a user about 0.18 GNOT (approval and offer, almost all of it deposit, plus about 0.03 GNOT of fees at the base price); the deposit is not returned to them unless they cancel and revoke. Settling pays in every honest case measured, at the fee the page prints: from +0.06 GNOT (six items whose receivers are all new holders and whose givers keep another item) to +1.3 GNOT. It does not at gnokey's usual `-gas-fee 1000000ugnot`, and a bridged ring adds GnoSwap's own storage.

Adversarial case, with exact allowances. Someone who posts a ring of six first-time receivers to bleed settlers pays for six allowances and six offers (about 1.6 GNOT of deposit), which the settlement refunds to the settler net of the six new balance entries; emptying those balances afterwards returns about 0.2 GNOT each (measured: -2,037 B), about 1.2 GNOT in all. The attacker ends about 0.4 GNOT down and the settler about 0.12 GNOT up, so there is nothing to extract. The same holds for items now that only single-item approvals are used (security review 3, R3-1): an approval for all items stayed behind after the move, so its deposit never came back to the settler, and the review measured a settler loss of 0.38 to 0.91 GNOT per ring with it. What remains for a settler: third-party collection code (see Threats), and GnoSwap's storage on a bridged hop; a tight `-max-deposit` bounds both.

Approvals Kylix uses must be consumed by the move (security review 3, R3-1). A GRC20 allowance of exactly the offered amount is deleted by the transfer; a single-item approval is cleared by it. An approval for all items is not, so the official adapters and the demo collection refuse it in both their approval check and their move, and the About page asks every collection author to do the same.

The posting rule (wave 6, narrowed after security review 4, R4-1). `PostIntent` refuses a token offer, or an offer of an item of an official collection, that could not settle now: for a token, the owner holds the amount and has approved the offer's address for exactly that amount; for an official item, the collection's owner function says the owner holds it and, if it registered an approval check, that check passes for `ApproveTarget`'s address. So approve first, then post (two messages in one transaction, or a MsgRun, work). Official collections are Kylix's own code; Kylix holds its lock while they run, so they cannot post, cancel or settle, nor read the book. An item of a third-party collection is not checked: posting runs no third-party code, so no collection can bill a poster for storage. Such offers are kept off the home page and out of the solver's default search, so an undeliverable one crowds nothing that matters, and they are checked when someone settles them. Posting does not stop an offer going dead later (the owner moves the asset or revokes the approval), which the ring search and the settlement preflight check again.

Where third-party collection code runs. Posting, cancelling, pruning, and every page except a third-party item's own offer and ring pages never run third-party collection code; only settling does, and only the settler pays for it.


Collections: a registered collection is native (`RegisterItem`, the owner approves the offer's slot) or an adapter (`RegisterAdapter`, the owner approves the adapter's sub-address `k/<slot address>` in the target collection). Either may register an `ApprovedFn`. A collection whose key sits under Kylix's own namespace (`gno.land/r/<namespace>/` of Kylix's path) is labelled official; any other is third-party. The labels, the same words on every page, in ring captions and in the export (`label`), are "official collection", "official adapter", "third-party collection" and "third-party adapter". The label is information only.

Look-alikes (security review 2, N2). Anyone can register a token with any symbol (grc20reg keys it `<realm path>.<symbol>`) and a collection with any display name. So a token is never shown by its symbol alone where someone decides: the post page's prepared offer, the offer page and the ring page print the full token or collection key in code next to the short name; tables, ring cards and ring pictures add a realm hint, the realm path without `gno.land/r/` (`100 FOO (evil/faketok)`), whose first element is the namespace, which only its owner can deploy under, so a look-alike cannot share the hint's beginning. The prepared offer also prints the account it was computed for above the approve step, so a link prepared for someone else is visible.

Item ids may contain `*`, which MNS v2 token ids use (`label*domain`); every page escapes it like other Markdown punctuation, links carry it query-escaped, and the export as a JSON string.

## Realm API (`r/kylix`)

Signatures may be refined during the build, but the behaviour is fixed.

Every state-changing entry point first refuses to run while a settlement is moving assets (the re-entrancy lock), and refuses native coins when the direct caller is a user's MsgCall (`cur.Previous().IsUserCall()` and `unsafe.OriginSend()`, read only to refuse). Coins attached to a MsgRun, or sent to a realm that then calls Kylix, went to that caller, not to Kylix, so they are not refused. Every exported read except `Render` refuses to run during a settlement, so a collection's callback cannot observe the book after the ring's offers are deleted but before every asset has moved.

Offers:

- `NextSlot(owner address) (nonce uint64, slot address)`: read-only. The sub-address of the owner's next offer. Path `w/<owner>/<nonce>`, derived with `cur.Sub` / `chain.DerivePkgSubAddr`. Deterministic, and only the owner can advance their own nonce, so a wallet can bundle approve and post in one transaction. `SlotAddress(owner, nonce)` gives the slot of an existing offer.
- `ApproveTarget(owner address, nonce uint64, key string) address`: read-only, no foreign calls. The exact address to approve for an offer giving an asset under `key`: the slot for a token or a native collection, `DerivePkgSubAddr(adapterPath, "k/"+slot)` for an adapter.
- `PostIntent(cur realm, giveKind, giveKey, giveID string, giveAmount int64, wantKind, wantKey, wantID string, wantMin int64, expiry int64) uint64`: records the offer for `cur.Previous().Address()`. Kinds are `"fungible"` (key in grc20reg, empty id, amount > 0) and `"item"` (registered collection, id of 1 to 64 characters from `A-Z a-z 0-9 . _ : / - *`, amount 0). An offer cannot give what it wants. Expiry: 0 for the default (now + `DefaultExpiryBlocks`), otherwise a future height no later than now + `MaxExpiryBlocks`; the `IntentPosted` event carries the expiry given. It pulls nothing, but refuses a token offer, or an offer of an official collection's item, that could not settle now ("approve first, then post"; see the posting rule in Model): the same check as the settlement preflight, run under the lock. An item of a third-party collection is stored unchecked, and no third-party code runs.
- `CancelIntent(cur realm, id uint64)`: owner only, not through a session key, no foreign calls.
- `SettleRing(cur realm, ids string)`: `ids` is a comma-separated list in ring order. Anyone may call. A hop that gives one token where the receiver wants a different token is bridged by a GnoSwap swap; at most one per ring, detected automatically, through the pool `bridgeFee` picks (below). In order: (1) read every offer, refuse closed or expired ones, verify the ring with `ring.VerifyWithBridge`, check that every owner can deliver now (token balance, and a slot allowance equal to the offered amount; item ownership via `OwnerFn`, and approval via `ApprovedFn` where registered), and for a bridged hop that a pool exists, writing nothing to Kylix, with any error naming the leg and offer; (2) take the lock and delete every offer from the book; (3) move each leg's asset from its owner straight to the next owner, acting as that offer's slot.
- `SettleRingVia(cur realm, ids string, fee uint32)`: `SettleRing` through the GnoSwap pool with this fee tier (100, 500, 3000 or 10000). The pool must exist and the ring must have a bridged hop. Solvers choose the pool off chain (for instance with the router's `DrySwapRoute`) and use this.
- `PruneIntent(cur realm, id uint64)`: anyone, on an expired offer only. Reads only Kylix's storage and calls no collection or token code. The released deposit goes to the caller.
- `Deliverable(ids string) string`: read-only. For up to `MaxDeliverableBatch` (50) comma-separated ids, JSON saying whether each owner can deliver now and why not (the same check as the preflight; "not open", "expired"). It calls collection code for item offers, so a collection that panics aborts the batch. It does not check pools for bridged hops.

Bridged hop (`bridge.gno`): the fee tier is the settler's (`SettleRingVia`) or, for `SettleRing`, `bridgeFee`'s: among GnoSwap's tiers, the pool with the largest balance of the output token, ignoring pools with none (`pool.GetPoolPath`, `ExistsPoolPath`, `GetBalances`, all reads; no `DrySwapRoute` quote, which costs about 20M gas). That balance counts liquidity at every price, so for a pair with several pools anyone can steer this choice to a pool that cannot pay the receiver's minimum, which only makes the ring abort; `SettleRing`'s choice is a convenience for pairs with one pool. Then: pull the input with `grc20reg.TransferFrom(0, slot, A, owner, settleSub, amount)` into `cur.Sub("settle")`; approve the router proxy `gno.land/r/gnoswap/router`; `router.ExactInSingleSwapRoute(cross(settleSub), A, B, amount, "A:B:fee", wantMin, "0", now, "")`; require the whole input used, no allowance left, and output >= wantMin (the router enforces the minimum too); forward all of the output to the receiver. `SettleAddress()` is the settle sub-address, empty between transactions.

Collections:

- `RegisterItem(cur realm, name string, move MoveFn, ownerOf OwnerFn)`: called by a collection realm. The collection key is the calling realm's package path, so nobody can register under another realm's name. Users, MsgRun packages and sub-identities cannot register; a realm registers once and cannot change its functions afterwards. Names are 1 to 64 bytes of printable UTF-8 (no control, zero-width or bidi characters).
- `RegisterAdapter(cur realm, target, name string, move MoveFn, ownerOf OwnerFn)`: as `RegisterItem`, for an adapter realm driving an existing collection at `target` (a realm path, recorded for display). The adapter's `MoveFn` must cross into the target as `cur.Sub("k/"+cur.Previous().Address())`.
- `RegisterApprovalCheck(cur realm, approved ApprovedFn)`: once, by a registered collection or adapter.
- `GetCollection(key) (Collection, bool)` (key, name, adapter, target, official, label, approval check), `IsCollection(key) bool`, `CollectionName(key) string`, `IsOfficial(key) bool`: read-only.

Reads and pages:

- `GetOffer(id) (Offer, bool)`, `OpenOffers() int`: read-only. They return copies, never pointers into state.
- `Render(path string) string`: `""` (home: pitch, 3-step guide, bounded on-chain search for 2- and 3-offer direct rings whose token offers are funded and approved, with thumbnail SVG graphs, newest 50 open offers, the first 10 collections (official first) with a link to the rest, demo faucet link), `offers/<id>` (50 offers before `<id>`), `offer/<id>` (one offer with readiness check, the address to approve (`ApproveTarget`), closing rings, cancel and, once expired, remove actions), `ring/<ids>` (large SVG ring graph, swaps in words, readiness check, settle action and a ready `gnokey` command with a deposit limit, a gas limit sized to the ring and the minimum fee for it, since gnoweb's own command sets no deposit limit; for a ring with a GnoSwap swap, `SettleRingVia` with the pool named), `post` (approve-address calculator, GnoConnect `$help` transaction buttons, and `<gno-form exec="PostIntent">` fallback), `collections` (registered collections with their labels, official first, 50 per page: `collections?after=<key>`), and `about` (settlement flow, custody guarantees, GnoSwap fees and pool choice, what settling costs, collection plug-in guide and the item-value rule). Every item shown carries its collection's label, and every asset a realm hint or, where someone decides, its full key (see Model, look-alikes). Home never calls third-party collection code (it reads token ledgers and official collections for readiness, and may call `gno.land/r/sys/users`); every untrusted string is sanitized for its output slot. Offer records are decoded in one pass over a `[]byte`.

  The ring search (home and offer pages; security review 3, R3-2). Every offer was deliverable when posted but can go dead later, so the search checks again: a token offer must be funded and approved now; an item offer of an official collection with an approval check must be owned and approved now (our code, written not to panic); an item of any other collection is never checked there, since that would run third-party code: the home page leaves it out, and an offer page keeps it as unverified, after every verified offer. The window counts at most 100 newest offers, at most 8 per owner (kept or skipped as dead or expired; an owner's further offers are passed over uncounted, up to 400 offers read), and keeps at most 50, at most 4 per owner. Each wanted-asset bucket keeps at most 12 offers, at most 2 per owner, verified first, then lowest minimum. The third offer of a 3-offer ring is looked for only among offers that give what the first one wants, and an offer whose minimum nobody in the window meets costs no search steps. An offer may appear in at most 2 candidate rings, 12 candidates at most. Only rings that close count as search steps, 500 at most (security review 4, R4-3); every pair and triple tried is otherwise bounded by the window and bucket sizes (at most 7,800 checks, capped at 8,000). Measured worst cases (filetests `z_review3_render_gas`, `z_review3_offer_gas`, minus `z_review3_gas_base`: 392 offers read, 100 counted, 92 accounts with usernames, 300 offers from one account, 50 dead offers, six 3-offer rings with verified relics): `Render("")` about 801M gas and `Render("offer/<id>")` about 423M gas; with 92 real Sinopia3 offers checked through the official adapter (`r/adapters/adaptertest/filetests/z_review4_sinopia_*`), about 1.13B and 658M; the query limit is 3B. Settle buttons on the home and offer pages lead to the ring page, which shows every asset's full key.
- `ExportGraphJSON() string` and `ExportGraphJSONPage(after uint64, limit int) string`: open, unexpired offers in id order, each with its slot and `approve` address, and the paging fields `hasMore`, `next` (the `after` for the next page) and `total` (open offers in the book, expired ones included). Collections, official first, with their labels (`official`, `label`) are included in `ExportGraphJSON` and in the first page (`after == 0`) only: at most `MaxExportCollections` (100), with `collectionsHasMore` and `collectionsNext`. A page holds at most 500 offers (default 100) and looks at no more than 500 offers, expired ones included, so a long run of expired offers costs a bounded amount per page (the page may then be short with `hasMore` set). Amounts are decimal strings.
- `ExportCollectionsJSON(after string, limit int) string`: the rest of the collections, official first, up to 100 per call, from the key after `after`: `{"collections":[...],"collectionsHasMore":bool,"collectionsNext":"<key>"}`.
- `EnableNotifications(cur realm)`: opens Kylix's `gnotif` handle via `cur.Sub(gnotif.Subpath)` and registers the `offer_settled` trigger watching `OfferSettled` (`Param: "owner"`). Only the namespace owner signing directly with their account key can call it (enforced by `gnotif` + `r/sys/names`); Kylix keeps no admin. On gnodev `r/sys/names` is disabled, so there the first caller wins; the refusal of other callers can only be seen on the testnet. The local-chain rehearsal shows the two refusals that do not depend on names: a session key of the account ("signed with a session key"), and a run script signed by the account ("the dapp was not entered directly by its namespace owner").

```go
type ItemID string
type MoveFn     func(cur realm, from, to address, itemID string) error
type OwnerFn    func(itemID ItemID) address
type ApprovedFn func(itemID ItemID, spender address) bool
```

`MoveFn` is a crossing function, so only a realm can declare one. `OwnerFn` and `ApprovedFn` are called without crossing, so they have no realm value to call back into Kylix's entry points, but they still run with their own realm's storage authority and may write there (borrow rule #1). Their parameter is the realm-declared `ItemID`, not `string`, so that no `/p/` function can be registered as one: a top-level `/p/` function called from Kylix would run with Kylix's storage authority (`gno-security-guide.md` section 3C). They must not panic on an unknown id.

Settlement of an item leg: `move(cross(slot), from, to, id)` where `slot = cur.Sub("w/<owner>/<nonce>")`, then check `ownerOf(id) == to` and abort the whole transaction if it is not. A collection that lies about a move can only hurt people who chose to want its items. A collection's error is reported with the leg; a collection that panics aborts with its own message, since no realm can recover a panic that crosses a realm boundary.

Fungible legs use `gno.land/r/nt/grc20reg/v0` with the offer's sub-address as spender: `grc20reg.TransferFrom(0, slot, key, owner, nextOwner, amount)`.

Events through `chain.Emit`: `IntentPosted`, `IntentCancelled`, `RingSettled`, `OfferSettled` (one per owner in a settled ring, carrying `owner`, `id`, `ring`, `gave`, `received`), `IntentPruned`, `CollectionRegistered`, `ApprovalCheckRegistered`. The notification service (`gno.land/r/nym-gfanton001/gnotif/v1`) watches `OfferSettled` via `EnableNotifications`.

## Threats the tests must cover

- A slot approved for one offer cannot move any other offer's asset or any other owner's asset.
- A hostile collection that re-enters any state-changing entry point during a move, or reads the book (`GetOffer`, `OpenOffers`, `Deliverable`, exports) while the ring is half settled.
- A hostile collection that returns nil without moving the item, returns an error, or panics.
- A hostile collection that tries to spend an allowance as the slot identity it was called with.
- A hostile collection that stores data in its own realm from `OwnerFn`, `ApprovedFn` or `MoveFn`. Gno has no read-only cross-realm call, so this cannot be prevented: whoever sends the transaction pays the storage deposit and the collection can later free it and collect the refund. Kylix limits where this can happen: `PostIntent`, `CancelIntent`, `PruneIntent` and every page except a third-party item's own offer and ring pages never call third-party collection code, so posting, cancelling and pruning are always safe (security review 4, R4-1: `z_review4_post_thirdparty`, `TestReview4_PostIntentCallbacks`). `SettleRing`, `SettleRingVia`, `Deliverable` and those two pages call it; a settler chooses which rings to settle, should set a tight `-max-deposit` (0 falls back to the network's default deposit, not to nothing), and should be careful with third-party collections. Tests show pruning a hostile collection's offer stores nothing and settling it does.
- An item whose value the owner can change while its id stays the same (finding 1 of security review 1, GnoSwap positions): not supported; adapters for such collections are not shipped, and adapters must refuse states in which the value can still change.
- An offer used twice in one ring, the same owner twice, a ring of one, a ring of seven.
- Settling an offer that is cancelled, already settled or expired; pruning an offer that has not expired.
- An owner who revokes the approval or spends the asset after posting: the ring aborts cleanly, naming the leg, and the other offers stay open.
- An allowance larger than the offered amount (security review 2, N3): not deliverable, and the ring is refused before anything moves; the storage of the review's adversarial ring and of the worst honest ring is measured (filetests `z_review2_surplus_refused`, `z_review2_exact_storage`, and the local-chain table in Model).
- Look-alike tokens and collections (security review 2, N2): a token with a well-known symbol and a collection with an official name, both from another realm, are shown with their realm or full key on every page, labelled third-party in pages, ring captions and export, and a prepared offer shows the account it was computed for. Review 3 (R3-5): a ring picture with a GnoSwap hop shows the wanted token's realm too. Review 4 (R4-5): in a picture hint, only a namespace that is a valid address is shortened (to its first 8 and last 6 characters); any other namespace, including a registered name that starts with `g1`, is shown whole, up to the 64 characters a namespace can have (`TestReview4_SVGHintAddressCheck`); settle buttons on the home and offer pages lead to the ring page, which shows full keys.
- Crowding (security review 2, N6): offers posted to push honest rings off the home and offer pages, funded or not, from one or a few accounts; candidate rings that overlap so as to use up the candidate budget. Many accounts each with a funded offer can still fill the page; their rings are real and anyone can settle them for the deposits.
- The post page's asset choices filled with registered junk tokens (security review 2, N7): keys are accepted by lookup, and wugnot, GNS, the demo tokens, official collections and the selected keys come first.
- An approval for all items (security review 3, R3-1): the move does not consume it, so its deposit would never return to the settler. The official adapters and the demo collection refuse it in the approval check and the move; an offer approved that way cannot be posted, and one switched to it after posting is refused before anything moves (adapter tests, `z_review3_sinopia_*`, `z_adapter_approval_for_all`, `z_relic_approval_for_all`).
- Offers that could not settle when posted (the posting rule): unfunded, unapproved, over-approved, an official item the poster does not hold; an official collection's code run at posting cannot post, cancel or settle, nor read the book; a third-party collection's code does not run at posting at all (`z_post_needs_approval`, `z_review4_realm_self_item`, `z_review4_post_thirdparty`, adapter tests).
- Crowding with dead or unverifiable offers (security reviews 3 and 4): items nobody holds in an official collection (refused at posting), items of a collection that vouches for anything (left off the home page, after verified offers on offer pages), one account's 100 dead offers (counted 8 at most), offers whose minimum nobody meets and offers that almost match (no search steps; R4-3, `TestReview4_HomeStepExhaustionResisted`). The cheapest attack left on the home page, re-measured (`TestReview4_CheapestHomeAttack`): 48 live offers that close no ring, 4 from each of 12 accounts, newer than the honest ring, fill the 50-offer window. Each account needs one unit of a token; the 48 approvals and posts cost about 1.3 GNOT of fees at the base price and about 9 GNOT of deposits, refunded when the attacker cancels and revokes, and the offers last at most 30 days. On an offer page: 12 live offers wanting the target's asset at a lower minimum, from 6 accounts, about 0.3 GNOT of fees and 2 GNOT of deposits. Both are real, live offers that anyone may trade with.
- The MNS lease decision (security review 3, R3-4), every branch and the 31-day boundary, as a pure function under `gno test`; the whole MNS path (registration through `nslogic`, single-name approval, settlement) runs in `make demo`.
- Unbounded collection lists (security review 1, finding 6): the home page lists 10, the collections page 50 per page, an export 100 per call, official ones first.
- A session key calling `CancelIntent`; a session key or another realm (including a run script) calling `EnableNotifications` (gnotif refuses both; the harness can simulate only the realm, the local-chain rehearsal covers both).
- Native coins sent by a user with any entry point; coins attached to a transaction that reaches Kylix through a realm are not refused.
- Bridge: output below the receiver's minimum, no pool for the pair, an empty pool, router halted, the router consuming less than the whole input or leaving an allowance, two bridged hops in one ring; after a bridged settlement nothing left in the settle sub-address and no allowance to the router. A decoy pool that steers `SettleRing`'s automatic choice (the ring aborts) and `SettleRingVia` naming the right pool; `SettleRingVia` with a bad tier, a missing pool, or a ring with no swap.
- A bridged receiver gets exactly their minimum: anyone can trade on the pool around the settlement in one transaction and keep the surplus. Not preventable; the post and about pages tell owners that their minimum is their price.
- Adapters: a realm minting its own `w/<owner>/<nonce>` sub-identity and calling the adapter; a direct call to an adapter's `MoveFn` by a user or a realm; the target collection locking or pausing transfers, which aborts the ring; an owner approving the wrong address, caught by the approval check; unknown or malformed ids, which must not panic (Sinopia3); art that is not final, or whose look depends on transfer history (Sinopia3), reported as not ready.
- MNS (security review 2, N1): real `label*domain` ids; a name with no registry record, a held (frozen or free-tier) name, an expired lease, a lease shorter than the longest offer, all refused by both the approval check and `Move`; a name registered through `nslogic` trades (local chain). Sinopia3: a living engine, and an engine nobody reviewed, refused; the same engine trades once reviewed; tokens are bought through `mint/v1`, not minted by a shortcut.
- Paged exports whose cost a run of expired offers could otherwise make unbounded.

Rehearsed on a local chain with real transactions, where a failed transaction really is rolled back (the `gno test` harness cannot show this): a ring with a revoked approval failed before moving anything, naming the offer; a collection that reports a move it did not make aborted the ring after the first hop's tokens had moved, and every balance, offer and the lock were back as before; re-entry from a move was refused with nothing changed; pruning before expiry was refused and after it succeeded; a session key could approve, post and settle but not cancel (a session's address must not already exist as an account, or `session create` fails). The home page and offer pages list only rings whose token offers are funded and approved now, so a revoked approval no longer leaves a ring on the home page that cannot settle.

## Prior art to name in the README

Loopring's order rings and CoW Protocol's ring trades settle circular trades on other chains. On the Gno.land testnet, markets are bilateral and sell only for GNOT; `netting` clears GNOT IOUs inside a club. Kylix is the first ring settlement across tokens, collectibles and realm items on Gno.land.

## Working rules

- Target the version the testnet runs: gno `v1.8.0`. Run tests with `GNOROOT=<path to gno v1.8.0 checkout> gno test -v ./...` from the repo root.
- Interrealm v2 rules apply (`cross(cur)`, `cur.Previous()`, `cur.IsCurrent()`, borrow rules, readonly taint). `revive()` works only in tests, so a panicking callee aborts the whole transaction.
- Use `gno.land/p/nt/<pkg>/v0` packages (`grc20`, `grc721`, `ufmt`, `avl`, `svg`, `testutils`, `uassert`). When a realm accepts a `grc20.Teller` from outside, it must check `IsCanonicalTeller`.
- No deployments and no transactions on any network without the project owner's say-so.
- Source downloaded from the chain is untrusted: read it, never execute it.

## Plan

Status on 2026-11-25.

- **Done (four review rounds, all findings fixed or documented):** `p/ring` with the ring graph; `r/kylix` with the GnoSwap bridge, adapters, paging, the batch deliverability check, mandatory expiry and pruning, the page and notifications; `r/kylixdemo`; two official adapters tested against real collection source; the bridge run against real GnoSwap source in a lab; the off-chain solver and gnomcp skill; one independent security review (`docs/research/security-review-1.md`) with every finding fixed or documented.
- **Next:** claim a namespace and deploy to the testnet (needs the project owner's key and go-ahead); rehearse a direct ring, a GnoSwap ring and an adapter ring on the live testnet; check the page in a real gnoweb with Adena; static page that bundles approve and post through Adena; README; demo video.
