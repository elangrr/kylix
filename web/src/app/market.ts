// The market as the pages show it: the open book, the rings ready to settle
// in it, and each ring's picture from the realm. Read through one shared
// KylixClient, so every read goes through the same cache, de-duplication and
// 429 backoff.

import { KylixClient } from '../lib/kylix.ts'
import { GnoSwapQuoter } from '../lib/gnoswap.ts'
import type { DeliverableStatus, Graph, Offer } from '../lib/kylix.ts'
import type { Ring } from '../lib/rings.ts'

let shared: KylixClient | undefined

/** The page's one chain client. */
export function chain(): KylixClient {
  shared ??= new KylixClient()
  return shared
}

export interface RingView {
  /** "4,5,6" */
  key: string
  ids: number[]
  /** The ring's offers in ring order: offers[i] gives to the owner of offers[i + 1]. */
  offers: Offer[]
  /** The realm's drawing of the ring (data:image/svg+xml;base64,...), null if it showed none, undefined if not read. */
  picture?: string | null
  /** For a ring with a GnoSwap hop: which hop, the pool's fee tier, and the quoted amount out. */
  bridge?: { hop: number; feeTier: number; expectedOut: bigint }
}

export interface Market {
  graph: Graph
  rings: RingView[]
  /** Deliverable status of every offer in a found ring. */
  status: Map<number, DeliverableStatus>
  /** The GnoSwap quote limit stopped a quote, so rings with a swap may be missing. */
  quotesCut: boolean
  /** Too many offers to check in one refresh, so some rings were not checked. */
  checksCut: boolean
}

/** Ring ids to their offers, in ring order. Rings with an offer missing from the book are dropped. */
export function ringViews(rings: Ring[], offers: Offer[]): RingView[] {
  const byId = new Map(offers.map((o) => [o.id, o]))
  const out: RingView[] = []
  for (const r of rings) {
    const legs = r.ids.map((id) => byId.get(id))
    if (legs.some((o) => !o)) continue
    const b = r.bridge
    const bridge = b && r.bridgedHop !== undefined ? { hop: r.bridgedHop, feeTier: b.fee, expectedOut: b.expectedOut } : undefined
    out.push({ key: r.ids.join(','), ids: [...r.ids], offers: legs as Offer[], ...(bridge ? { bridge } : {}) })
  }
  return out
}

// The realm draws each ring on its ring page. Read at most this many per
// refresh, to stay well inside the RPC's rate limit.
const MAX_PICTURES = 8

/**
 * A fresh quoter per refresh, so quotes follow the pools; pool lookups stay
 * in the client's cache. `fresh` skips the cached DrySwapRoute answers, for
 * a quote taken right before signing.
 */
export function quoter(client: KylixClient = chain(), opts: { fresh?: boolean } = {}): GnoSwapQuoter {
  return new GnoSwapQuoter(client.rpc, { maxQuotes: 16, maxPairs: 8, ...(opts.fresh ? { quoteCacheMs: 0 } : {}) })
}

/** The book, the rings ready to settle now (one GnoSwap hop allowed), and their pictures. */
export async function loadMarket(client: KylixClient = chain()): Promise<Market> {
  const q = quoter(client)
  const { graph, rings, status, checksCut } = await client.readyRings(undefined, { quote: q.quote })
  const views = ringViews(rings, graph.offers)
  await Promise.all(
    views.slice(0, MAX_PICTURES).map(async (v) => {
      try {
        v.picture = await client.ringPicture(v.ids)
      } catch {
        v.picture = null
      }
    }),
  )
  return { graph, rings: views, status, quotesCut: q.truncated, checksCut }
}

/** True for a data URI the realm's ring page produces, and nothing else. */
export function safePicture(uri: string | null | undefined): string | null {
  return uri && /^data:image\/svg\+xml;base64,[A-Za-z0-9+/]+={0,2}$/.test(uri) ? uri : null
}
