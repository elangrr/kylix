import { FAUCET } from '../lib/config.ts'
import type { AccountData } from '../app/account.ts'
import { KNOWN_TOKENS, blocksToText, formatUnits } from '../app/assets.ts'
import { links, prepareClaim } from '../app/actions.ts'
import type { Loaded, TxRunner } from '../app/hooks.ts'
import { chain } from '../app/market.ts'

interface Props {
  address: string
  account: Loaded<AccountData>
  tx: TxRunner
}

export function AccountPanel({ address, account, tx }: Props) {
  const a = account.data
  const f = a?.faucet
  const wait = f && !f.canClaimNow ? f.nextClaimHeight - f.height : 0
  const claim = () =>
    tx.run({ label: 'Claim demo assets', link: { href: links.faucet(), text: 'The demo faucet on the testnet' } }, () =>
      prepareClaim(chain(), address),
    )
  return (
    <section className="panel" aria-labelledby="balances-title" aria-busy={account.loading && !a}>
      <h2 id="balances-title" className="panel-title">Your balances</h2>
      {!a && !account.error && <p>Reading your balances…</p>}
      {account.error && <p className="form-error">Could not read your balances: {account.error}</p>}
      {a && (
        <>
          <dl className="balances">
            <div>
              <dt>GNOT</dt>
              <dd>{formatUnits(a.gnot, 6)}</dd>
            </div>
            {KNOWN_TOKENS.map((t) => {
              const bal = a.tokens.get(t.key)
              return (
                <div key={t.key}>
                  <dt>
                    {t.symbol} <span className="asset-note">({t.note})</span>
                  </dt>
                  <dd>{bal == null ? 'not registered' : formatUnits(bal, t.decimals)}</dd>
                </div>
              )
            })}
            <div>
              <dt>
                Relics <span className="asset-note">(Kylix Relics, demo relics)</span>
              </dt>
              <dd>{a.items.length === 0 ? 'none' : a.items.map((i) => i.id).join(', ')}</dd>
            </div>
          </dl>
          <h3 className="panel-subtitle">Demo assets</h3>
          <p className="panel-note">
            The demo faucet gives {FAUCET.claimTokens.toLocaleString('en-US')} OBOL, {FAUCET.claimTokens.toLocaleString('en-US')} DRACHMA
            and one relic, once every {FAUCET.cooldownBlocks} blocks (about an hour). Fees are paid in GNOT.
          </p>
          {f?.canClaimNow ? (
            <button type="button" className="btn" onClick={claim} disabled={tx.busy}>
              Claim demo assets
            </button>
          ) : (
            <p className="panel-note">
              You can claim again at block {f?.nextClaimHeight.toLocaleString('en-US')}, in {blocksToText(wait)}.
            </p>
          )}
        </>
      )}
    </section>
  )
}
