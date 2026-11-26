// Shapes drawn for the story: figures, the things they trade, the meander,
// the cup in profile and the mixing bowl. All are plain SVG in a 600 by 600
// picture, coloured through CSS classes defined in global.css.

import { CENTER } from './geometry.ts'

// One unit of the running key, 40 wide and 24 high, drawn as a stroke.
const keyUnit = 'M0 24 H40 M0 24 V0 H32 V16 H16 V8 H24'

// A meander running round a circle. The units are straight and rotated into
// place, which is how a painter fits a key pattern round a tondo.
export function RoundMeander({ radius, count }: { radius: number; count: number }) {
  const units = []
  const width = (2 * Math.PI * radius) / count
  const scale = width / 40
  for (let i = 0; i < count; i++) {
    units.push(
      <path
        key={i}
        d={keyUnit}
        transform={`rotate(${(360 / count) * i} ${CENTER} ${CENTER}) translate(${CENTER - width / 2} ${CENTER - radius - 12 * scale}) scale(${scale} ${scale})`}
      />,
    )
  }
  return <g className="meander-stroke">{units}</g>
}

// A standing draped figure in red-figure style: clay body, glaze detail lines.
// Local origin is between the feet; the figure faces right and is about 104 tall.
export type Who = 'ana' | 'ben' | 'cleo'

export function Figure({ who }: { who: Who }) {
  return (
    <g>
      {who === 'ana' && <circle className="fill-miltos" cx={-12} cy={-95} r={6.5} />}
      {who === 'cleo' && (
        <path className="fill-miltos" d="M-8,-97 C-16,-90 -18,-76 -15,-62 L-8,-64 C-9,-76 -6,-88 -1,-94 Z" />
      )}
      <path
        className="fill-clay"
        d="M-9,-96 C-6,-103 6,-103 9,-96 L10,-91 L15,-86 L10,-85 L9,-80 C7,-77 3,-76 1,-76 L3,-72 C8,-71 11,-70 13,-68 C24,-62 34,-56 44,-52 L46,-47 C34,-50 22,-54 12,-58 C14,-40 17,-20 20,-2 L24,0 L24,3 L4,3 L2,0 L-4,0 L-4,3 L-24,3 L-22,-2 C-24,-24 -21,-52 -12,-70 C-9,-72 -7,-73 -6,-76 L-9,-82 C-12,-87 -12,-92 -9,-96 Z"
      />
      {who === 'ana' && (
        <path className="fill-miltos" d="M-10,-94 C-8,-102 6,-104 9,-96 C4,-98 -2,-95 -5,-90 L-8,-85 C-11,-88 -12,-92 -10,-94 Z" />
      )}
      {who === 'ben' && (
        <>
          <path className="fill-miltos" d="M-10,-93 C-8,-102 6,-104 9,-96 C3,-97 -3,-95 -6,-89 L-9,-86 Z" />
          <path className="fill-miltos" d="M-3,-81 C1,-78 6,-78 10,-82 L11,-78 C9,-71 1,-69 -5,-74 Z" />
        </>
      )}
      {who === 'cleo' && (
        <path className="line-glaze" d="M-9,-93 C-4,-96 4,-97 9,-95" strokeWidth={2.2} />
      )}
      <path className="line-glaze" d="M5,-90.5 h2.5" strokeWidth={1.8} />
      <path
        className="line-glaze"
        d="M-6,-66 C-11,-44 -13,-22 -12,-3 M3,-60 C3,-40 5,-20 8,-3 M-17,-40 C-7,-34 4,-35 12,-40 M-22,-8 C-14,-5 -6,-10 2,-6 C10,-3 15,-8 20,-6"
        strokeWidth={1.6}
      />
    </g>
  )
}

// The three things traded, drawn in added white, each centred on its origin.
export type Thing = 'obol' | 'relic' | 'drachma'

