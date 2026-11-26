// The page's one wallet. Adena's change events cannot be unsubscribed and
// stop after the first listener, so the page makes one AdenaWallet and keeps
// it for its whole life.
//
// In development only (npm run dev), a query flag swaps in MockWallet so the
// flows can be driven without the extension:
//   ?wallet=mock               connected-ready mock (add &address=g1... to pick the account)
//   ?wallet=mock-other-network mock on another chain
//   ?wallet=mock-reject        mock that declines every transaction
//   ?wallet=mock-fail          mock whose transactions the "chain" refuses
//   ?wallet=none               no wallet installed
// The production build drops this branch: import.meta.env.DEV is false there.

import { AdenaWallet, MockWallet, WalletError } from '../lib/wallet.ts'
import type { Wallet } from '../lib/wallet.ts'
import { isAddress } from '../lib/parse.ts'

let wallet: Wallet | undefined

export function pageWallet(): Wallet {
  if (!wallet) wallet = (import.meta.env.DEV ? devWallet() : undefined) ?? new AdenaWallet()
  return wallet
}

function devWallet(): Wallet | undefined {
  const q = new URLSearchParams(window.location.search)
  const mode = q.get('wallet')
  if (!mode) return undefined
  const address = q.get('address') ?? ''
  const mock = new MockWallet({
    ...(isAddress(address) ? { address } : {}),
    ...(mode === 'mock-other-network' ? { chainId: 'test11' } : {}),
    installed: mode !== 'none',
    ...(mode === 'mock-reject'
      ? { result: new WalletError('rejected', 'User rejected the transaction', 'TRANSACTION_REJECTED', 4000) }
      : {}),
    ...(mode === 'mock-fail'
      ? {
          result: new WalletError('failed', 'insufficient allowance', 'TRANSACTION_FAILED', 4001, {
            error: 'panic: insufficient allowance\n--- stack ---',
          }),
        }
      : {}),
  })
  // Playwright reads what the mock was asked to sign from here.
  ;(window as unknown as { __kylixMock?: MockWallet }).__kylixMock = mock
  return mock
}

/** Waits a little for an extension that injects itself after the page starts. */
export async function walletInstalled(w: Wallet): Promise<boolean> {
  if (w instanceof AdenaWallet) return w.waitInstalled(2_000)
  return w.isInstalled()
}
