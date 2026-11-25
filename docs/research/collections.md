# Existing collections in Kylix: adapter research

## Verdict

Kylix can support 18 existing onyx-1 realms at launch through small adapter realms, with no change to those realms and with per-offer isolation intact. Five are proven by `gno test` against their unmodified chain source (GnoSwap GNFT, Sinopia3, MNS nsnft v2, Samcrew Launchpad open-mode collections, GnoBuilders quest badges), and thirteen more run the same code or API, judged by reading only. Demo **GnoSwap positions, Sinopia3 art and MNS names**: all three have live items on onyx-1 (5 positions, two Final art collections, 8 names) and cover DeFi, art and identity.

No collection needed a weaker approval. 33 of the 59 realms that import GRC721 cannot be adapted at all: they accept transfers only from a wallet, only from the owner, or not at all.

## Survey

Caller column: how the collection identifies the spender. Counts are realms; "tested" means a passing `gno test` in the lab.

| Group | Realms | Caller | Restrictions | Class |
|---|---|---|---|---|
| Standard ledger, `Approve(to, tid)` + `TransferFrom(from, to, tid)`: `gnoswap/gnft` (tested), `nsnft/v1`, `v2` (tested), `nsskin/v1`, `v2` | 5 | `cur.Previous()` | GNFT: staked positions only movable by staker. nsnft: registry holds block moves and withdraw approvals (tested) | a |
| Multi-collection core `(cid, tid)`: `sinopia3/core` (tested), `sinopia2`, three other `sinopia/core`, `minhwa`, `minhwa2` | 7 | `cur.Previous()` | Lock hook vetoes every move until the collection is Final (tested); admin pause never covers owner actions | a |
| `samcrew/launchpad/nft/v1` `(id, number)` | 1 | `cur.Previous()` | open mode works (tested); royalty_protected only via listed market realm, soulbound never (both tested) | a / c |
| Hand-rolled ledgers: `gnobuilders_badges_v2` ×2 (tested), `x/daily/erc721` ×3 | 5 | `unsafe.PreviousRealm()` | Rank badges soulbound (tested); owner key pauses all transfers (tested); samcrew copy has 0 badges minted | a |
| EOA-only: fish family ×6, bazaar gens ×4, `a0cdt…/market`, `shop` | 12 | `IsUserCall()` required | Every transfer and approve refuses a realm caller | c |
| Owner-only: `tavern_v1/guardians`, `tavern_stamps` (caller must equal `from`), `patusfenix` v5–v8 + `patusworld404onyx` (no Approve exposed), `patusfenix` v1–v4 (no transfer) | 11 | `cur.Previous()` | No delegate can ever be approved | c |
| `gnoradio/tickets/nft` | 1 | writer realm + `OriginCaller` | Only the ticket realm, in the holder's own transaction | c |
| `garden` v1–v9 | 9 | `cur.Previous()` | Soulbound, or movable only through the garden's own market | c |
| Not collections: GnoSwap position/staker, 7 Sinopia/Minhwa markets, 2 spikes | 12 | n/a | Hold or trade items of other realms | n/a |
| Non-GRC721 items: `erc1155`, `handles`, `passport`, `tickets/v1`, `v2`, `trickle`, `edcol`, ~24 game-coin realms | ~35 | caller is owner | `Transfer(to, …)` by the holder only, no approve | c |

Totals for the 59 GRC721 importers: (a) 13 (launchpad for open mode only), (b) 0, (c) 33, not collections 12, and `nsnft/v3`. Three importers in the source index are absent from onyx-1 (`fishtry`, `bazaar/c/onyx1`, `nsnft/v3`; the RPC answered "package not found" for v3).

## The adapter pattern

Kylix crosses into `Move` as slot `w/<owner>/<nonce>`. The adapter crosses into the collection as its own sub-identity `k/<slot address>`. Only that one slot can ever produce that identity, so an approval to it is spendable by one offer. This is the tested `adapters/gnft/adapter.gno` with the mock import swapped for the real Kylix path:

```go
package gnftadapter

import (
	"chain"

	"gno.land/p/nt/grc721/v0"
	"gno.land/r/gnoswap/gnft"
	kylix "gno.land/r/nym-kylix000/kylix"
)

var selfPath string

func init(cur realm) {
	selfPath = cur.PkgPath()
	kylix.RegisterItem(cross(cur), "GnoSwap Positions (GNFT)", Move, OwnerOf)
}

// SpenderFor is the address the owner approves for the offer whose Kylix slot is kylixSlot.
func SpenderFor(kylixSlot address) address {
	return chain.DerivePkgSubAddr(selfPath, "k/"+string(kylixSlot))
}

func Move(cur realm, from, to address, itemID string) error {
	sub := cur.Sub("k/" + string(cur.Previous().Address()))
	return gnft.TransferFrom(cross(sub), from, to, grc721.TokenID(itemID))
}

func OwnerOf(itemID string) address {
	owner, err := gnft.OwnerOf(grc721.TokenID(itemID))
	if err != nil {
		return ""
	}
	return owner
}
```

