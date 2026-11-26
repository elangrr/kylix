import { MeanderBand } from './Meander.tsx'
import { MotionToggle } from './MotionToggle.tsx'

export const REALM_URL = 'https://onyx.testnets.gno.land/r/nym-kylix000/kylix'
export const SOURCE_URL = 'https://github.com/elangrr/kylix'

export function SiteFooter() {
  return (
    <footer className="site-footer">
      <MeanderBand />
      <div className="site-footer-inner">
        <p>Kylix is an entry for the Gnome Tavern Hackathon. It runs on the Gno.land onyx-1 testnet.</p>
        <ul>
          <li><a href={REALM_URL}>The realm on the testnet</a></li>
          <li><a href={SOURCE_URL}>Source code</a></li>
          <li><MotionToggle className="motion-toggle motion-toggle-footer" /></li>
        </ul>
      </div>
    </footer>
  )
}
