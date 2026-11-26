import { CHAIN_ID } from '../lib/config.ts'
import type { WalletControls } from '../app/hooks.ts'
import { displayText } from '../app/assets.ts'

export function WalletPanel({ w }: { w: WalletControls }) {
  const v = w.view
  return (
    <section className="panel wallet-panel" aria-labelledby="wallet-title">
      <h2 id="wallet-title" className="panel-title">Wallet</h2>
      {v.status === 'checking' && <p>Looking for a wallet in this browser…</p>}
      {v.status === 'not-installed' && (
        <>
          <p>
            Adena is not installed in this browser. You can still read the book and the rings below. To post, settle or
            cancel, install Adena from <a href="https://adena.app">adena.app</a>, then reload this page.
          </p>
        </>
      )}
      {(v.status === 'disconnected' || v.status === 'connecting') && (
        <>
          <p>Connect Adena to see your balances, post offers, settle rings and cancel your offers.</p>
          <button type="button" className="btn" onClick={w.connect} disabled={v.status === 'connecting'}>
            {v.status === 'connecting' ? 'Waiting for Adena…' : 'Connect Adena'}
          </button>
        </>
      )}
      {(v.status === 'wrong-network' || v.status === 'switching') && (
        <>
          <p>
            Adena is on <span className="mono">{(v.chainId && displayText(v.chainId)) || 'another network'}</span>. Kylix runs on the {CHAIN_ID}{' '}
            testnet. Switching adds {CHAIN_ID} to Adena first if it does not know it.
          </p>
          <button type="button" className="btn" onClick={w.switchNetwork} disabled={v.status === 'switching'}>
            {v.status === 'switching' ? 'Waiting for Adena…' : `Switch Adena to ${CHAIN_ID}`}
          </button>
        </>
      )}
      {v.status === 'connected' && v.address && (
        <div className="wallet-connected">
          <p>
            Connected on {CHAIN_ID} as <span className="mono address">{displayText(v.address)}</span>
          </p>
          <button type="button" className="btn btn-quiet" onClick={w.disconnect}>
            Disconnect
          </button>
        </div>
      )}
      {v.error && (
        <p className="form-error" role="alert">
          {v.error}
        </p>
      )}
    </section>
  )
}