Other collections change only the one call in `Move` (item IDs in quotes):

```go
core.TransferFrom(cross(sub), cid, tid, from, to)   // sinopia family, "cid/tid"
nsnft.TransferFrom(cross(sub), from, to, itemID)     // MNS, "name"
nft.TransferFrom(cross(sub), id, from, to, number)   // launchpad, "C1/7"
badges.TransferFrom(cross(sub), from, to, itemID)    // badges, "g1…:quest"
```

The owner's approve step, before or with `PostIntent`:

1. `(nonce, slot) = kylix.NextSlot(owner)`.
2. `spender = adapter.SpenderFor(slot)`. Anyone can also compute it as `DerivePkgSubAddr(adapterPath, "k/"+slot)`.
3. Approve that one token in the collection's own realm: `gnft.Approve(spender, "12")`, `core.Approve("1", "3", spender)`, `nsnft.Approve(spender, "alice")`, `nft.Approve("C1", spender, 7)`.
4. `PostIntent` with `giveKey` set to the adapter path and `giveID` set to the adapter's item ID.

**Generic or per-collection?** You need one adapter per target realm. A family adapter that statically imports each member is the one exception. There is no realm-level GRC721 interface: `p/nt/grc721/v0` is a library, and the five tested realms expose five different signatures. Gno cannot call a realm chosen at runtime. The one standard handle, `*grc721.Token.RealmTeller`, is published only by the Sinopia family. It would also skip the collection's own wrapper rules, such as launchpad's mode check. There is no `grc721reg` on onyx-1.

## Fungible side

The `grc20reg` registry on onyx-1 holds 23 tokens: wugnot, GNS, grc20factory GSAI, faucet BLUE/RED and pairs AAA/BBB (two deployers each), THREAD, and Launchpad T1–T10. Notable tokens that are not registered: mUSD (`g12dcs…/musd`), xGNS, the fish/shoal tokens and `drop`. A `TransferFrom`-based adapter like the one above would reach them.

`grc20reg.TransferFrom(0, sub, key, owner, to, amount)` from a sub-address works against the real wugnot code. A wrong nonce and one unit over the allowance both fail, and the exact amount leaves the allowance at 0. There are three catches:

- The approve step is each token realm's own function, and the signatures differ: Launchpad tokens and the faucets take an `id`/`symbol` first.
- `grc20reg` writes the ledger directly and skips rules that a token realm keeps only in its wrappers. The wugnot, GNS and Launchpad wrappers add none. I did not read the others.
- An allowance on a cancelled offer is dead, because nonces are never reused. The UI should still offer "approve 0".

## What ran

```
cd S/kylix-lab/adapters && GNOROOT=S/gno-v180 gno test -v ./gno.land/r/kylix/adaptertest
--- PASS: TestBadges1Setup / TestBadges2Settle / TestGnft1Setup / TestGnft2Settle
--- PASS: TestLaunchpad1Setup / TestLaunchpad2Settle / TestNsnft1Setup / TestNsnft2Settle
--- PASS: TestSinopia1Setup / TestSinopia2Settle / TestZProbeSubIdentityViews
--- PASS: z_wugnot_filetest.gno
ok  ./gno.land/r/kylix/adaptertest  2.4s
```

Each `*2Settle` runs the same battery through a mock Kylix:

- settling with another item, another nonce or another owner's slot aborts;
- the test realm and a hostile realm calling `Move` directly both abort;
- a hostile realm that mints its own `w/<owner>/1` sub-identity aborts;
- the real slot moves the item, and replaying the move aborts.

Sinopia3 is driven through a full lifecycle to Final with the real genesis engine. A mutation check (adapter using a shared `k/shared` path) makes the battery fail, so the test is not vacuous.

Copied sources are byte-identical to chain source, with one exception: a marked test-only line in badges sets its owner, because `gno test` loads imported realms with an empty origin caller. Onyx-1's `grc721/v0` and `grc20reg` files are byte-identical to the v1.8.0 tag (fetched by `vm/qfile`).

## Unverified

- Nothing ran on chain.
- After `testing.SetRealm`, `unsafe.PreviousRealm()` hides sub-identities under `gno test` (`TestZProbe…`), so settlement checks run in tests without `SetRealm`. On-chain parity for badges and `x/daily/erc721` rests on the spec and on the probe without `SetRealm`.
- The 13 "same code" realms and the survey come from reading transfer paths, not audits.
- Not checked: bundling approve and post in one `MsgRun`; whether GnoSwap position logic tolerates a GNFT moved by a third party; which nsnft v2 names are unlocked (free-tier names are minted held).
- `revive` does not roll back state in tests. On chain a vetoed move aborts the whole transaction.
