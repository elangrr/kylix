import { RingCard } from '../components/RingCard.tsx'
import { links, prepareSettle } from '../app/actions.ts'
import type { Loaded, TxRunner } from '../app/hooks.ts'
import { chain, quoter, type Market, type RingView } from '../app/market.ts'

interface Props {
  market: Loaded<Market>
  address: string | undefined
  tx: TxRunner
}

export function ReadyRings({ market, address, tx }: Props) {
  const m = market.data
  const settle = (ring: RingView) => {
    if (!address) return
    tx.run(
      { label: `Settle ring ${ring.ids.join(', ')}`, link: { href: links.ring(ring.ids), text: 'The ring’s page on the testnet' } },
      () =>
        prepareSettle(
          chain(),
          address,
          ring.offers,
          ring.bridge ? { hop: ring.bridge.hop, feeTier: ring.bridge.feeTier } : undefined,
          ring.bridge ? quoter(chain(), { fresh: true }).quote : undefined,
        ),
    )
  }
  return (
    <section className="panel panel-clay" aria-labelledby="rings-title" aria-busy={market.loading && !m}>
      <h2 id="rings-title" className="panel-title">Rings ready to settle</h2>
      <p className="panel-note">
        Found in your browser from the open book, and checked against the realm: every owner still holds what they offer
        and has approved it. Anyone can settle a ring. Whoever does gets back the storage deposits it frees.
      </p>
      {!m && !market.error && <p>Reading the book…</p>}
      {market.error && <p className="form-error">Could not read the book: {market.error}</p>}
      {m && m.rings.length === 0 && <p>No ring is ready right now.</p>}
      {m && (m.quotesCut || m.checksCut) && (
        <p className="panel-note">
          {[
            m.checksCut && 'The book has more possible rings than this page checks with the realm in one read, so some ready rings may be missing here.',
            m.quotesCut && 'This read used up its GnoSwap quotes, so some rings with a swap may be missing here.',
          ]
            .filter(Boolean)
            .join(' ')}
        </p>
      )}
      {m && m.rings.length > 0 && (
        <div className="ring-grid ring-grid-app">
          {m.rings.map((ring) => (
            <RingCard key={ring.key} ring={ring} collections={m.graph.collections} me={address}>
              <div className="ring-actions">
                <button type="button" className="btn" disabled={!address || tx.busy} onClick={() => settle(ring)}>
                  Settle this ring
                </button>
                <a className="text-link" href={links.ring(ring.ids)}>
                  Ring page on the testnet
                </a>
              </div>
              {!address && <p className="panel-note">Connect a wallet to settle.</p>}
            </RingCard>
          ))}
        </div>
      )}
    </section>
  )
}
