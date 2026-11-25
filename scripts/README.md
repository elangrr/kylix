# Local demo

`local-demo.sh` starts an in-memory gno.land chain on this machine with
gnodev, deploys Kylix and its demo realms, and seeds a small market from six
throwaway accounts. It never contacts a public network.

## Run it

You need `gnodev` and `gnokey` built from gno v1.8.0 (the version the testnet
runs), a gno v1.8.0 checkout for `GNOROOT`, and the module cache that
`make deps` fills (the demo copies Sinopia3, the MNS ledger, registry and
logic realms, and gnotif from it; the download is the only network access,
and it only reads).

```sh
make deps GNOROOT=/path/to/gno-v1.8.0   # once: reads package source from the testnet
make demo GNOROOT=/path/to/gno-v1.8.0   # or: GNOROOT=... scripts/local-demo.sh
```

`make demo` itself contacts no network (it no longer runs `make deps`).

`GNODEV` and `GNOKEY` override the binaries; `RPC_PORT` (default 51657) and
`WEB_PORT` (default 51888) the ports. It takes about 15 seconds. Running it
again stops the old node and starts a fresh chain with the same accounts.

```sh
scripts/local-demo.sh status
scripts/local-demo.sh stop      # or: make demo-stop GNOROOT=...
```

## What you should see

Open http://127.0.0.1:51888/r/nym-kylix000/kylix.

- **Home** shows one ring ready to settle, offers 1, 2 and 3: ana gives
  100 OBOL and wants at least 50 DRACHMA, ben gives Kylix Relic `relic-2` and
  wants at least 100 OBOL, cleo gives 50 DRACHMA and wants `relic-2`. None of
  them trades with the person they pay.
- **Open offers** lists offers 1, 2, 3, 6 and 9, each asset with the realm it
  comes from (`100 OBOL (nym-kylix000/kylixdemo)`). Offer 6 (eli's `relic-4`
  for at least 200 OBOL) is waiting for a match: its page shows no closing
  ring.
- Offers 4 and 5 are gone: eli and ben posted a DRACHMA/OBOL swap and dora,
  who owns nothing in it, settled it.
- Offers 7 and 8 are gone too: a real MNS name sold through the adapter. ben
  registered `ben*gnoland` the way a user does (the registry's admin, the demo
  deployer as on the testnet, trusts MNS's logic realm, and ben paid
  `nslogic`), approved the adapter's address for that one name and listed it;
  dora offered exactly 120 OBOL for it; eli settled. The script checks that
  dora owns the name afterwards. The run is in `.local-demo/seed.log`, between
  `== MNS sale` and `== MNS sale settled` (on the last run: 36.6M gas, 4,286 B
  freed, 428,600 ugnot refunded to eli).
- Offer 9 is another MNS name, `cleo*gnoland`, for at least 150 OBOL, ready to
  swap: the adapter checked with the registry that the lease is valid and has
  at least 31 days left. To buy it, approve exactly 150 OBOL for your next
  offer's address, post an offer of 150 OBOL for item `cleo*gnoland` of
  `gno.land/r/nym-kylix000/adapters/nsnft`, and settle the two offers.
- The ring page for 1,2,3 draws the ring, checks that every owner can deliver,
  and prints a `gnokey` command with a gas limit sized to the ring (43M) and
  the minimum fee for it. The script prints the same command for dora's key;
  run it and the ring disappears from home, ana holds 50 more DRACHMA, ben 100
  more OBOL and cleo owns `relic-2`, and dora's balance goes up by about 0.74
  GNOT: the storage the ring frees is refunded to the settler.
- Collections lists Kylix Relics (official collection) and the two official
  adapters.

Kylix accepts an offer only if it could settle when it is posted, so the
script approves before it posts: a token approval of exactly the amount
offered, an item approval of that one item (an approval for all items is not
accepted). An offer that goes dead later is shown as not ready.

## Safety

- Every transaction is signed for chain id `dev` and sent to the script's own
  port, after checking that the node there reports `dev`.
- Keys live in `.local-demo/keys` (gitignored) with the password
  `local-demo-only`. They are throwaway keys for this chain only.
- The chain is in memory: stopping the node discards it.
- Logs: `.local-demo/gnodev.log` and `.local-demo/seed.log`.

# Testnet rehearsal

`testnet-rehearsal.sh` runs the same story on a live chain (onyx-1 by
default) with real keys, one step at a time. It only uses `gnokey maketx call`
and `maketx session` (`maketx run` is restricted on onyx-1), never a faucet.

```sh
NS=g1muqflv3dsrrzsneg0eaz5jl7jaxzus0s4nm4x8 scripts/testnet-rehearsal.sh status
NS=nym-kylix000 scripts/testnet-rehearsal.sh claim direct refusals
DRY=1 NS=nym-kylix000 scripts/testnet-rehearsal.sh mns    # simulate only
NS=nym-kylix000 scripts/testnet-rehearsal.sh all
```

