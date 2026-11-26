import { useEffect, useState } from 'react'
import type { Collection, DeliverableStatus, Offer } from '../lib/kylix.ts'
import { AssetLabel } from '../components/AssetLabel.tsx'
import { blocksToText, displayText, shortAddress } from '../app/assets.ts'
import { links, prepareCancel } from '../app/actions.ts'
import type { Loaded, TxRunner } from '../app/hooks.ts'
import { errorText } from '../app/txState.ts'
import { chain, type Market } from '../app/market.ts'

interface Props {
  market: Loaded<Market>
  address: string | undefined
  tx: TxRunner
}

function OfferDetails({ offer, height, rings }: { offer: Offer; height: number; rings: string[] }) {
  const [status, setStatus] = useState<{ s?: DeliverableStatus; error?: string }>({})
  useEffect(() => {
    let live = true
    chain()
      .deliverable([offer.id])
      .then(
        (m) => live && setStatus({ s: m.get(offer.id) }),
        (e: unknown) => live && setStatus({ error: errorText(e) }),
      )
    return () => {
      live = false
    }
  }, [offer.id])
  return (
    <div className="offer-details">
      <p aria-live="polite">
        {status.error
          ? `Could not ask the realm: ${status.error}`
          : !status.s
            ? 'Asking the realm whether this offer can be delivered now…'
            : status.s.deliverable
              ? 'Ready: the owner holds what the offer gives and has approved it.'
              : `Not ready: ${displayText(status.s.reason) || 'the realm gave no reason'}.`}
      </p>
      <dl>
        <div>
          <dt>Owner</dt>
          <dd className="mono address">{displayText(offer.owner)}</dd>
        </div>
        {offer.slot && (
          <div>
            <dt>Offer address</dt>
            <dd className="mono address">{displayText(offer.slot)}</dd>
          </div>
        )}
        {offer.approve && offer.approve !== offer.slot && (
          <div>
            <dt>Approved address</dt>
            <dd className="mono address">{displayText(offer.approve)}</dd>
          </div>
        )}
        <div>
          <dt>Expires</dt>
          <dd>
            At block {offer.expiry.toLocaleString('en-US')}, in {blocksToText(offer.expiry - height)}
          </dd>
        </div>
        {offer.viaSession && (
          <div>
            <dt>Posted</dt>
            <dd>With a session key</dd>
          </div>
        )}
        <div>
          <dt>Ready rings with it</dt>
          <dd>{rings.length ? rings.join('; ') : 'none right now'}</dd>
        </div>
      </dl>
      <a className="text-link" href={links.offer(offer.id)}>
        Offer page on the testnet
      </a>
    </div>
  )
}

function OfferRow({
  offer,
  mine,
  height,
  collections,
  rings,
  tx,
  address,
}: {
  offer: Offer
  mine: boolean
  height: number
  collections: Collection[]
  rings: string[]
  tx: TxRunner
  address: string | undefined
}) {
  const [open, setOpen] = useState(false)
  const detailsId = `offer-${offer.id}-details`
  const cancel = () => {
    if (!address) return
    tx.run({ label: `Cancel offer ${offer.id}`, link: { href: links.offer(offer.id), text: 'The offer’s page on the testnet' } }, () =>
      prepareCancel(address, offer.id),
    )
  }
  return (
    <li className={`offer ${mine ? 'offer-mine' : ''}`}>
      <div className="offer-head">
        <h3 className="offer-title">
          Offer {offer.id}
          {mine && <span className="tag">yours</span>}
        </h3>
        <span className="offer-owner">
          by{' '}
          {mine ? (
            'you'
          ) : (
            <span className="mono" title={displayText(offer.owner)}>
              {shortAddress(offer.owner)}
            </span>
          )}
          , expires in {blocksToText(offer.expiry - height)}
        </span>
      </div>
      <p className="offer-sides">
        <span>
          Gives <AssetLabel asset={offer.give} collections={collections} />
        </span>
        <span>
          Wants at least <AssetLabel asset={offer.want} collections={collections} />
        </span>
      </p>
      <div className="offer-actions">
        <button type="button" className="btn btn-quiet" aria-expanded={open} aria-controls={detailsId} onClick={() => setOpen((o) => !o)}>
          {open ? 'Hide details' : 'Details'}
          <span className="visually-hidden"> of offer {offer.id}</span>
        </button>
        {mine && (
          <button type="button" className="btn btn-quiet btn-danger" disabled={tx.busy} onClick={cancel}>
            Cancel<span className="visually-hidden"> offer {offer.id}</span>
          </button>
        )}
      </div>
      <div id={detailsId} hidden={!open}>
        {open && <OfferDetails offer={offer} height={height} rings={rings} />}
      </div>
    </li>
  )
}

export function OfferBook({ market, address, tx }: Props) {
  const [onlyMine, setOnlyMine] = useState(false)
  const m = market.data
  const offers = m?.graph.offers ?? []
  const mineCount = address ? offers.filter((o) => o.owner === address).length : 0
  const shown = onlyMine && address ? offers.filter((o) => o.owner === address) : offers
  const sorted = [...shown].sort((a, b) => b.id - a.id)
  return (
    <section className="panel" aria-labelledby="book-title" aria-busy={market.loading && !m}>
      <h2 id="book-title" className="panel-title">Open offers</h2>
      {m && (
        <p className="panel-note">
          {offers.length} open {offers.length === 1 ? 'offer' : 'offers'} at block {m.graph.height.toLocaleString('en-US')}.
        </p>
      )}
      {address && (
        <div className="choice" role="radiogroup" aria-label="Which offers to show">
          <label>
            <input type="radio" name="book-filter" checked={!onlyMine} onChange={() => setOnlyMine(false)} /> All ({offers.length})
          </label>
          <label>
            <input type="radio" name="book-filter" checked={onlyMine} onChange={() => setOnlyMine(true)} /> Mine ({mineCount})
          </label>
        </div>
      )}
      {!m && !market.error && <p>Reading the book…</p>}
      {market.error && <p className="form-error">Could not read the book: {market.error}</p>}
      {m && sorted.length === 0 && <p>{onlyMine ? 'You have no open offers.' : 'The book is empty.'}</p>}
      {m && sorted.length > 0 && (
        <ul className="offer-list">
          {sorted.map((o) => (
            <OfferRow
              key={o.id}
              offer={o}
              mine={!!address && o.owner === address}
              height={m.graph.height}
              collections={m.graph.collections}
              rings={m.rings.filter((r) => r.ids.includes(o.id)).map((r) => r.ids.join(', '))}
              tx={tx}
              address={address}
            />
          ))}
        </ul>
      )}
    </section>
  )
}
