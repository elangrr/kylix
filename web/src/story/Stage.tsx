import { useId } from 'react'
import { CupProfile, Figure, Krater, RoundMeander, ThingGlyph, type Thing, type Who } from './art.tsx'
import { CENTER, arcPath } from './geometry.ts'
import { SCENE } from './scenes.ts'

type Point = readonly [number, number]

interface Trader {
  who: Who
  name: string
  feet: Point
  facing: 1 | -1
  // Where the trader's hand holds what they give.
  hand: Point
  // Where the "wants" bubble sits.
  bubble: Point
  gives: Thing
  wants: Thing
  label: string
}

const traders: Trader[] = [
  { who: 'ana', name: 'Ana', feet: [300, 200], facing: 1, hand: [370, 150], bubble: [232, 124], gives: 'obol', wants: 'drachma', label: '100 OBOL' },
  { who: 'ben', name: 'Ben', feet: [421, 420], facing: -1, hand: [353, 370], bubble: [446, 286], gives: 'relic', wants: 'obol', label: 'relic' },
  { who: 'cleo', name: 'Cleo', feet: [179, 420], facing: 1, hand: [247, 370], bubble: [154, 286], gives: 'drachma', wants: 'relic', label: 'DRACHMA' },
]

const RING_RADIUS = 205

// Arcs from each giver to the next receiver, clockwise: Ana to Ben, Ben to Cleo, Cleo to Ana.
const arcs = [
  { from: -64, to: 6 },
  { from: 66, to: 114 },
  { from: 174, to: 244 },
]

function on(visible: boolean): string {
  return visible ? 'is-on' : 'is-off'
}

function translate([x, y]: Point): string {
  return `translate(${x}px, ${y}px)`
}

interface StageProps {
  scene: number
  label: string
}

