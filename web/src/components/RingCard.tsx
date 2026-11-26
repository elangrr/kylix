import type { SampleRing } from '../sampleData.ts'
import { RingGlyph } from './RingGlyph.tsx'

export function RingCard({ ring }: { ring: SampleRing }) {
  const n = ring.legs.length
  const swaps = ring.legs.filter((l) => l.swapped).length
  return (
    <article className="ring-card" aria-labelledby={`${ring.id}-title`}>
      <div className="ring-card-head">
        <RingGlyph ring={ring} />
        <div>
          <h3 id={`${ring.id}-title`}>Ring of {n}</h3>
          <p className="ring-card-meta">
            <span className="tag">Sample</span>
            {swaps > 0 && <span className="tag tag-swap">1 swap via GnoSwap</span>}
          </p>
        </div>
      </div>
      <ol className="ring-legs">
        {ring.legs.map((leg, i) => {
          const next = ring.legs[(i + 1) % n]
          return (
            <li key={leg.trader}>
              <strong>{leg.trader}</strong> gives {leg.gives} to {next?.trader}
              {next?.swapped && <span className="leg-note"> (swapped on GnoSwap on the way)</span>}
              <span className="leg-want">wants at least {leg.wantsAtLeast}</span>
            </li>
          )
        })}
      </ol>
    </article>
  )
}
