import { SiteHeader } from '../components/SiteHeader.tsx'
import { SiteFooter } from '../components/SiteFooter.tsx'
import { Link } from '../Link.tsx'

export function NotFound() {
  return (
    <>
      <SiteHeader />
      <main className="placeholder placeholder-narrow">
        <div className="placeholder-text">
          <p className="step-label">Not found</p>
          <h1 tabIndex={-1}>There is no page at this address.</h1>
          <div className="live-actions">
            <Link to="/" className="button">Go to the start</Link>
          </div>
        </div>
      </main>
      <SiteFooter />
    </>
  )
}