export function Stage({ scene, label }: StageProps) {
  const uid = useId().replace(/:/g, '')
  const arrowId = `arrow-${uid}`
  const fieldClip = `field-${uid}`
  const settled = scene === SCENE.settle
  const inCup = scene >= SCENE.traders
  const showArcs = scene >= SCENE.ring

  return (
    <svg className="stage-svg" viewBox="0 0 600 600" role="img" aria-label={label}>
      <defs>
        <marker id={arrowId} viewBox="0 0 10 10" refX="7" refY="5" markerWidth="5" markerHeight="5" orient="auto-start-reverse">
          <path d="M0,0 L10,5 L0,10 z" className="fill-cream" />
        </marker>
        <clipPath id={fieldClip}>
          <circle cx={CENTER} cy={CENTER} r={238} />
        </clipPath>
      </defs>

      {/* Scene 1: the cup seen from the side. It grows and fades as we look into it. */}
      <g className={`layer cup-layer ${inCup ? 'is-entered' : ''}`}>
        <CupProfile />
      </g>

      {/* Scenes 2 to 6: the tondo, the round picture inside the cup. */}
      <g className={`layer tondo-layer ${inCup ? 'is-entered' : ''}`}>
        <circle className="fill-deep" cx={CENTER} cy={CENTER} r={298} />
        <circle className="line-clay" cx={CENTER} cy={CENTER} r={280} fill="none" strokeWidth={1.5} />
        <circle className="fill-clay" cx={CENTER} cy={CENTER} r={272} />
        <circle className="fill-glaze" cx={CENTER} cy={CENTER} r={268} />
        <RoundMeander radius={256} count={40} />
        <circle className="fill-glaze" cx={CENTER} cy={CENTER} r={240} />
        <circle className="line-clay" cx={CENTER} cy={CENTER} r={240} fill="none" strokeWidth={2} />

        <g clipPath={`url(#${fieldClip})`}>
          {/* The pairs that cannot trade. */}
          <g className={`fade ${on(scene === SCENE.traders)}`}>
            {traders.map((t, i) => {
              const next = traders[(i + 1) % traders.length] ?? t
              const a: Point = [t.feet[0], t.feet[1] - 52]
              const b: Point = [next.feet[0], next.feet[1] - 52]
              const p = (k: number): Point => [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k]
              const [mx, my] = p(0.5)
              const [sx, sy] = p(0.3)
              const [ex, ey] = p(0.7)
              return (
                <g key={t.who}>
                  <path className="line-clay-dim" d={`M${sx} ${sy} L${ex} ${ey}`} strokeDasharray="5 7" strokeWidth={2} />
                  <path className="line-cream" d={`M${mx - 8} ${my - 8} l16 16 m0 -16 l-16 16`} strokeWidth={3} strokeLinecap="round" />
                </g>
              )
            })}
          </g>

          {/* The ring of trades. */}
          <g className={`fade ${on(showArcs)}`}>
            {arcs.map((a, i) => (
              <path
                key={i}
                className={`ring-arc ${scene === SCENE.swap && i === 0 ? 'is-swap' : ''}`}
                d={arcPath(RING_RADIUS, a.from, a.to)}
                markerEnd={`url(#${arrowId})`}
              />
            ))}
          </g>

          {/* The GnoSwap hop on the way from Ana to Ben. */}
          <g className={`fade ${on(scene === SCENE.swap)}`}>
            <g transform="translate(486 206)">
              <circle className="fill-glaze" r={36} />
              <Krater />
            </g>
            <text className="svg-caption svg-caption-strong" x={CENTER} y={CENTER - 4} textAnchor="middle">GnoSwap</text>
            <text className="svg-small" x={CENTER} y={CENTER + 22} textAnchor="middle">OBOL in, DRACHMA out</text>
          </g>

          {/* Centre captions. */}
          <g className={`fade ${on(scene === SCENE.ring)}`}>
            <text className="svg-caption" x={CENTER} y={CENTER + 4} textAnchor="middle">a ring of three</text>
          </g>
          <g className={`fade ${on(scene === SCENE.approve)}`}>
            <text className="svg-caption" x={CENTER} y={CENTER - 4} textAnchor="middle">three offers,</text>
            <text className="svg-caption" x={CENTER} y={CENTER + 22} textAnchor="middle">three addresses</text>
          </g>
          <g className={`fade stamp ${on(settled)}`}>
            <circle className="line-cream" cx={CENTER} cy={CENTER} r={66} fill="none" strokeWidth={2} />
            <circle className="line-cream" cx={CENTER} cy={CENTER} r={60} fill="none" strokeWidth={1} />
            <text className="svg-caption" x={CENTER} y={CENTER - 4} textAnchor="middle">one</text>
            <text className="svg-caption" x={CENTER} y={CENTER + 20} textAnchor="middle">transaction</text>
          </g>

          {/* The traders. */}
          {traders.map((t) => (
            <g key={t.who}>
              <g transform={`translate(${t.feet[0]} ${t.feet[1]}) scale(${t.facing} 1)`}>
                <Figure who={t.who} />
              </g>
              <text
                className="svg-name"
                x={t.feet[0]}
                y={t.who === 'ana' ? t.feet[1] - 118 : t.feet[1] + 30}
                textAnchor="middle"
              >
                {t.name}
              </text>
            </g>
          ))}

          {/* What each trader wants. Ben's wish changes in the swap scene. */}
          {traders.map((t) => {
            const showBubble = scene === SCENE.traders || (scene === SCENE.swap && t.who === 'ben')
            const wants: Thing = scene === SCENE.swap && t.who === 'ben' ? 'drachma' : t.wants
            return (
              <g key={t.who} className={`fade ${on(showBubble)}`}>
                <g transform={`translate(${t.bubble[0]} ${t.bubble[1]})`}>
                  <circle className="bubble" r={27} />
                  <g transform="scale(0.72)" className="ghost">
                    <ThingGlyph thing={wants} />
                  </g>
                </g>
              </g>
            )
          })}

          {/* What each trader gives. These move to the next trader when the ring settles. */}
          {traders.map((t, i) => {
            const next = traders[(i + 1) % traders.length] ?? t
            const at = settled ? next.hand : t.hand
            return (
              <g key={t.gives} className={`thing ${on(inCup)}`} style={{ transform: translate(at) }}>
                <g className={`fade ${on(scene === SCENE.approve)}`}>
                  <rect className="approval-box" x={-26} y={-28} width={52} height={56} rx={6} />
                  <circle className="seal" cx={26} cy={-28} r={12} />
                  <text className="seal-text" x={26} y={-23} textAnchor="middle">{i + 1}</text>
                </g>
                <ThingGlyph thing={t.gives} />
                <text className="svg-label" x={0} y={44} textAnchor="middle">{t.label}</text>
              </g>
            )
          })}
        </g>
      </g>
    </svg>
  )
}
