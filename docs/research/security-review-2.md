# Kylix — Independent Security Review (Round 2)

- **Snapshot reviewed:** `<scratch>/kylix-lab/review2/snapshot`
- **Working copy with verification & PoC tests:** `<scratch>/kylix-lab/review2/work`
- **Toolchain:** Gno `v1.8.0` (`GNOROOT=.../gno-v180`, `gno`), Go `solver/` test suite (`go test ./...`). All existing and newly added PoC tests pass in the working copy.

---

## New Findings (Most Severe First)

### N1. [High] `r/adapters/nsnft` rejects every real MNS v2 name (`label*domain`) and omits MNS lease-expiry checks

- **Files & lines:**
  - `r/kylix/kylix.gno:255-269` (`validItemID`)
  - `r/adapters/nsnft/adapter.gno:1-55` (`Move`, `OwnerOf`, `Approved`)
  - Real MNS source verified in `.gnohome/.../nsnft/v2/nsnft.gno:446-465` and testnet index `nsdata/v2/auth.gno:112`, `nsdata/v2/nft.gno:34-46`, `nsmarket/v2/market.gno:34,57,232`.
- **Scenario & impact:**
  1. **Broken on 100% of real MNS v2 names:** In MNS v2, every minted name NFT token ID has the format `label + "*" + domain` (e.g. `alice*gnoland`), never bare `"alice"`. `validItemID` only allows `A-Z a-z 0-9 . _ : / -` and rejects `*`, while `r/adapters/nsnft` forwards `itemID` verbatim without translating a separator. Consequently, **no real MNS name on `onyx-1` can be posted or traded**. `r/adapters/adaptertest/b_nsnft_test.gno:32` masked this by calling `nsnft.Mint(cross(cur), nAlice, "alice", 0)` directly instead of registering a real `label*domain` token ID.
  2. **Expired MNS names settle against buyer funds (Finding 1 class — becomes Critical once `*` is fixed):** `nsnft/v2/nsnft.gno:446-465` explicitly documents that `nsnft.TransferFrom` does **not** check lease expiry; MNS's own marketplace (`nsmarket/v2/market.gno:57,232`) enforces expiry via `nsdata.IsNameValid` + `registered` + `epoch`. `r/adapters/nsnft` imports only `nsnft/v2` and never consults `nsdata/v2`. Once `*` is translated or permitted, a seller can list an already-expired (unresolvable, reclaimable) name — or let a name's lease expire during Kylix's up-to-30-day offer window — and settle it against a buyer who receives a dead token.
- **Confidence & demonstration:** **Demonstrated** (high confidence).
  - Test paths:
    - `S/kylix-lab/review2/work/r/adapters/adaptertest/d_review2_security_test.gno` (`TestReview2_MNSRealTokenIDRejected`, `TestReview2_MNSAdapterDoesNotCheckExpiry`)
    - `S/kylix-lab/review2/work/r/kylix/review2_security_test.gno` (`TestReview2_MNSRealTokenIDRejected`)
  - Commands:
    - `cd S/kylix-lab/review2/work && GNOROOT=S/gno-v180 GNOHOME=$PWD/.gnohome gno test -v -run TestReview2 ./r/adapters/adaptertest`
    - `cd S/kylix-lab/review2/work && GNOROOT=S/gno-v180 GNOHOME=$PWD/.gnohome gno test -v -run TestReview2_MNS ./r/kylix`
