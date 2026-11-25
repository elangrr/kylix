# Kylix — Independent Security Review (Round 3)

**Verdict:** Not ready for a public testnet yet. One high-severity blocker remains: both official NFT adapters (`r/adapters/sinopia3` and `r/adapters/nsnft`) accept `SetApprovalForAll`, re-opening repeatable GNOT storage-deposit extraction on 100%-official rings under both `SKILL.md` session keys and `gnokey -max-deposit auto`; the 12-item Home crowd-out (`R3-2`), 64-Sybil solver blinding (`R3-3`), untested MNS lease paths (`R3-4`), and inaccurate `README.md` claims should also be fixed before launch.

Working copy (`S` = `<scratch>`): `S/kylix-lab/review3/work/`.

---

## New Findings

### R3-1. [High] Official NFT adapters accept `SetApprovalForAll`, re-opening repeatable GNOT deposit extraction on 100%-official rings

- **Files & lines:** `r/adapters/sinopia3/adapter.gno:78,108`, `r/adapters/nsnft/adapter.gno:71,89`, `solver/SKILL.md:14,19-23`, `solver/cmd/kylix-solver/main.go:54-56,708-730`.
- **Confidence:** High (demonstrated on real `sinopia3/core` + `engines/genesis` + `mint/v1`; reasoned identically for `nsnft/v2`, which delegates `TransferFrom` to `p/nt/grc721/v0`).
- **Attacker's steps:** Exact GRC20 approvals and single-token `grc721.Approve` (`token.gno:327`) delete their approval nodes on transfer. Both official adapters also accept `IsApprovedForAll`, which `grc721.transfer` never deletes:
  1. **Vs. `SKILL.md` session key (`spend_limit = 2 GNOT`, no `max_deposit`):** 6 accounts hold ≥2 NFTs in 2 Final Genesis Sinopia3 collections (even hold `cA`, odd `cB`, 0 of the other), call `core.SetApprovalForAll(..., true)` for each offer's adapter sub-address, and post a 6-leg official ring. Settlement allocates 6 fresh balance nodes (`sinopia3/core: +12,288 B` = `+1.2288 GNOT` charged to settler and `spend_limit`) while `kylix` refunds `-3,222 B` (`-0.3222 GNOT`) — settler loses `0.9066 GNOT` + gas. Revoking `SetApprovalForAll` reclaims approval deposits and transferring the 6 NFTs out reclaims `+1.2288 GNOT`, netting `~+0.74 GNOT` after gas per ring, repeatable.
  2. **Vs. `gnokey -max-deposit auto` + simulation TOCTOU:** 6 accounts post a 100%-official mixed 6-leg ring: 3 Sinopia3 items (`SetApprovalForAll`) + 3 exact-approved `OBOL` legs. Settlement charges `sinopia3/core: +6,141 B` + `kylixdemo: +886 B` = `+7,027 B` (`702,700 ugnot`), under the `auto` cap (`3×250k + 3×100k = 1,050,000 ugnot`), while `kylix` refunds `-3,192 B` (`-0.3192 GNOT`) — settler loses `0.3835 GNOT` + gas (`~0.44 GNOT`); attacker reclaims `~1.228 GNOT` vs `~0.845 GNOT` deposits (`~+0.18 GNOT` net profit after gas). Holding 1 dummy unit per receiver during `gnokey -simulate only` shows `~+0.84 GNOT` profit, then transferring them out before broadcast flips execution to `-0.44 GNOT` loss.
- **Demonstrated:** `S/kylix-lab/review3/work/r/adapters/adaptertest/filetests/z_review3_sinopia_approvalforall_filetest.gno` and `z_review3_sinopia_mixed_filetest.gno`.
  ```sh
  cd S/kylix-lab/review3/work && GNOROOT=S/gno-v180 GNOHOME=$PWD/.gnohome gno test -v ./r/adapters/adaptertest
  ```
- **Smallest fix:** Reject `SetApprovalForAll` in both official adapters (`Approved` and `Move`): require single-token `GetApproved(tid) == spender` before `TransferFrom`.

### R3-2. [Medium] On-page Home and `offer/<id>` ring search still crowded out by 12 non-existent item offers

- **Files & lines:** `r/kylix/match.gno:28-38,217-219,254-260`.
- **Confidence:** High (demonstrated).
- **Attacker's steps:** `tokenReady(o)` always returns `true` for item offers, and `PostIntent` does not check ownership.
  1. **Home (12 offers, 3 accounts):** 3 zero-balance accounts post 4 non-existent item offers each (3 disjoint `K_{2,2}` blocks), passing all caps and hitting `maxCandidates = 12`, hiding all honest rings and filling all 6 Home slots with unsettleable fake rings. Cost: `0` capital, `~0.8 GNOT` refundable deposit + `~0.19 GNOT` gas (contradicting `match.gno:24-26`, `DESIGN.md:197`).
  2. **`offer/<id>` (12 offers, 6 accounts):** 6 accounts post 2 fake item offers each wanting `target.Give`, filling `matchMaxBucket = 12` and hiding honest closing rings.
  3. **Home window exhaustion (100 offers, 1 account):** 100 unapproved token offers (`~5.3 GNOT` refundable + `~1.6 GNOT` gas) saturate `matchScanRawLimit = 100` and empty Home's window.