Settings, by environment variable: `NS` (required), `RPC`
(`https://rpc.onyx.testnets.gno.land:443`), `CHAIN_ID` (`onyx-1`), `KEYS`
(`~/.config/kylix-keys/kb`), `PWFILE` (`~/.config/kylix-keys/password`, read
and piped to gnokey, never printed), `KEY_OWNER` (`kylix-deployer` for a
`nym-` namespace, otherwise `kylix-stage`), `KEY_SETTLER` (the owner key),
`KEY_ANA`, `KEY_BEN`, `KEY_CLEO`, `KEY_SESSION` (`kylix-session`, created in
`KEYS` if missing, with no backup shown). `GAS` and `DEP` set the gas limit
and deposit cap of ordinary calls (40M, 1.5 GNOT); the fee is always the
minimum, gas / 1,000 ugnot. `MNS_LABEL`, `GS_IN1`, `GS_IN2`, `GS_OBOL`,
`GS_SLIP_BPS` tune the MNS and GnoSwap steps.

Every step prints one line per transaction (gas used, storage delta, deposit
or refund, total cost) and a PASS or FAIL line for each check with the
on-chain values it compared; the full gnokey and solver output is kept in
`.testnet-rehearsal/<chain>-<namespace>/` (gitignored). The script refuses to
sign unless the node reports `CHAIN_ID`. Calls that must fail are simulated
(free); `REAL_FAIL=1` sends them so a block records the refusal. `DRY=1`
simulates every transaction instead of sending it: a step stops at the first
call that needs an earlier one on chain (a post needs its approval), so DRY
shows the cost of the first calls and every check that reads only.

| Step | What it does and checks |
|---|---|
| `status` | `vm/qpkgmeta_json` of the five packages (live, or parked awaiting the approver) and the keys' balances. |
| `claim` | ana, ben and cleo `Claim` from `kylixdemo` (1,000 OBOL, 1,000 DRACHMA, a relic; one claim an hour). A claim on cooldown passes if the account already holds enough. |
| `direct` | The README ring: 100 OBOL for at least 50 DRACHMA, a relic for at least 100 OBOL, 50 DRACHMA for the relic. Each owner approves exactly what the offer gives, then posts. The settle command comes from the solver (`--print-simulate`), on the whole book or, if another ring took one of these offers, on these offers only; it is simulated, then sent by `KEY_SETTLER`. Checks every balance and the relic's owner, that the offers are closed and the approvals used up, and that the settler's balance moved by exactly minus TOTAL TX COST and ended ahead (the storage refund covers the fee). |
| `refusals` | A ring that does not close, cancel by a non-owner, re-settling the settled ring, posting without approving the new slot, and posting a relic approved only with `ApproveAllRelics`: each must be refused with the expected reason. Then cancels its two offers and checks nothing moved. |
| `mns` | ben registers `MNS_LABEL*gnoland` with `nslogic/v2.RegisterName`, paying `NamePrice` (7,246,377 ugnot on onyx-1 for 4 or more characters; the lease is 365 days, above the adapter's 31-day minimum), approves the adapter's address for that name, and sells it to cleo for 120 OBOL in a ring of two. Checks the new owner, the OBOL, and that the approval was cleared. |
| `gnoswap` | ana wraps GNOT into wugnot, and in two rings of two gives wugnot for at least 10 OBOL while ben gives 10 OBOL for at least N GNS; Kylix swaps ana's wugnot on GnoSwap's wugnot/GNS 0.3% pool. Ring 1 calls `SettleRing` (automatic pool), ring 2 the solver's `SettleRingVia` with the fee tier. N is the router's `DrySwapRoute` quote less 3%. |
| `sinopia` | Sells a Sinopia3 artwork through the adapter if one of the keys holds an accepted one (Final collection, genesis or reviewed non-living engine); otherwise says why it cannot and skips. |
| `notify` | `EnableNotifications` from ana must be refused by gnotif (not authorized for the namespace), then from `KEY_OWNER` must register a trigger (`gnotif/v1.Active`). It costs about 1.6 GNOT of deposit (16.2 KB). Then a ring of two settles, the transaction must carry two `OfferSettled` events, and it prints where to see the trigger and how to fetch the events from the indexer. |
| `session` | ana creates a session key limited to the Kylix and kylixdemo realms (24 hours, 2 GNOT spend limit). The session approves, posts (the offer is ana's, marked as posted through a session) and settles a ring, and is refused when it cancels; ana's own key then cancels. |

Run against the local demo chain (all but `gnoswap`, `sinopia` and the
non-owner half of `notify`, which need onyx-1's GnoSwap pool, Sinopia3 art and
`r/sys/names`):

```sh
make demo GNOROOT=...
printf local-demo-only > /tmp/pw
NS=nym-kylix000 RPC=127.0.0.1:51657 CHAIN_ID=dev KEYS=$PWD/.local-demo/keys \
  PWFILE=/tmp/pw KEY_OWNER=deployer KEY_SETTLER=dora scripts/testnet-rehearsal.sh all
```
