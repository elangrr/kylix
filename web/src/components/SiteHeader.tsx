import { Link } from '../Link.tsx'

export function SiteHeader() {
  return (
    <header className="site-header">
      <Link to="/" className="wordmark" aria-label="Kylix, home">
        <svg viewBox="0 0 64 64" aria-hidden="true" className="wordmark-mark">
          <circle cx="32" cy="32" r="30" className="fill-glaze" />
          <circle cx="32" cy="32" r="23" fill="none" className="line-clay" strokeWidth="5" />
          <circle cx="32" cy="32" r="11" className="fill-clay" />
        </svg>
        <span>Kylix</span>
      </Link>
      <nav aria-label="Main">
        <Link to="/app" className="header-link">Start trading</Link>
      </nav>
    </header>
  )
}