- **Demonstrated:** `S/kylix-lab/review3/work/r/kylix/review3_security_test.gno` (`TestReview3_HomeCrowdOut12FakeItems`, `TestReview3_OfferPageCrowdOut12FakeItems`, `TestReview3_HomeWindowExhausted100Unapproved`).
  ```sh
  cd S/kylix-lab/review3/work && GNOROOT=S/gno-v180 GNOHOME=$PWD/.gnohome gno test -v -run TestReview3_ ./r/kylix
  ```
- **Worst-case render gas (full 100-offer scan: 50 unapproved + 50 ready + 6 SVGs):** `Render("")` = `577.8M` gas (`z_review3_render_gas` minus base); `Render("offer/<id>")` = `185.7M` gas (`z_review3_offer_gas` minus base) — both << Gno's `3B` query limit.
- **Smallest fix:** Verify `OwnerOf`/`Approved` in `tokenReady` for **official** collections, exclude unverified third-party items from Home candidates, and cap per-owner unapproved skips in `collectMatchWindow`.

### R3-3. [Medium] Off-chain solver blinded on any token by 64 Sybil fake-item offers

- **Files & lines:** `solver/ring/finder.go:518-520,731-734`, `solver/cmd/kylix-solver/main.go:500-577`.
- **Confidence:** High (demonstrated).
- **Attacker's steps:** `preScreenDeliverable` only checks offers in `selectedDirect` or `FindBridgedCandidateOffers` (`Give.Kind == KindFungible`). 64 Sybil accounts each post 1 unapproved offer giving a non-existent official item (`kylixdemo`) and wanting `1 wugnot` (`~3.8 GNOT` refundable deposit, `0` capital). They pass `OfficialOnly` and `--max-per-owner 4`, fill `DefaultMaxFanout = 64` for every newer honest offer giving `wugnot`, form 0 direct or bridged candidates, so `preScreenDeliverable` makes 0 `Deliverable` calls and outputs 0 rings.
- **Demonstrated:** `S/kylix-lab/review3/work/solver/cmd/kylix-solver/review3_security_test.go` (`TestReview3_SybilItemOffersBypassPreScreenAndBlindSolver`).
  ```sh
  cd S/kylix-lab/review3/work/solver && go test -v -run TestReview3_ ./cmd/kylix-solver
  ```
- **Smallest fix:** When `TruncatedReason == "max_fanout"`, screen offers filling truncated buckets via `Deliverable`, drop dead ones, and re-run `FindRings`.

### R3-4. [Low] MNS adapter lease/frozen/approval/move paths are dead code under `gno test`

- **Files & lines:** `r/adapters/nsnft/adapter.gno:70-72,85-89,107-118`, `r/adapters/adaptertest/d_review2_security_test.gno:109-160`, `scripts/local-demo.sh:245-252`.
- **Confidence:** High (code inspection + test run).
- **Details:** Under `gno test`, `nsdata/v2` has empty `admin`, so no name record exists; `TestReview2_MNSAdapterChecksTheLease` exits at `adapter.gno:104`, never running `GetNameInfo`, `frozen`, `IsNameValid`, `MinLeaseLeft`, `Approved:85-89`, or `Move:70-72`. Flipping `<` to `>` on line 114 or swapping `(label, domain)` passes all `gno test` runs. `make demo` lists `cleo*gnoland` (offer 7) but never settles it.
- **Smallest fix:** Extract a pure `checkLease(exists, frozen, valid bool, expires, now int64) string` helper and unit-test every branch; settle offer 7 in a local-chain test script.

### R3-5. [Low] Residual look-alike gaps in bridged SVGs and Home/`offer/<id>` settle cards

- **Files & lines:** `r/kylix/render_pages.gno:94-97,232-245`, `r/kylix/render.gno:183-187`, `p/ring/svg.gno:387,437`.
- **Confidence:** High (demonstrated + code inspection).
- **Details:** Bridged `ring/<ids>` SVGs show the wanted token by symbol alone (`≥ 100 GNS`) and only show `assetHint` for the *given* token (prose below shows full keys). Home and `offer/<id>` put `Settle ring` buttons beside shortened `shortAsset` hints; 3-offer Home SVGs clip hints at 19 runes (`svg.gno:387`).
- **Demonstrated:** `TestReview3_BridgedRingSVGOmitsWantedTokenHint` in `r/kylix/review3_security_test.gno` (command in `R3-2`).
- **Smallest fix:** Include both given and wanted realm hints in bridged SVG `Note`; show full keys beside `Settle ring` buttons (or link cards to `ring/<ids>`).

---

## Round 2 Findings & Exact-Approval Verification

