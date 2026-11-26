import type { TxRunner } from '../app/hooks.ts'
import { txSentence } from '../app/txState.ts'

// The state of the current transaction, pinned to the bottom of the window.
// The live region is a separate element that stays in the page at all
// times, so screen readers announce each change.
export function TxBar({ tx }: { tx: TxRunner }) {
  const s = tx.state
  const hash = s.phase === 'sent' || s.phase === 'landed' || (s.phase === 'failed' && s.hash) ? (s as { hash?: string }).hash : undefined
  const link = s.phase !== 'idle' ? s.meta.link : undefined
  return (
    <>
      <p className="visually-hidden" role="status" aria-live="polite">
        {txSentence(s)}
      </p>
      <div className={`txbar txbar-${s.phase}`} hidden={s.phase === 'idle'}>
        <div className="txbar-inner">
          <p className="txbar-text">{txSentence(s)}</p>
          {hash && (
            <p className="txbar-hash">
              Transaction <span className="mono">{hash}</span>
            </p>
          )}
          <div className="txbar-actions">
            {link && (s.phase === 'landed' || s.phase === 'failed' || s.phase === 'sent') && (
              <a className="text-link" href={link.href}>
                {link.text}
              </a>
            )}
            {!tx.busy && s.phase !== 'idle' && (
              <button type="button" className="btn btn-quiet" onClick={tx.dismiss}>
                Close
              </button>
            )}
          </div>
        </div>
      </div>
    </>
  )
}
