// Building each transaction the app sends, from fresh reads of the chain.
// Nothing here signs: the result goes to the wallet.

import { GNOWEB_URL, PATHS } from '../lib/config.ts'
import type { Asset, DeliverableStatus, KylixClient, Offer } from '../lib/kylix.ts'
import { buildApproveAndPost, buildCancel, buildClaim, buildSettle } from '../lib/tx.ts'
import type { TxPlan } from '../lib/tx.ts'
import type { Quote } from '../lib/rings.ts'
import { tokenAmountText } from './assets.ts'

/** The reads these builders need; a fake can stand in for tests. */
export type ChainReads = Pick<
  KylixClient,
  'approveRoute' | 'nextSlot' | 'approveTarget' | 'deliverable' | 'faucetStatus' | 'mnsName' | 'tokenBalance'
>

export interface PostRequest {
  caller: string
  give: Asset
  want: Asset
  expiry: number
}

/**
 * Approve and post in one transaction. Reads the offer's next address and,
 * for an item, the address its collection wants approved, right before
 * signing, so they match what PostIntent will check. For a token, checks
 * that grc20reg knows it and that the caller holds the amount, so a post the
 * realm would refuse stops before the wallet opens.
 */
export async function preparePost(chain: ChainReads, r: PostRequest): Promise<TxPlan> {
  const route = await chain.approveRoute(r.give)
  if (!route) {
    throw new Error(
      r.give.kind === 'item'
        ? 'This app cannot approve items of this collection. Approve it on the collection’s own page, then post on the realm’s page.'
        : 'This token has no Approve(spender, amount) function this app knows how to call.',
    )
  }
  if (r.give.kind === 'fungible') {
    const bal = await chain.tokenBalance(r.give.key, r.caller)
    if (bal === null) throw new Error(`No token is registered in grc20reg under ${r.give.key}.`)
    if (bal < r.give.amount) {
      throw new Error(`You hold ${tokenAmountText(r.give.key, bal)}, less than the ${tokenAmountText(r.give.key, r.give.amount)} this offer gives.`)
    }
  }
  if (r.give.kind === 'item' && r.give.key === PATHS.adapterMns) {
    const n = await chain.mnsName(r.give.id)
    if (n.owner !== r.caller) throw new Error(`You do not hold the MNS name ${r.give.id}.`)
    if (n.unmovable) throw new Error(`Kylix cannot move ${r.give.id} now: ${n.unmovable}.`)
  }
  const { nonce, slot } = await chain.nextSlot(r.caller)
  const approveTarget = r.give.kind === 'item' ? await chain.approveTarget(r.caller, nonce, r.give.key) : slot
  return buildApproveAndPost({
    caller: r.caller,
    give: r.give,
    want: r.want,
    nonce,
    slot,
    approveTarget,
    route,
    expiry: r.expiry,
  })
}

/**
 * SettleRing for offers in ring order. Asks Deliverable first, so a ring that
 * stopped being ready since the book was read fails here with the realm's
 * reason, before the wallet opens. For a ring with a GnoSwap hop, quotes the
 * swap again and settles through the pool that pays most now
 * (SettleRingVia); the realm still refuses a swap below the minimum. Pass a
 * quote that skips the cache (quoter(client, { fresh: true }).quote).
 */
export async function prepareSettle(
  chain: ChainReads,
  caller: string,
  offers: Offer[],
  bridge?: { hop: number; feeTier: number },
  quote?: Quote,
): Promise<TxPlan> {
  // Asked fresh: a cached answer from the last poll could hide a change.
  const status = await chain.deliverable(
    offers.map((o) => o.id),
    { cacheMs: 0 },
  )
  const stuck = offers
    .map((o) => status.get(o.id) ?? ({ id: o.id, deliverable: false, reason: 'no answer' } as DeliverableStatus))
    .filter((s) => !s.deliverable)
  if (stuck.length > 0) {
    throw new Error(`This ring can no longer settle. ${stuck.map((s) => `Offer ${s.id}: ${s.reason || 'not ready'}.`).join(' ')}`)
  }
  if (bridge && quote) {
    const from = offers[bridge.hop]
    const to = offers[(bridge.hop + 1) % offers.length]
    if (!from || !to) throw new Error('The swapped hop is not in this ring.')
    const q = await quote(from.give.key, to.want.key, from.give.amount)
    if (!q) throw new Error('GnoSwap has no pool that can make this swap now.')
    if (q.out < to.want.amount) {
      throw new Error(
        `GnoSwap now pays ${tokenAmountText(to.want.key, q.out)} for this hop, less than offer ${to.id}’s minimum of ${tokenAmountText(to.want.key, to.want.amount)}.`,
      )
    }
    bridge = { hop: bridge.hop, feeTier: q.fee }
  }
  return buildSettle({ caller, offers, ...(bridge ? { bridge } : {}) })
}

export async function prepareClaim(chain: ChainReads, caller: string): Promise<TxPlan> {
  const f = await chain.faucetStatus(caller)
  if (!f.canClaimNow) {
    throw new Error(`You can claim again at block ${f.nextClaimHeight.toLocaleString('en-US')}.`)
  }
  return buildClaim(caller)
}

export function prepareCancel(caller: string, id: number): TxPlan {
  return buildCancel(caller, id)
}

// --- Links to the testnet's web view ------------------------------------------

function webPath(pkgPath: string): string {
  return `${GNOWEB_URL}/${pkgPath.replace(/^gno\.land\//, '')}`
}

export const links = {
  realm: () => webPath(PATHS.kylix),
  faucet: () => webPath(PATHS.kylixdemo),
  offer: (id: number) => `${webPath(PATHS.kylix)}:offer/${id}`,
  ring: (ids: number[]) => `${webPath(PATHS.kylix)}:ring/${ids.join(',')}`,
}
