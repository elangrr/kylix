// SAMPLE DATA for the prototype. The real data layer will replace this file
// with rings read from the Kylix realm on the testnet. None of these rings,
// names or amounts exist on chain.

export interface SampleLeg {
  trader: string
  // What this trader gives to the next trader in the ring.
  gives: string
  // The least this trader will take from the previous trader.
  wantsAtLeast: string
  // True when what reaches this trader is swapped on GnoSwap on the way.
  swapped?: boolean
}

export interface SampleRing {
  id: string
  legs: SampleLeg[]
}

export const sampleRings: SampleRing[] = [
  {
    id: 'sample-1',
    legs: [
      { trader: 'Ana', gives: '100 OBOL', wantsAtLeast: '50 DRACHMA' },
      { trader: 'Ben', gives: 'Kylix Relics #relic-2', wantsAtLeast: '100 OBOL' },
      { trader: 'Cleo', gives: '50 DRACHMA', wantsAtLeast: 'Kylix Relics #relic-2' },
    ],
  },
  {
    id: 'sample-2',
    legs: [
      { trader: 'Dion', gives: '250 DRACHMA', wantsAtLeast: '240 OBOL' },
      { trader: 'Eris', gives: '240 OBOL', wantsAtLeast: '250 DRACHMA' },
    ],
  },
  {
    id: 'sample-3',
    legs: [
      { trader: 'Fotis', gives: '1000 OBOL', wantsAtLeast: 'Kylix Relics #relic-5' },
      { trader: 'Gaia', gives: 'Kylix Relics #relic-5', wantsAtLeast: '990 DRACHMA', swapped: true },
    ],
  },
]