- **Smallest fix:**
  1. Define a canonical Kylix ID format in `r/adapters/nsnft` (e.g. `<label>/<domain>` translated to `<label>*<domain>`, rejecting malformed IDs or embedded `*` cleanly without panicking — or allow `*` in `validItemID` if safe for all render/export slots).
  2. Import `nsdata/v2` in `r/adapters/nsnft` and require `nsdata.IsNameValid(domain, label)` (or require remaining lease time above a safe floor, and check the same rule in both `Approved` and `Move`, mirroring `r/adapters/sinopia3`'s `unmovable` pattern). Also test against real `label*domain` IDs.

---

### N2. [High] Token symbol and native-collection spoofing on `:post`, Home, and `ring/<ids>` tricks visitors into signing offers for lookalike assets

- **Files & lines:**
  - `r/kylix/render.gno:269-309` (`shortAsset`, `graphAsset`, `itemKind`, `shortTokenSymbol`)
  - `r/kylix/render_pages.gno:278-310` (`renderRing`)
  - `r/kylix/render_pages.gno:485-506` (`writeDraftSummary`)
- **Scenario & impact:**
  1. **Token spoofing:** `grc20reg` keys tokens by `<realmPath>.<symbol>` (`grc20reg.gno:40`), so any attacker can deploy `gno.land/r/evil/faketok` with symbol `wugnot`, `GNS`, `OBOL`, or `DRACHMA`. `shortAsset` strips the realm path and prints only `<amount> <symbol>`.
  2. **Native-collection spoofing:** `itemKind` (`render.gno:291-302`) labels **every** `RegisterItem` caller `"native"` regardless of `IsOfficial(key)`. An attacker realm `gno.land/r/evil/fakerelics` calling `RegisterItem(cross(cur), "Kylix Relics", ...)` renders as `Kylix Relics #relic-1 (native)` — byte-for-byte identical to official `r/kylixdemo`.
  3. **Concrete phishing flow on Kylix's own page:** Attacker sends victim a link to Kylix's genuine `:post` builder:
     `/r/nym-kylix000/kylix:post?owner=g1victim&giveKind=fungible&giveKey=gno.land/r/gnoland/wugnot.wugnot&giveAmount=1000000&wantKind=fungible&wantKey=gno.land/r/evil/faketok.GNS&wantMin=1000000`
     (or `wantKind=item&wantKey=gno.land/r/evil/fakerelics&wantID=relic-1`).
     At the top of the page, Kylix's own **"Your prepared offer"** box calculates the victim's real approve address for real `wugnot`, prints `giving 1000000 wugnot for at least 1000000 GNS` (or `Kylix Relics #relic-1 (native)`) — **omitting the attacker's realm path completely from the prose** — and displays a green `Post offer (wallet / $help)` button wired to `wantKey=gno.land/r/evil/...`. The victim approves real `wugnot` and posts the offer; the attacker immediately settles it with worthless fake tokens/items.
  4. The exact same omission occurs on `Render("")` (Home ring cards & Open offers table) and `Render("ring/<ids>")` (SVG, "Swaps in this ring", and Deliverability table), where full token keys never appear at all and unofficial native collections appear as `(native)`.
- **Confidence & demonstration:** **Demonstrated** (high confidence).
  - Test path: `S/kylix-lab/review2/work/r/kylix/review2_security_test.gno` (`TestReview2_TokenAndNativeCollectionSpoofingOnPages`)
  - Command: `cd S/kylix-lab/review2/work && GNOROOT=S/gno-v180 GNOHOME=$PWD/.gnohome gno test -v -run TestReview2_TokenAndNativeCollectionSpoofingOnPages ./r/kylix`
- **Smallest fix:**
  1. In `itemKind` and `collectionLabel` (`render.gno:237-302`) and `renderCollections` (`render_pages.gno:560`), distinguish `"official native"` (`IsOfficial(key)`) from `"unofficial native"` (or `"native (unofficial)"`), never giving third-party `RegisterItem` realms the same trust badge as Kylix's own namespace.
  2. In `writeDraftSummary` (`render_pages.gno:485-492`) and `renderRing` (`render_pages.gno:278-296, 308-310`), always print the full `giveKey` and `wantKey` (in inline code) next to the short label — and in `writeDraftSummary`, also print the resolved `owner` address above Step 1 so crafted `?owner=<other>` links are immediately visible.

---

### N3. [High] `SKILL.md` session-key settlement without `max_deposit` allows repeatable GNOT storage-deposit extraction even on 100% official-only pure-GRC20 rings (plus prompt-injection amplification)

- **Files & lines:**
  - `solver/SKILL.md:15,21,88-96`
  - `solver/rpc/deliverable.go:106-109`
  - Verified against Gno v1.8.0 `gno.land/pkg/sdk/vm/keeper.go:2524-2544,2628-2636` and `p/nt/grc20/v0/token.gno:189-190,227-233`.
- **Scenario & impact:**
  `SKILL.md:88-95` authorizes an AI agent to settle official-only rings via `gno_call` with a session key and **no `max_deposit`**, arguing: *"the only code that runs is Kylix, canonical GRC20 tokens, GnoSwap, and the official adapters; none of those can grow storage on purpose to drain the settler."* That argument does not hold for three concrete reasons:
  1. **Direct GNOT extraction via 100% official canonical GRC20 tokens:** On Gno v1.8.0, `processStorageDeposit` (`keeper.go:2524-2544`) charges every realm with `diff > 0` separately without netting against Kylix's `-diff` refund, and `lockStorageDeposit` deducts every positive deposit from the session's `SpendLimit` without crediting refunds back (`keeper.go:2628-2636`). An attacker controls 6 fresh addresses (`t0..t5`), each holding only `OBOL` (even) or only `DRACHMA` (odd) — or `wugnot`/`GNS` — and posts a 6-leg official-only ring with **surplus approvals** (`allowance = giveAmount + 1`, so `SpendAllowance` updates instead of removing the allowance node in `grc20/v0/token.gno:189-193`). When the agent settles the ring:
     - `r/kylix` frees `-3,180 bytes` (`-0.318 GNOT` refunded to settler — assuming ≥12 background offers so Kylix's B+ tree does not collapse),
     - `r/kylixdemo` (canonical `p/nt/grc20/v0`) allocates 6 fresh recipient AVL nodes: **`+12,348 bytes` (`+1.235 GNOT` charged to settler; net `-0.917 GNOT`, and `+1.235 GNOT` permanently deducted from session `SpendLimit`)**.
     - Immediately after, the attacker transfers those 6 balances back to 0 (`token.gno:229-230`: `led.balances.Remove`), reclaiming the settler's **`+1.235 GNOT`** deposit for **`~+0.917 GNOT` net profit per 6-leg ring**, repeatable until the session's `spend_limit` hits 0.
     - Additionally, bridged rings invoke GnoSwap `emission.MintAndDistributeGns`, `pool.writeObservation`, and `staker` hooks (`router/v2/exact_in.gno:138`, `pool/v1/swap.gno:224-299`).
  2. **Session `allow_paths` does not restrict to official collections or `SettleRing`:** Gno v1.8.0 session `allow_paths` scopes by realm path (`vm/exec:gno.land/r/nym-kylix000/kylix`), not function or arguments. A steered agent can call `SettleRing` on an **unofficial** `storagebomb` collection (or `PostIntent`).
  3. **`<untrusted_content>` gap in `SKILL.md:21`:** `SKILL.md:21` assumes chain data is wrapped in `<untrusted_content>` envelopes by `gnomcp`, but the **preferred** path (`./kylix-solver --rpc ... --json`) runs a local CLI binary whose stdout is unwrapped and copies raw VM panic strings from hostile collections verbatim into `deliverableWarnings` (`deliverable.go:106-109`).
  - **What holds (important factual confirmation for `SKILL.md:15`):** `keeper.go:2634` **does** enforce session `SpendLimit` on `lockStorageDeposit`, so a tight `spend_limit` on the session key **does** cap total deposit loss per session (resolving `SKILL.md:15`'s uncertainty). By contrast, `gnokey` with the solver's default `-max-deposit 500000ugnot` (`0.5 GNOT`) aborts the `+12,348b` (`1.235 GNOT`) attack cleanly — though note that `-max-deposit 500000ugnot` can also reject legitimate 6-leg rings with multiple fresh GRC20 recipients.
- **Confidence & demonstration:** **Demonstrated** (high confidence).
  - Test paths:
    - `S/kylix-lab/review2/work/r/kylix/filetests/z_review2_official_storage_filetest.gno` (measured `kylix: -3180b`, `kylixdemo: +12348b`)
    - `S/kylix-lab/review2/work/solver/cmd/kylix-solver/review2_security_test.go` (`TestReview2_DeliverableFailOpen` showing raw hostile panic in `deliverableWarnings`)
  - Commands:
    - `cd S/kylix-lab/review2/work && GNOROOT=S/gno-v180 GNOHOME=$PWD/.gnohome gno test -v ./r/kylix` (see `z_review2_official_storage_filetest.gno`)
    - `cd S/kylix-lab/review2/work/solver && go test -v -run TestReview2_DeliverableFailOpen ./cmd/kylix-solver`
- **Smallest fix:**
  1. Remove the false claim in `SKILL.md:88-95` that official-only rings cannot grow storage on purpose; state explicitly that `spend_limit` bounds storage deposits (`keeper.go:2634`) and require a tight per-session `spend_limit` (e.g. `1000000ugnot`) or require `gnokey -max-deposit` until `gno_call` supports `max_deposit`.
  2. Sanitize/truncate `DeliverableWarnings` to a fixed safe summary (e.g. `"Deliverable RPC/VM error for offer <id>"`) instead of echoing raw attacker-controlled panic strings into the agent context.

---

### N4. [Medium] Solver `selectDeliverableRings` fails open when `Deliverable(ids)` errors or omits offer IDs

- **Files & lines:**
  - `solver/cmd/kylix-solver/main.go:334-368` (`selectDeliverableRings`)
  - `solver/rpc/deliverable.go:104-125` (`CheckDeliverable`)
- **Scenario & impact:**
  If a `Deliverable` batch fails on both the batch attempt and the per-offer retry (e.g., transient RPC outage, concurrent settlement lock, or a panicking collection under `--allow-unofficial`), or if the RPC response omits an offer ID, `CheckDeliverable` places those IDs in `res.Unknown` instead of `res.Statuses`. In `selectDeliverableRings` (`main.go:348-349`), an offer is only dropped if `st, known := checked[id]; known && !st.Deliverable`. Any ID in `unknown` has `known == false`, so `badOffers` stays empty and **the solver selects and prints executable `SettleRing` commands for completely unverified/undeliverable/panicking rings**, wasting settler gas and bypassing the deliverability check.
- **Confidence & demonstration:** **Demonstrated** (high confidence).
  - Test path: `S/kylix-lab/review2/work/solver/cmd/kylix-solver/review2_security_test.go` (`TestReview2_DeliverableFailOpen`, `TestReview2_DeliverableOmittedIDFailOpen`)
  - Command: `cd S/kylix-lab/review2/work/solver && go test -v -run TestReview2_Deliverable ./cmd/kylix-solver`
- **Smallest fix:**
  Fail closed in `selectDeliverableRings`: treat `!known || !st.Deliverable` as undeliverable (with reason `"deliverability unknown (check failed)"`), dropping the ring so the loop can try alternative disjoint rings whose offers verified cleanly.

---

### N5. [Medium] Off-chain solver blinding / starvation via cheap unapproved dust offers (`MaxFanout`, `MaxQuotes`, post-DFS `FilterOfficialRings`)

- **Files & lines:**
  - `solver/ring/finder.go:286-289,460-478` (`buildDirectAdjacency`, `quote`)
  - `solver/cmd/kylix-solver/main.go:212-223` (`FilterOfficialRings` called *after* `FindRings`)
- **Scenario & impact:**
  Because `PostIntent` checks neither balances nor approvals, an attacker with **zero token balance** can blind the off-chain solver for a modest refundable storage deposit (~0.06 GNOT/offer, 30-day expiry):
  1. **`MaxFanout` blinding (64 offers, ~3.8 GNOT refundable):** `buildDirectAdjacency` sorts matching neighbors ascending by offer ID and caps at `DefaultMaxFanout = 64` with no per-owner deduplication and before `Deliverable` runs. A single attacker address posting 64 dust offers wanting `1 wugnot` fills the entire `byWant[wugnot]` adjacency list for every newer honest offer giving `wugnot`, truncating away all honest counterparties.
  2. **`MaxQuotes` starvation (400 offers / 200 pairs):** 200 unapproved dust pairs needing a `tokA -> tokB` bridge with distinct `amountIn = 1..200` exhaust `--max-quotes 200` before honest bridged rings at higher IDs are ever quoted.
  3. **`MaxRings` starvation via unofficial collections (54 offers, ~3.2 GNOT refundable):** Because `FilterOfficialRings` runs *after* `FindRings` (`main.go:212-223`), 54 unapproved offers forming a dense cycle touching an unofficial collection saturate `DefaultMaxRings = 10,000` before honest official rings at higher IDs are visited; `FilterOfficialRings` then discards all 10,000, outputting **0 rings**.
- **Confidence & demonstration:** **Demonstrated** (high confidence).
  - Test path: `S/kylix-lab/review2/work/solver/ring/review2_security_test.go` (`TestReview2_MaxFanoutSingleAttackerBlindsSolver`, `TestReview2_MaxQuotesExhaustionBlindsBridgedRings`, `TestReview2_UnofficialCliqueExhaustsMaxRings`)
  - Command: `cd S/kylix-lab/review2/work/solver && go test -v -run 'TestReview2_(MaxFanout|MaxQuotes|UnofficialClique)' ./ring`
- **Smallest fix:**
  1. Filter out offers touching unofficial collections **before** `FindRings` when `--allow-unofficial` is false (one-pass pre-filter in `main.go`).
  2. Run `Deliverable` pre-screening on candidate offers (or at least cap per-`(owner, wantKey)` offers in `buildDirectAdjacency` to e.g. 2–4, and prefer distinct owners before truncating at `MaxFanout`).

---

### N6. [Medium] On-page Home ring search (`match.gno`) crowded out by 7 unapproved zero-balance offers (and `offer/<id>` by 12)

- **Files & lines:**
  - `r/kylix/match.gno:40-43,104-125,187-214` (`findHomeRingsFrom`, `findRingsForOffer`, `indexByWant`)
  - `r/kylix/render.gno:85-95`
- **Scenario & impact:**
  1. **Home crowd-out with 7 offers (~0.42 GNOT refundable deposit):** `findHomeRingsFrom` breaks out of the entire search once `len(cands) >= maxCandidates (12)`, *before* selecting disjoint rings and without checking deliverability. Posting just **7 unapproved, zero-balance offers** across 3 addresses (2 `FOO→BAZ`, 2 `BAR→FOO`, 3 `BAZ→BAR`) produces `2 × 2 × 3 = 12` overlapping 3-offer candidates, immediately aborting the search and hiding all older honest rings on Home (the 12 overlapping candidates collapse to 2 unapproved spam rings).
  2. **`offer/<id>` bucket saturation (12 offers):** Posting 12 newer unapproved offers wanting `target.Give` fills `matchMaxBucket = 12` (`match.gno:209`), hiding all honest closing rings on `offer/<id>`.
  3. **50-offer window push-out:** 50 expired or unapproved offers posted consecutively push all honest offers off Home's `pageOffers = 50` / `matchScanLimit = 50` window (note: `renderHome` reads `pageOffers = 50` raw offers including expired ones, so 50 expired offers also empty `window` until pruned).
- **Confidence & demonstration:** **Demonstrated** (high confidence).
  - Test path: `S/kylix-lab/review2/work/r/kylix/review2_security_test.gno` (`TestReview2_MatchHomeCrowdOut`)
  - Command: `cd S/kylix-lab/review2/work && GNOROOT=S/gno-v180 GNOHOME=$PWD/.gnohome gno test -v -run TestReview2_MatchHomeCrowdOut ./r/kylix`
- **Smallest fix:**
  1. Deduplicate by `(owner, wantBucket)` or cap per-owner entries inside `indexByWant` (e.g. max 1–2 offers per owner per bucket) and check disjointness/limit per-offer appearances when collecting `cands` in `findHomeRingsFrom` so 7 overlapping offers cannot burn all 12 candidate slots.
  2. Optional improvement: for fungible-only offers (which only call canonical `grc20reg` and never foreign collection code), consider screening `undeliverable` or capping expired-offer skipping on Home.

---

### N7. [Medium] `:post` offer builder asset dropdown and allowlist locked out by 50 `grc20reg` spam tokens

- **Files & lines:**
  - `r/kylix/render_pages.gno:670-689` (`knownAssets`)
  - `r/kylix/render_pages.gno:745-761` (`allowAssetKey`)
- **Scenario & impact:**
  `knownAssets()` iterates `grc20reg.GetRegistry()` in lexicographic order and stops at `maxFormAssetOpts = 50`, and `allowAssetKey()` rejects any `giveKey` or `wantKey` not in that 50-item slice. Because user-address realm paths (`gno.land/r/g1...`) sort lexicographically **before** `gno.land/r/gnoland/wugnot.wugnot`, `gno.land/r/gnoswap/gns.GNS`, and `gno.land/r/nym-kylix000/kylixdemo.*`, a single attacker deploying one realm at `gno.land/r/g1.../spam` and registering 50 tokens in `grc20reg` completely evicts `wugnot`, `GNS`, `OBOL`, and `DRACHMA` from the `:post` page's `<gno-select>` dropdowns and breaks even pre-populated `:post?giveKey=...` URLs. (Note: `PostIntent` on chain still works via `gnokey`.)
- **Confidence & demonstration:** **Demonstrated** (high confidence).
  - Test path: `S/kylix-lab/review2/work/r/kylix/review2_security_test.gno` (`TestReview2_Z_PostPageAssetLockout`)
  - Command: `cd S/kylix-lab/review2/work && GNOROOT=S/gno-v180 GNOHOME=$PWD/.gnohome gno test -v -run TestReview2_Z_PostPageAssetLockout ./r/kylix`
- **Smallest fix:**
  1. In `allowAssetKey` (`render_pages.gno:745-761`), validate directly against `tokenOf(s) != nil || IsCollection(s)` (O(log N) lookup) instead of scanning the truncated 50-item slice.
  2. In `knownAssets()`, pin canonical/demo tokens (`wugnot`, `GNS`, `kylixdemo` tokens) and official collections at the front of the dropdown before filling remaining slots from `grc20reg`, and include the user's currently selected valid key if not already in the top 50.

---

### N8. [Low] Solver `--graph` trusts `g.Realm` verbatim as `-pkgpath`, omits ANSI stripping in text output, and overflows `int64` in expiry check

- **Files & lines:**
  - `solver/cmd/kylix-solver/main.go:171-175` (`realmPath = g.Realm`), `main.go:455-510` (text printer)
  - `solver/ring/finder.go:399` (`g.Height+expiryMargin > o.Expiry`)
- **Scenario & impact:**
  1. **Untrusted `g.Realm` in `--graph` mode:** When `--graph` is used (including the `SKILL.md` fallback), `g.Realm` from the JSON overrides `--realm` without validating that it is a valid `gno.land/r/...` realm path or warning when it differs from the default Kylix realm, redirecting printed `gnokey maketx call -pkgpath` commands to an attacker-chosen realm. (`shellQuote` *does* properly escape single quotes, so no POSIX shell injection/breakout occurs.)
  2. **`int64` overflow in expiry filter:** `finder.go:399` evaluates `g.Height+expiryMargin > o.Expiry`. If `g.Height` is near `math.MaxInt64` (e.g., crafted `--graph` JSON), `g.Height + expiryMargin` wraps negative and admits already-expired offers into rings.
  3. **Raw ANSI/control bytes in text mode:** Unsanitized `g.Realm`, `DeliverableWarnings`, and `Dropped` reasons are printed directly to terminal stdout in text mode.
- **Confidence & demonstration:** **Demonstrated** (high confidence).
  - Test paths:
    - `S/kylix-lab/review2/work/solver/cmd/kylix-solver/review2_security_test.go` (`TestReview2_GraphFileRealmHijackAndShellQuote`, `TestReview2_DeliverableFailOpen`)
    - `S/kylix-lab/review2/work/solver/ring/review2_security_test.go` (`TestReview2_HeightOverflowBypassesExpiry`)
  - Command: `cd S/kylix-lab/review2/work/solver && go test -v -run 'TestReview2_(GraphFileRealmHijack|HeightOverflow)' ./...`
- **Smallest fix:**
  1. In `main.go:171`, only override `--realm` when `--realm` was not explicitly passed AND validate `g.Realm` matches `^gno\.land/r/[a-z0-9._/-]+$` (or always require explicit `--realm` / keep default).
  2. Rewrite `finder.go:399` overflow-safely as `o.Expiry - g.Height < expiryMargin` (after checking `g.Height > o.Expiry`).
  3. Strip control characters (`< 0x20`, `0x7f`, ANSI CSI) when printing untrusted strings in text mode.

---

## Part 1: Verdict on the 11 Findings from Review 1

| # | Review 1 Finding | Verdict | What was run to check | Notes / anything newly broken or allowed |
|---|---|---|---|---|
| **1** | Mutable-value NFTs (GNFT atomic liquidity rug-pull) | **Partly fixed** | Verified `r/adapters/gnft` removed; audited & tested remaining adapters (`r/adapters/sinopia3`, `r/adapters/nsnft`), `r/kylixdemo`, and `p/nt/grc20/v0` (`TestReview2_MNSAdapterDoesNotCheckExpiry`, `TestReview2_Sinopia3PoisonIDsHold`). | **GNFT:** fixed (adapter removed). **`kylixdemo` & canonical GRC20:** hold (immutable Relic IDs, standard GRC20 balances). **Sinopia3:** mostly holds (`StateFinal`, `TokenSeed != ""`, `!Living` enforced in both `Approved` and `Move`), with a minor caveat that `sinopia3/core/engines.gno:26-28` allows unreviewed stateful engines (`EngineStatus != "reviewed"`) even when `Living == false`. **MNS (`r/adapters/nsnft`):** **regressed/open for this class** — omits `nsdata.IsNameValid` lease-expiry checks (see **N1**). |
| **2** | Hostile collection storage-deposit drain | **Fixed for pruning/reads; Documented only (VM limit) for settlement** | Ran `z_storagebomb_prune_filetest.gno` (`kylix: -522b`, 0 bomb writes), `TestReview2_ExpiryAndReview1FixesHold` (0 callbacks in `PruneIntent`), `TestHomeNeverCallsCollectionCode` (panicking collection does not break Home/Collections/Post/About). | `FlagIntent` removed; `PostIntent`, `CancelIntent`, `PruneIntent`, `Render("")`, `Render("collections")`, `Render("post")`, `Render("about")`, `ExportGraphJSON*`, and `match.gno` call **zero** foreign collection code. `SettleRing`/`SettleRingVia` and `Deliverable` (query: 0 deposit) still call collection callbacks by design (inherent GnoVM rule). Note **N3**: even official GRC20 tokens can grow storage on settlement when settling without `-max-deposit`. |
| **3** | Decoy pool DoS in `bridgeFee` | **Fixed** | Verified `z_bridge_decoy_via_filetest.gno`, `z_bridge_zero_reserve_filetest.gno`, `TestRingPageNamesThePool`, and `bridge.gno:46-68` (`bestReserve` starts at 0, ignoring 0-reserve pools; `SettleRingVia` lets settler name tier). | **Specific question checked:** Can a settler abuse `SettleRingVia` by picking the worst pool that still meets `wantMin`? **Yes** — a settler (or attacker who owns a 1% pool) can route through a worse tier down to `wantMin`. However, this is **strictly no worse than Finding 5**: any unprivileged account can already push execution on the *best* pool down to `wantMin` atomically in a single `MsgRun` sandwich. Receiver's `wantMin` floor is always enforced (`bridge.gno:113`). |
| **4** | Sinopia3 poison CID panic & pre-reveal lock | **Fixed** | Ran `TestSinopia3NotFinalIsNotReady`, `TestSinopia3PoisonIDs`, and `TestReview2_Sinopia3PoisonIDsHold` (`999999/1`, `01/1`, `1/0`, `1/01`, 19-digit IDs, etc.). | `parseID` validates 1–18 canonical digits and `n <= core.CollectionCount()`; `unmovable` checks `StateFinal`, `TokenSeed != ""`, and `!Living` in both `Approved` and `Move`. Zero panics across `OwnerOf`, `Approved`, and `Deliverable`. |
| **5** | Single-tx `MsgRun` atomic sandwiching on GnoSwap bridge | **Documented only** | Inspected `bridge.gno`, `render_pages.gno:376-378,618-621`, `DESIGN.md`, `SKILL.md`. | Inherent to AMM execution without private orderflow; prominently warned on `:post`, `:about`, `DESIGN.md`, and `SKILL.md` ("Your minimum is your price"). |
| **6** | Unbounded expired-offer scan in `ExportGraphJSONPage` & unpaginated `collections` | **Partly fixed** | Ran `TestExportPageBoundedScan` and `TestReview2_ExpiryAndReview1FixesHold` (550 expired offers). Inspected `export.gno:70-108`, `render.gno:221-232`, `render_pages.gno:558-577`. | Expired-offer scan is **fixed** (bounded by `scanned == MaxExportPage = 500`, spurious `hasMore:true` fixed, `collections` omitted for `after > 0`). However, `collections` remains **unpaginated** in `ExportGraphJSONPage(0, ...)`, `Render("")`, and `Render("collections")` (higher attacker cost since each requires deploying a realm, but still unbounded). |
| **7** | Read-only re-entrancy during `SettleRing` | **Fixed** | Ran `TestReadsRefusedDuringSettle` and `TestReview2_ExpiryAndReview1FixesHold` (all 5 read entry points panic with `"kylix: settlement in progress"` while `locked`, plus live callback abort during `SettleRing`). | `assertNotSettling()` guards `GetOffer`, `OpenOffers`, `Deliverable`, `ExportGraphJSON`, `ExportGraphJSONPage`. `Render` is intentionally excluded (queries only); `NextSlot`/`ApproveTarget`/`GetCollection` only read immutable/non-ring state. |
| **8** | `guard()` unconditionally rejecting `OriginSend()` | **Fixed** | Ran `TestCoinsRejected` and `TestReview2_ExpiryAndReview1FixesHold` (`postAsRealm` with `OriginSend` succeeds; direct user call with `OriginSend` aborts). | `kylix.gno:186` now checks `cur.Previous().IsUserCall() && len(unsafe.OriginSend()) > 0`, unblocking payable wrapper realms and `MsgRun` scripts. |
| **9** | Stale `FlaggedAt` zero-grace pruning | **Fixed** | Verified `FlagIntent` removed completely; ran `TestExpiryDefaults`, `TestPruneOnlyExpiredAndCallsNoCollectionCode`, and `TestReview2_ExpiryAndReview1FixesHold`. | Replaced by mandatory expiry (7d default / 30d max). **Expiry edge-case audit:** `expiry <= h` and `expiry > h+MaxExpiryBlocks` refused; `h == o.Expiry` settles cleanly and refuses pruning; `h == o.Expiry+1` refuses settlement (including if expiring between preflight and tx inclusion) and allows pruning; `h + MaxExpiryBlocks` cannot realistically overflow `int64` on chain (~1.4 trillion years at 5s blocks). No expiry griefing vector found against other users' offers (only the owner picks their own expiry, and expired offers cannot block `PruneIntent` or `ExportGraphJSONPage`, though 50 expired offers can push active offers out of Home's 50-offer window until pruned — see **N6**). |
| **10** | `renderOffer` showing `Slot` instead of `ApproveTarget` & omitting trust labels | **Fixed** (with caveat in **N2**) | Inspected `render_pages.gno:61-68,136-155` and ran `TestRenderPagesAndUsernames`. | `offer/<id>` now prints `Address to approve` (`ApproveTarget`), distinguishes `Offer's own address` for adapters, and prints full asset keys + adapter trust labels. However, `:post` draft summary, Home, and `ring/<ids>` still omit full token keys and fail to distinguish official vs unofficial native collections (see **N2**). |
| **11** | Test suite gaps & vacuous assertions | **Partly fixed** | Audited `helpers_test.gno`, `settle_test.gno`, `render_test.gno`, `b_nsnft_test.gno`, `c_sinopia3_test.gno`, `notify_enable_filetest.gno`, `main_test.go`, `finder_test.go`. | `aborts()` now checks `!locked`; `TestTwoLegRing` fixed; mock pool tracks per-pool reserves; decoy/zero-reserve/allowance-left/storagebomb-prune filetests added. **Remaining test gaps** listed under Part 2 item 5 below. |

---

## Part 2: New Code Assessment

1. **The page (`render.gno`, `render_pages.gno`, `p/ring/svg.gno`):**
   - **What held:** Escaping against HTML/Markdown/gnoweb-tag/SVG injection held across all tested payloads (`<gno-button>`, `<gno-form>`, `<script>`, markdown links/images, bidi/zero-width chars, SVG `</text><svg>` breakouts — `TestReview2_PageInjectionVectorsHold` and `p/ring/svg_test.gno`), query params on `:post` are strictly parsed/allowlisted without raw reflection, and Home/Collections/Post/About never invoke collection callbacks (`TestHomeNeverCallsCollectionCode`).
   - **What broke:** Token symbol and unofficial-native-collection spoofing on `:post`, Home, and `ring/<ids>` (**N2**), and `:post` asset dropdown/allowlist lockout via 50 `grc20reg` spam tokens (**N7**).
2. **On-page ring search (`match.gno`):**
   - **What held:** Worst-case query gas is well below the 3B query limit: measured **`614,729,394` gas** (~20.5% of 3B) for `Render("")` with 50 newest offers, 50 distinct registered usernames, 64-char item IDs, dense shortfalls, and 3 rendered 3-offer SVG thumbnails (`z_review2_render_gas_filetest.gno`), and **`342,179,443` gas** (~11.4% of 3B) for `Render("offer/<id>")` (`z_review2_offer_gas_filetest.gno`).
   - **What broke:** Just 7 unapproved zero-balance offers exhaust `maxCandidates = 12` before disjoint selection and crowd out all honest rings on Home, 12 unapproved offers saturate `matchMaxBucket` on `offer/<id>`, and 50 expired offers empty Home's search window (**N6**).
3. **Notifications (`notify.gno`, `settle.gno:146-159`):**
   - **What held:** Authorization via `gnotif.Open` enforces direct call by the namespace owner's account key (rejecting session keys and indirect realm calls on chains where `r/sys/names` is enabled); `OfferSettled` cannot spam arbitrary victims (only fires when the victim's own approved offer actually settles), and `Title`/`Link` are static while `Body` interpolates only `id` and validated asset strings (`[A-Za-z0-9._:/-# ]`).
   - **Minor caveat:** `gnotif.Open`'s `mustOwnerEntered` (`gnotif.gno:186-199`) omits the `names.IsEnabled()` guard that `Drop`/`Revoke` enforce (`gnotif.gno:212`) — moot on `onyx-1` where `r/sys/names` is enabled, but anyone could claim the handle on a fresh chain before `names.Enable`.
4. **The solver (`solver/`) & `SKILL.md`:**
   - **What held:** Hostile/malformed JSON inputs caused no panics or hangs (`TestReview2_HostileGraphJSONNoPanic`), `shellQuote` prevented POSIX shell breakout (`TestReview2_GraphFileRealmHijackAndShellQuote`), `VerifyRing` matches realm rules (no rings settled to a participant's loss), and `--max-deposit 0` is properly rejected.
   - **What broke:** `selectDeliverableRings` fails open on `Deliverable` errors/omissions (**N4**); cheap unapproved offers blind the solver via `MaxFanout`, `MaxQuotes`, and post-DFS `FilterOfficialRings` (**N5**); `SKILL.md`'s no-`max_deposit` session-key argument is refuted by `+12,348b` (`1.235 GNOT`) storage-deposit extraction on a 100% official-only GRC20 ring plus unwrapped `DeliverableWarnings` (**N3**); and `--graph` trusts `g.Realm` verbatim / `finder.go:399` overflows `int64` on huge heights (**N8**).
5. **Tests:**
   - **Concrete gaps found:**
     - `r/adapters/adaptertest/b_nsnft_test.gno:32` mints `"alice"` instead of real MNS `"alice*gnoland"` and never tests lease expiry — completely missing **N1**.
     - `r/adapters/adaptertest/c_sinopia3_test.gno` never tests a `Living: true` engine (that branch in `sinopia3/adapter.gno:104` is untested).
     - `r/kylix/filetests/notify_enable_filetest.gno` does not test session-key or indirect-realm-call rejection.
     - `r/kylix/render_test.gno` (`TestRenderEscapes`) checks only 3 substrings (`<script>`, `](javascript:`, `**b**`), never testing gnoweb tags (`<gno-button>`, `<gno-form>`) or token/native spoofing.
     - `solver/cmd/kylix-solver/main_test.go` only tests `Deliverable` failing once and succeeding on retry, never failing twice (which would have caught **N4**).

---

## Public Testnet Readiness Verdict

**No — do not deploy to a public testnet as it stands.** The core ring-settlement engine, re-entrancy locking, expiry/pruning, GnoSwap bridge checks, and markdown/SVG escaping are solid, but **four concrete blockers** should be fixed first:

1. **Fix `r/adapters/nsnft` (N1):** Translate or allow MNS v2's `label*domain` token IDs AND enforce MNS lease validity (`nsdata.IsNameValid`) in both `Approved` and `Move` — or remove `r/adapters/nsnft` before launch. Shipping a broken official adapter that cannot trade any real MNS name (and lacks expiry checks) is a clear blocker.
2. **Fix asset spoofing on `:post`, Home, and `ring/<ids>` (N2):** Label unofficial `RegisterItem` realms as `"unofficial native"` (distinct from official namespace) and show full `giveKey`/`wantKey` realm paths in `:post` draft summaries and `ring/<ids>` pages.
3. **Fix solver fail-open & `SKILL.md` storage-deposit guidance (N3, N4):** Make `selectDeliverableRings` fail closed on `Unknown` IDs, sanitize `DeliverableWarnings`, filter unofficial collections before `FindRings` (**N5**), and update `SKILL.md` so agents never rely on the false "official-only cannot grow storage" assumption without a tight `spend_limit` (or `gnokey -max-deposit`).
4. **Fix `:post` `grc20reg` lockout (N7) and Home 7-offer crowd-out (N6):** Make `allowAssetKey` look up `tokenOf`/`IsCollection` directly, pin canonical/demo assets in `knownAssets()`, and cap per-owner overlap in `match.gno` so 7 dust offers cannot blank Home's Ready-to-settle cards.
