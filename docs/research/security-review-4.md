# Kylix — Independent Security Review (Round 4)

**Verdict:** Not ready for a public testnet until one blocker is fixed: `PostIntent` now runs third-party collection code (`OwnerFn`/`ApprovedFn`) at the poster's uncapped storage-deposit cost, while `:post` links to an uncapped `$help` button and the docs claim only settling runs collection code. Once closed (skip third-party callbacks in `PostIntent`, or warn and emit `-max-deposit` on `:post` and fix the docs), core settlement, single-item official adapters, lock invariants, and render gas bounds are ready for a public testnet.

Working copy (`S` = `<scratch>`): `S/kylix-lab/review4/work/`.

---

## New Findings

### R4-1. [High] `PostIntent` runs third-party collection code, enabling an undocumented poster storage-deposit drain

- **Location:** `r/kylix/kylix.gno:137-139`, `r/kylix/settle.gno:190-217`, `r/kylix/render_pages.gno:443-457,518-539`, `README.md:127`, `docs/DESIGN.md:24,206`.
- **Confidence:** High (demonstrated; affects only posters offering an untrusted third-party item—official collections and tokens are unaffected).
- **Attack & cost:** Deploy a realm (deploy gas + deposit) and call `RegisterCollection` with `ApprovedFn == nil` and an `OwnerFn` that allocates storage in its own realm and returns `runtime.OriginCaller()`. Airdrop an item or list it in `:post`, which shows no deposit warning and links to an uncapped `$help` button (default `-max-deposit` is `100 GNOT`). `PostIntent` commits and bills the poster's GNOT for storage the attacker later reclaims.
- **Demonstrated:** `r/kylix/filetests/z_review4_post_storagebomb_filetest.gno` (`+8,638 B` = `0.86 GNOT` billed to poster in `mocks/storagebomb`).
  ```sh
  cd "$S/kylix-lab/review4/work" && GNOROOT="$S/gno-v180" GNOHOME="$PWD/.gnohome" gno test -v ./r/kylix | grep z_review4_post_storagebomb
  ```
- **Smallest fix:** Skip `undeliverable` for non-official collections in `PostIntent` (Home and the default solver already skip them), or warn on `:post` and emit `gnokey` with `-max-deposit 200000ugnot` instead of `$help`, updating `:about`, `README.md:127`, and `DESIGN.md:24,206`.

### R4-2. [Medium] Solver `max_rings` round exhaustion blinds the book (140 offers), and `selectDeliverableRings` bypasses `--max-screen-queries`

- **Location:** `solver/cmd/kylix-solver/main.go:312,557-784`, `solver/ring/finder.go:184-188,1034-1060`.
- **Confidence:** High (demonstrated).
- **Attack & cost:** Post two 5-layer live junk-token DAGs (37 offers each, 0 cycles, fanout `<= 16`, `<= 4`/owner) plus 66 dead starts (60+6; 140 offers total, ~93 suffices with one DAG). Each dead start yields 2,304 dead rings, hitting `DefaultMaxRings = 10,000` after ~5 starts/round and halting DFS globally. Screening drops ~5–6 starts/round, exhausting all 10 `--max-screen-rounds` and hiding unrelated honest rings (`wugnot <-> GNS`) with 0 settleable rings (~13 GNOT refundable deposits, ~3.8 GNOT gas, 0 capital). Separately, `selectDeliverableRings` (`main.go:312,725-784`) ignores `--max-screen-queries` and omits its RPCs from `ScreenQueries`, allowing unbounded `Deliverable` calls.
- **Demonstrated:** `solver/cmd/kylix-solver/review4_security_test.go` (`TestReview4_MaxRingsRoundExhaustion98OffersBlindsEntireSolver`: `ScreenQueries=10`, actual RPCs=`16`, `selected=0`; `TestReview4_SelectDeliverableRingsExceedsMaxScreenQueries`: `2` RPCs under `--max-screen-queries 1`).
  ```sh
  cd "$S/kylix-lab/review4/work/solver" && go test -v ./cmd/kylix-solver -run "TestReview4_(MaxRings|SelectDeliverable)"
  ```
- **Smallest fix:** Cap rings per start (`maxRingsPerStart = 100`), pass remaining `maxQueries` into `selectDeliverableRings`, count its calls in `ScreenQueries`, and set `MayBeIncomplete = true` if exhausted.

### R4-3. [Medium] Home search blinded by 6 accounts / 24 live offers (half claimed cost)

