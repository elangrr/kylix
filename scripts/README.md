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