export function ThingGlyph({ thing }: { thing: Thing }) {
  if (thing === 'obol') {
    return (
      <g>
        {[0, 1, 2].map((i) => (
          <g key={i} transform={`translate(0 ${10 - i * 8})`}>
            <path className="fill-cream line-glaze-thin" d="M-17,0 v5 a17 5.5 0 0 0 34 0 v-5 Z" />
            <ellipse className="fill-cream line-glaze-thin" cx={0} cy={0} rx={17} ry={5.5} />
          </g>
        ))}
        <ellipse className="line-glaze-thin" cx={0} cy={-6} rx={9} ry={2.6} fill="none" />
      </g>
    )
  }
  if (thing === 'relic') {
    return (
      <g>
        <path
          className="fill-cream line-glaze-thin"
          d="M-6,-20 h12 v3 c0,3 -2,4 -2,6 c8,3 12,9 12,16 c0,8 -6,13 -12,15 v4 h5 v3 h-18 v-3 h5 v-4 c-6,-2 -12,-7 -12,-15 c0,-7 4,-13 12,-16 c0,-2 -2,-3 -2,-6 Z"
        />
        <path className="line-glaze" d="M-11,-8 c-8,-2 -9,8 -2,10 M11,-8 c8,-2 9,8 2,10" fill="none" strokeWidth={2} />
        <path className="line-glaze" d="M-10,4 h20" strokeWidth={1.4} />
      </g>
    )
  }
  return (
    <g>
      <circle className="fill-cream line-glaze-thin" r={18} />
      <circle className="line-glaze-thin" r={14.5} fill="none" />
      <path className="fill-glaze" d="M-7,-8 c-2,-4 3,-6 7,-5 c4,-1 9,1 7,5 c3,4 2,14 -7,17 c-9,-3 -10,-13 -7,-17 Z" />
      <circle className="fill-cream" cx={-3.4} cy={-6} r={2.6} />
      <circle className="fill-cream" cx={3.4} cy={-6} r={2.6} />
    </g>
  )
}

// A krater, the bowl wine and water were mixed in: here, the GnoSwap pool.
export function Krater() {
  return (
    <g>
      <path
        className="fill-clay line-glaze"
        strokeWidth={2}
        d="M-30,-22 h60 l-4,6 c6,8 6,20 -6,30 l-4,4 h-32 l-4,-4 c-12,-10 -12,-22 -6,-30 Z"
      />
      <path className="line-glaze" strokeWidth={2} fill="none" d="M-26,-12 c-12,0 -14,12 -4,16 M26,-12 c12,0 14,12 4,16" />
      <path className="fill-clay line-glaze" strokeWidth={2} d="M-10,18 h20 l2,8 h6 v4 h-36 v-4 h6 Z" />
      <path className="line-glaze" strokeWidth={1.6} d="M-24,-10 h48 M-22,6 h44" />
      <path className="line-glaze" strokeWidth={1.4} fill="none" d="M-18,-4 l4,6 l4,-6 l4,6 l4,-6 l4,6 l4,-6 l4,6 l4,-6" />
    </g>
  )
}

// The whole cup seen from the side, black glaze on a clay ground, as a
// black-figure painter would show it.
export function CupProfile() {
  return (
    <g>
      <circle className="fill-clay" cx={300} cy={300} r={268} />
      <circle className="line-glaze" cx={300} cy={300} r={252} fill="none" strokeWidth={2} />
      <circle className="line-glaze" cx={300} cy={300} r={244} fill="none" strokeWidth={1} />
      <path
        className="line-glaze"
        fill="none"
        strokeWidth={13}
        strokeLinecap="round"
        d="M134,296 C96,316 58,300 52,252 M466,296 C504,316 542,300 548,252"
      />
      <path className="fill-glaze" d="M92,252 C100,330 196,368 282,372 L318,372 C404,368 500,330 508,252 Z" />
      <ellipse className="fill-glaze" cx={300} cy={252} rx={208} ry={36} />
      <ellipse className="fill-deep" cx={300} cy={254} rx={194} ry={28} />
      <ellipse className="fill-clay" cx={300} cy={262} rx={64} ry={11} />
      <ellipse className="line-glaze" cx={300} cy={262} rx={56} ry={9} fill="none" strokeWidth={1.4} />
      <path className="line-clay" fill="none" strokeWidth={2.5} d="M118,300 C170,336 240,350 300,350 C360,350 430,336 482,300" />
      <path className="fill-glaze" d="M284,370 C290,384 292,398 288,412 L312,412 C308,398 310,384 316,370 Z" />
      <path className="fill-glaze" d="M214,440 C230,416 270,410 300,410 C330,410 370,416 386,440 Z" />
      <path className="line-clay" strokeWidth={3} d="M214,440 H386" />
      <path className="line-clay" strokeWidth={2} d="M276,412 H324" />
    </g>
  )
}