- **Location:** `r/kylix/match.gno:48,89-128`, `docs/DESIGN.md:217`.
- **Confidence:** High (demonstrated).
- **Attack & cost:** `findHomeRingsFrom` counts `steps++` (`matchMaxSteps = 500`) per `(b, c)` hop before checking `directMatch(c, a)`. Six accounts post 4 live junk offers each (7 `a` wanting `100 BAZ`, 8 `b`, 8 `c` giving `1 BAZ`, 1 `d` giving `100 BAZ`): `7*8*9 = 504 > 500` steps, 0 settleable rings, hiding older honest rings for ~0.65 GNOT fees + ~4.0 GNOT refundable deposits (vs. `DESIGN.md:217`'s 13 accounts / 52 offers).
- **Demonstrated:** `r/kylix/review4_security_test.go` (`TestReview4_HomeStepExhaustion24Offers6Accounts`).
  ```sh
  cd "$S/kylix-lab/review4/work" && GNOROOT="$S/gno-v180" GNOHOME="$PWD/.gnohome" gno test -v -run TestReview4_HomeStepExhaustion24Offers6Accounts ./r/kylix
  ```
- **Smallest fix:** Cap steps per start `a` (e.g. `64`) or skip `c` offers below `a.Want.Amount` via a pair-max index.

### R4-4. [Low] Solver omits `mayBeIncomplete` on live-offer truncation

- **Location:** `solver/cmd/kylix-solver/main.go:696,1192-1215`, `solver/SKILL.md:149`.
- **Confidence:** High (demonstrated).
- **Attack & cost:** 64 accounts post 1 live junk offer each wanting `wugnot` (`max_fanout = 64`), hiding an honest ring. Round 1 confirms all 64 live (2 queries) and exits within budget, leaving `mayBeIncomplete: false` (omitted in JSON) and `"No settleable rings found."` in text without `"may be incomplete"`.
- **Demonstrated:** `solver/cmd/kylix-solver/review4_security_test.go` (`TestReview4_LiveFanoutTruncationOmitsMayBeIncomplete`).
  ```sh
  cd "$S/kylix-lab/review4/work/solver" && go test -v ./cmd/kylix-solver -run TestReview4_LiveFanoutTruncationOmitsMayBeIncomplete
  ```
- **Smallest fix:** Set `MayBeIncomplete = true` whenever `res.Stats.Truncated` is true, with a distinct `IncompleteReason`.

### R4-5. [Low] `svgHint` elision spoofable via `r/sys/users` names; 48-rune clip truncates 48–64 char namespaces

- **Location:** `r/kylix/render.gno:380`, `p/ring/svg.gno:493`.
- **Confidence:** High (demonstrated; Low because Home/offer buttons route to `:ring/<ids>`, showing full keys).
- **Attack & cost:** `svgHint` checks `strings.HasPrefix(ns, "g1") && len(ns) > 20` instead of `address(ns).IsValid()`. `r/sys/users/store.gno:16,27,30,314` blocks only `^g1[a-z0-9]{20,38}$`, so `g1jz6j9h_evil_x0yul06` or a 41-char `g1...` name elides to `g1jz6j9h…0yul06/sinopia3/core`—identical to Sinopia3's address with zero grinding. `maxNoteRunes = 48` also clips legal 48–64 char namespaces.
- **Demonstrated:** `r/kylix/review4_security_test.go` (`TestReview4_SVGHintSpoofsAddressNamespace`).
  ```sh
  cd "$S/kylix-lab/review4/work" && GNOROOT="$S/gno-v180" GNOHOME="$PWD/.gnohome" gno test -v -run TestReview4_SVGHintSpoofsAddressNamespace ./r/kylix
  ```
- **Smallest fix:** Check `address(ns).IsValid()` at `render.gno:380` and raise `maxNoteRunes` to `80`.

### R4-6. [Low] Printed gas limits under-size real GnoSwap / 6-MNS rings and overpay on 6-item / solver-bridged rings

- **Location:** `r/kylix/render_pages.gno:349-365`, `solver/cmd/kylix-solver/main.go:840-855`.
- **Confidence:** High (reasoned from `DESIGN.md:118-130`, `gnoswap-bridge.md:129`, and measured 6-Sinopia3 gas).
- **Details:** Ring page adds `+30M` for a bridge (citing mock `12M`), while isolated real GnoSwap used `33.55M` without tick-cross/emission (`~62.5M+` vs `65M` on 2-token bridged rings; OOG fails in simulation at 0 cost). Six fresh MNS legs extrapolate to `~99M` vs `97M`. Conversely, 6 relics (`60.2M`) or 6 Sinopia3 legs (measured `53.2M`: `z_review3_sinopia_single` `372.7M` minus `z_review4_sinopia_single_base` `319.5M`) print `97M`, overpaying `37–44M`; solver's `+60M` bridge overpays `30,000 ugnot` vs ring page on calm pools.
- **Smallest fix:** Raise ring-page bridge allowance to `+45M`–`+50M` and align solver after live GnoSwap measurement.

---

## Round 3 Findings & Posting Rule

| Item | Status | Verification |
|---|---|---|
| **Posting rule** | **Partly holds** | Lock blocks mutating & locked-read re-entry; nonce/slot/ID stay clean (`TestReview4_PostIntentCallbackLockAndBookkeeping`); cross-realm panics bypass `defer/recover` (`z_review4_realm_self_item_filetest.gno`); 2-msg tx, session key (`TestReview4_PostIntentViaSessionKey`), realm-self, and no-`ApprovedFn` flows work; no front-run grief. Fails via R4-1; dead offers remain postable via no-`ApprovedFn` collections or approve+post+revoke. |
| **R3-1** | **Holds** | Re-ran `z_review3_sinopia_{approvalforall,mixed}` (refused at `PostIntent`) and `z_review3_sinopia_{single,mixed_single}` (settled with net refund: `+1,968 B` vs `-3,228 B`; `+981 B` vs `-3,444 B`). Audited `grc721/v0`, `sinopia3/core`, `nsnft/v2`, `kylixdemo`, `legacyadapter`: no owner-as-spender, operator, admin, or alternate-transfer bypass. |
| **R3-2** | **Partly holds** | Third-party collections are skipped on Home and sorted last on `offer/<id>`, but Home calls official adapters. Worst-case gas on real `sinopia3/core` (92 Sinopia3 offers counted, 392 read, 6 3-offer SVGs, 100 users): Home `Render("")` = **1.13B** (37.7% of 3B), `offer/<id>` = **658M** (21.9%) via `z_review4_sinopia_{render_gas,offer_gas,render_gas_base}_filetest.gno`. Fails cost bound (R4-3). |
| **R3-3** | **Partly holds** | `TestReview3_SybilItemOffersBypassPreScreenAndBlindSolver` passes; loop terminates. Fails via R4-2, R4-4. |
| **R3-4** | **Holds** | `leaseProblem` (`r/adapters/nsnft/adapter.gno:129-145`) matches `nsdata/v2/read.gno` (`expires`=3rd, `frozen`=5th), `IsLocked`, `IsTrusted`, `IsNameValid`; `adapter_test.gno` covers all 6 branches + 31-day boundary; `scripts/local-demo.sh:258-267` settles `ben*gnoland`. |
| **R3-5** | **Partly holds** | Bridged SVGs show `WantNote`; Home/offer buttons route to `:ring/<ids>`. Fails via R4-5. |

---

## Unsupported Claims (`README.md` & `docs/DESIGN.md` Decisions 10–13)

- **`README.md:18`**: *"book cannot be filled with offers nobody can honour"*—false for no-`ApprovedFn` collections and single-tx approve+post+revoke (1 reusable token).
- **`README.md:82-97`**: Example `Move` omits `GetApproved(tid) == cur.Previous().Address()`, contradicting `README.md:123` and re-introducing R3-1.
- **`README.md:114`**: *"Settle 6 offers | 47 million | 1.38 GNOT"* matches no row in `DESIGN.md:118-130`.
- **`README.md:127`, `DESIGN.md:24,206`**: Claim only settling runs collection code, omitting `PostIntent` (R4-1).
- **`DESIGN.md:116-129`**: Cites old flat solver limits (`60M`/`120M`, *"out of gas at 60M"*), contradicting `main.go:840-855` (`main.go:345` also claims *"same formula the ring page uses"* despite `+60M` vs `+30M`; `solver/README.md:118` says *"5 rounds"* vs `10`).
- **`DESIGN.md:178`, `render.gno:31`**: Claim *"Home never calls collection code"*, contradicting `match.gno:241-243` and `DESIGN.md:180`.
- **`DESIGN.md:212`**: Claims hints *"never cut the namespace"* (R4-5).
- **`DESIGN.md:217`**: Claims cheapest Home attack is 13 accounts / 52 offers (demonstrated 6 / 24, R4-3).
