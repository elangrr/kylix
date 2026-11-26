import { RoundMeander } from '../story/art.tsx'
import { arcPath, polar } from '../story/geometry.ts'

// A small tondo for a ring card: one medallion per offer, marked with its
// number, and an arrow from each giver to the next. A swapped hop is dashed.
export function RingGlyph({ id, labels, swapHop = -1 }: { id: string; labels: string[]; swapHop?: number }) {
  const n = labels.length
  const step = 360 / n
  const radius = 150
  const gap = n === 2 ? 40 : n > 4 ? 24 : 36
  const medal = n > 4 ? 50 : 64
  const markerId = `glyph-arrow-${id.replace(/[^a-z0-9-]/gi, '-')}`
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
      {labels.map((_, i) => {
        const at = -90 + i * step
        return (
          <path
            key={`arc-${i}`}
            className={`glyph-arc ${i === swapHop ? 'is-swap' : ''}`}
            d={arcPath(radius, at + gap, at + step - gap)}
            markerEnd={`url(#${markerId})`}
          />
        )
      })}
      {labels.map((label, i) => {
        const [x, y] = polar(radius, -90 + i * step)
        return (
          <g key={`medal-${i}`} transform={`translate(${x} ${y})`}>
            <circle className="fill-glaze" r={medal} />
            <text className="glyph-initial" y={label.length > 2 ? 16 : 24} textAnchor="middle" style={label.length > 2 ? { fontSize: 44 } : undefined}>
              {label}
            </text>
          </g>
        )
      })}
    </svg>
  )
}
