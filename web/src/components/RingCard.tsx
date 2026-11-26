import type { ReactNode } from 'react'
import type { Collection } from '../lib/kylix.ts'
import { shortAddress, tokenAmountText } from '../app/assets.ts'
import { safePicture, type RingView } from '../app/market.ts'
import { AssetLabel } from './AssetLabel.tsx'
import { RingGlyph } from './RingGlyph.tsx'

interface RingCardProps {
  ring: RingView
  collections?: Collection[]
  /** The connected account, marked as "you". */
  me?: string
  /** Buttons and links under the legs. */
  children?: ReactNode
}

function Who({ address, me }: { address: string; me?: string }) {
  if (address === me) return <strong>You</strong>
  return (
    <strong className="mono" title={address}>
      {shortAddress(address)}
    </strong>
  )
}

export function RingCard({ ring, collections, me, children }: RingCardProps) {
  const n = ring.offers.length
  const picture = safePicture(ring.picture)
  const titleId = `ring-${ring.key.replace(/,/g, '-')}-title`
  const swapHop = ring.bridge?.hop ?? -1
  return (
    <article className="ring-card" aria-labelledby={titleId}>
      <div className="ring-card-head">
        {!picture && <RingGlyph id={ring.key} labels={ring.ids.map(String)} swapHop={swapHop} />}
        <div>
          <h3 id={titleId}>Ring of {n}</h3>
          <p className="ring-card-meta">
            <span className="tag">Offers {ring.ids.join(', ')}</span>
            {ring.bridge && <span className="tag tag-swap">1 swap via GnoSwap</span>}
          </p>
        </div>
      </div>
      {picture && (
        <img
          className="ring-picture"
          src={picture}
          width={680}
          height={440}
          alt={`The realm’s drawing of the ring of offers ${ring.ids.join(', ')}.`}
        />
      )}
      <ol className="ring-legs">
        {ring.offers.map((o, i) => {
          const next = ring.offers[(i + 1) % n] ?? o
          const swapped = i === swapHop
          return (
            <li key={o.id}>
              <Who address={o.owner} me={me} /> {o.owner === me ? 'give' : 'gives'} <AssetLabel asset={o.give} collections={collections} /> to{' '}
              <Who address={next.owner} me={me} />
              {swapped && ring.bridge && (
                <span className="leg-note">
                  {' '}
                  (swapped on GnoSwap on the way, quoted at {tokenAmountText(next.want.key, ring.bridge.expectedOut)})
                </span>
              )}
              <span className="leg-want">
                Offer {o.id} wants at least <AssetLabel asset={o.want} collections={collections} />
              </span>
            </li>
          )
        })}
      </ol>
      {children}
    </article>
  )
}
