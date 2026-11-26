import { SiteHeader } from '../components/SiteHeader.tsx'
import { SiteFooter, REALM_URL } from '../components/SiteFooter.tsx'
import { Link } from '../Link.tsx'
import { Stage } from '../story/Stage.tsx'

export function AppPlaceholder() {
  return (
    <>
      <SiteHeader />
      <main className="placeholder">
        <div className="placeholder-picture">
          <Stage scene={4} label="Three traders inside the cup after their ring has settled." />
        </div>
        <div className="placeholder-text">
          <p className="step-label">Trading app</p>
          <h1 tabIndex={-1}>The trading app comes next.</h1>
          <p>
            Here you will post offers, approve them and settle rings from your wallet. Until then, you can trade on
            the realm’s own page on the onyx-1 testnet.
          </p>
          <div className="live-actions">
            <a className="button" href={REALM_URL}>Open the realm</a>
            <Link to="/" className="text-link">Back to the story</Link>
          </div>
        </div>
      </main>
      <SiteFooter />
    </>
  )
}
