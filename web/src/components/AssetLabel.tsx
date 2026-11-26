import type { Asset, Collection } from '../lib/kylix.ts'
import { assetName } from '../app/assets.ts'

// An asset as text. Known tokens show their symbol and a note; anything else
// shows its full key, so a look-alike symbol from another package stands out.
export function AssetLabel({ asset, collections }: { asset: Asset; collections?: Collection[] }) {
  const n = assetName(asset, collections)
  return (
    <span className={`asset ${n.unlisted ? 'asset-unlisted' : ''}`}>
      <strong className="asset-main">{n.main}</strong> <span className="asset-note">({n.note})</span>
      {n.key && <span className="asset-key">{n.key}</span>}
    </span>
  )
}
