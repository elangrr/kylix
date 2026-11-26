import { RoundMeander } from '../story/art.tsx'
import { arcPath, polar } from '../story/geometry.ts'
import type { SampleRing } from '../sampleData.ts'

// A small tondo for a ring card: one medallion per trader and an arrow from
// each giver to the next. A swapped hop is drawn dashed.
export function RingGlyph({ ring }: { ring: SampleRing }) {
  const n = ring.legs.length
  const step = 360 / n
  const radius = 150
  const gap = n === 2 ? 40 : 36
  const markerId = `glyph-arrow-${ring.id}`
  return (
    <svg className="ring-glyph" viewBox="0 0 600 600" aria-hidden="true">
      <defs>
        <marker id={markerId} viewBox="0 0 10 10" refX="7" refY="5" markerWidth="4" markerHeight="4" orient="auto-start-reverse">
          <path d="M0,0 L10,5 L0,10 z" className="fill-glaze" />
        </marker>
      </defs>
      <circle className="fill-glaze" cx={300} cy={300} r={296} />
      <circle className="fill-clay" cx={300} cy={300} r={284} />
      <RoundMeander radius={262} count={32} />
      <circle className="fill-clay" cx={300} cy={300} r={238} />
      <circle className="line-glaze" cx={300} cy={300} r={238} fill="none" strokeWidth={4} />
      {ring.legs.map((leg, i) => {
        const at = -90 + i * step
        const receiver = ring.legs[(i + 1) % n]
        return (
          <path
            key={`arc-${leg.trader}`}
            className={`glyph-arc ${receiver?.swapped ? 'is-swap' : ''}`}
            d={arcPath(radius, at + gap, at + step - gap)}
            markerEnd={`url(#${markerId})`}
          />
        )
      })}
      {ring.legs.map((leg, i) => {
        const [x, y] = polar(radius, -90 + i * step)
        return (
          <g key={leg.trader} transform={`translate(${x} ${y})`}>
            <circle className="fill-glaze" r={64} />
            <text className="glyph-initial" y={24} textAnchor="middle">{leg.trader.charAt(0)}</text>
          </g>
        )
      })}
    </svg>
  )
}