| Item | Status | What was run & notes |
|---|---|---|
| **N1** (MNS) | **Partly holds** | Ran `adaptertest`; audited `nsnft/v2`, `nsdata/v2`, `nslogic/v2`, `nsmarket/v2`. `*` is safe everywhere (escaped in markdown/URLs/SVG/JSON; never in shell args). `nsnft` bumps `Epoch` on transfer, wiping seller records/TTL; `Unmovable`/`OwnerOf`/`Approved` are panic-free. Gaps: `R3-1`, `R3-4`; minor: `Unmovable` checks `IsTrusted` not `IsPaused`/`GetSuccessor`, pre-sale cached TTL is inherent to MNS. |
| **N2** (Look-alikes) | **Partly holds** | Ran `r/kylix` + `TestReview3_BridgedRingSVGOmitsWantedTokenHint`. Official/third-party badges and `:post` full keys + `owner` `CAUTION` hold. Minor gaps in `R3-5`. |
| **N3** (`SKILL.md` / deposits) | **Partly holds** | Audited `SKILL.md`, `deliverable.go`, `keeper.go:2634`; ran `z_review3_sinopia_*`. Prompt-injection posture (`--verbose` ban, unwrapped-stdout warning, redacted collection text) and `spend_limit` hold; extraction re-opened by `R3-1`. |
| **N4** (Fail-closed `Deliverable`) | **Holds** | Ran `solver` tests. Errors/omissions mark offers dead and drop rings. (Under `--allow-unofficial`, 1 panicking offer poisons its 50-ID batch as dead — fail-closed.) |
| **N5** (Solver blinding) | **Partly holds** | Ran `solver` tests + `TestReview3_SybilItemOffersBypassPreScreenAndBlindSolver`. Pre-DFS filter, `--max-per-owner`, and `MaxQuotes` pre-screen hold; 64-Sybil fake-item blinding remains (`R3-3`). |
| **N6** (On-page caps) | **Partly holds** | Ran `r/kylix` + `TestReview3_*` + `z_review3_*_gas`. Token screening and gas (`578M`/`186M` << `3B`) hold; 12 fake items still crowd out Home/`offer/<id>` (`R3-2`). |
| **N7** (`:post` & caps) | **Holds** | Audited `render_pages.gno`, `collections.gno`, `export.gno`; ran `r/kylix`. Direct lookup in `allowAssetKey`, pinned defaults, bounded collection lists (10/50/100, official first), `after` never reflected. (Solver reads first 100 collections — fails closed.) |
| **N8** (Solver hardening) | **Holds** | Audited `main.go`, `finder.go`, `client.go`; ran `solver` tests. `--realm` overrides `g.Realm`, overflow-safe expiry, ANSI/C0/C1/bidi stripped, collection names omitted. |
| **Exact approvals & Sinopia3 Genesis** | **Partly holds** | Ran `z_review2_{exact_storage,surplus_refused}`, `z_review3_sinopia_*`; audited `grc20/v0`, `sinopia3/engines/genesis`, `sinopia3/core`. Pure GRC20 exact approvals **hold** (no third-party allowance change, independent per-offer slots, GnoSwap hop clean, ~0.4 GNOT attacker-loss holds for pure direct GRC20 rings). Sinopia3 Genesis exception **holds** (`genesis.gno` is public, non-redeployable, stateless; `core.RegisterEngine` binds `cur.Previous().PkgPath()` immutably). Official NFT adapters fail via `R3-1`. |

---

## Unsupported `README.md` Claims

- **`README.md:77`** (*"the full path... runs on the local chain and in `make demo`"*): `scripts/local-demo.sh:245-252` only lists `cleo*gnoland`, never settles it (`scripts/README.md:46-48`).
- **`README.md:77`** (*"The realm suite covers every item in the threat list in `docs/DESIGN.md`"*): `DESIGN.md:200` (session key on `EnableNotifications`) cannot run in `gno test`; `DESIGN.md:205` (MNS lease refusals) are dead code (`R3-4`).
- **`README.md:21`** (*"leaves the settler ahead: by about 0.1 GNOT in the worst honest case... up to 1.3 GNOT"*): False for `SetApprovalForAll` official NFT rings (`R3-1`: `-0.38` to `-0.91 GNOT` + gas) and bridged rings with fresh receivers; `README.md:104` defines minimum fee from gas *limit* while the table shows gas *used* (printed `ring/<ids>` commands use `-gas-wanted 100000000 -gas-fee 100000ugnot`, cutting 2-offer worst-honest net from `+0.09` to `+0.02 GNOT`).
- **`README.md:122`** (*"Wherever you decide something, the page shows the asset's full realm path"*): Home and `offer/<id>` place `Settle ring` buttons beside shortened hints (`shortAsset`), and bridged SVGs omit the wanted token's hint (`R3-5`).
- **`README.md:126`** (*"31 days or less left"*): `r/adapters/nsnft/adapter.gno:114` checks `< MinLeaseLeft` (`31*86400`), so exact 31 days passes.
- **`README.md:59`** (*"never contacts a public network except to read dependency source once"*): `Makefile:57` makes `demo` depend on `deps`, invoking `gno mod download` every run.
