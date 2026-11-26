import type { Asset, Collection } from '../lib/kylix.ts'
import { assetName } from '../app/assets.ts'

// An asset as text. Known tokens show their symbol and a note; anything else
// shows its full key, so a look-alike symbol from another package stands out.
// assetName has already cleaned the chain's strings; <bdi> keeps right-to-left
// text in a name from reordering the words around it.
export function AssetLabel({ asset, collections }: { asset: Asset; collections?: Collection[] }) {
  const n = assetName(asset, collections)
  return (
    <span className={`asset ${n.unlisted ? 'asset-unlisted' : ''}`}>
      <strong className="asset-main">
        <bdi>{n.main}</bdi>
      </strong>{' '}
      <span className="asset-note">
        (<bdi>{n.note}</bdi>)
      </span>
      {n.key && (
        <span className="asset-key">
          <bdi>{n.key}</bdi>
        </span>
      )}
    </span>
  )
}
