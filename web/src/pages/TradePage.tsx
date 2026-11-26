import { useCallback, useRef } from 'react'
import { SiteHeader } from '../components/SiteHeader.tsx'
import { SiteFooter, REALM_URL } from '../components/SiteFooter.tsx'
import { loadAccount } from '../app/account.ts'
import { usePolling, useTxRunner, useWallet } from '../app/hooks.ts'
import { loadMarket } from '../app/market.ts'
import { pageWallet } from '../app/walletSession.ts'
import { AccountPanel } from '../trade/AccountPanel.tsx'
import { OfferBook } from '../trade/OfferBook.tsx'
import { PostForm } from '../trade/PostForm.tsx'
import { ReadyRings } from '../trade/ReadyRings.tsx'
import { TxBar } from '../trade/TxBar.tsx'
import { WalletPanel } from '../trade/WalletPanel.tsx'

// The book refreshes every 30 s and balances every 45 s, only while the tab
// is visible, and both right after the user's own transactions.
const MARKET_EVERY = 30_000
const ACCOUNT_EVERY = 45_000

export function TradePage() {
  const wallet = pageWallet()
  const w = useWallet(wallet)
  const address = w.address
  const market = usePolling('market', loadMarket, MARKET_EVERY)
  const loadMine = useCallback(() => loadAccount(address ?? ''), [address])
  const account = usePolling(address ?? null, loadMine, ACCOUNT_EVERY)

  // After a transaction lands, read again now and once more a few seconds
  // later, past the client's short cache.
  const later = useRef<number | undefined>(undefined)
  const { refresh: refreshMarket } = market
  const { refresh: refreshAccount } = account
  const onLanded = useCallback(() => {
    refreshMarket()
    refreshAccount()
    window.clearTimeout(later.current)
    later.current = window.setTimeout(() => {
      refreshMarket()
      refreshAccount()
    }, 6_000)
  }, [refreshMarket, refreshAccount])
  const tx = useTxRunner(wallet, onLanded)

  return (
    <>
      <SiteHeader />
      <main className="trade">
        <div className="trade-intro">
          <p className="step-label">Trading app</p>
          <h1 tabIndex={-1}>Trade in rings</h1>
          <p>
            Post what you give and the least you will take. When offers close a ring, anyone can settle it in one
            transaction. Everything here runs on the onyx-1 testnet, and the assets have no value. You can also trade on{' '}
            <a href={REALM_URL}>the realm’s own page</a>.
          </p>
        </div>
        <div className="trade-grid">
          <div className="trade-col">
            <WalletPanel w={w} />
            {address && <AccountPanel address={address} account={account} tx={tx} />}
            <PostForm
              address={address}
              account={account.data}
              collections={market.data?.graph.collections ?? []}
              height={market.data?.graph.height ?? 0}
              tx={tx}
            />
          </div>
          <div className="trade-col">
            <ReadyRings market={market} address={address} tx={tx} />
            <OfferBook market={market} address={address} tx={tx} />
          </div>
        </div>
      </main>
      <SiteFooter />
      <TxBar tx={tx} />
    </>
  )
}
