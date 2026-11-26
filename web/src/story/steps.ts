// The text of the story, one entry per scene of the sticky picture.
// Every fact here comes from the project README.

export interface Step {
  label: string
  title: string
  body: string[]
  // What the picture shows in this scene, for screen readers.
  picture: string
}

export const steps: Step[] = [
  {
    label: 'Kylix',
    title: 'Swap tokens and collectibles in a circle on Gno.land.',
    body: [
      'You post what you give and the least you will take for it. When two to six offers close a ring, they all settle in one transaction, or nothing moves. Kylix never holds your assets.',
      'A kylix is the Greek cup that was passed round the circle at a drinking party.',
    ],
    picture: 'A black kylix, a shallow two-handled drinking cup on a short stem, drawn against a terracotta disc.',
  },
  {
    label: 'Three traders',
    title: 'No two of them can trade.',
    body: [
      'Ana has 100 OBOL and wants DRACHMA. Ben has a relic and wants OBOL. Cleo has DRACHMA and wants Ben’s relic.',
      'In each pair, one of them has something the other wants, and never the other way round. A market where one person sells to another leaves all three stuck.',
    ],
    picture:
      'Inside the cup, three figures: Ana holds 100 OBOL and wants DRACHMA, Ben holds a relic and wants OBOL, Cleo holds DRACHMA and wants the relic. The lines between each pair are crossed out.',
  },
  {
    label: 'The ring',
    title: 'All three can trade in a circle.',
    body: [
      'Ana’s OBOL goes to Ben, Ben’s relic goes to Cleo, and Cleo’s DRACHMA goes to Ana. Each of them gets what they asked for.',
      'Each offer says “I give X, I want at least Y.” When two to six offers close a ring like this one, anyone can settle it.',
    ],
    picture: 'Arrows run round the cup: OBOL from Ana to Ben, the relic from Ben to Cleo, DRACHMA from Cleo to Ana.',
  },
  {
    label: 'Approve one swap',
    title: 'One address per offer.',
    body: [
      'Each offer gets its own address. Ana approves her offer’s address for exactly 100 OBOL, and Ben approves his for the one relic. That address acts only for the offer it was made for, so the approval cannot be used for anything else. A blanket approval of all your items is not accepted.',
      'Your assets stay in your wallet until the ring settles. You can cancel at any time, and every offer expires: after 7 days by default, 30 at most.',
    ],
    picture: 'Each asset is marked with the number of its own offer address. The assets are still in their owners’ hands.',
  },
  {
    label: 'Settle',
    title: 'All or nothing.',
    body: [
      'Anyone can settle the ring. One transaction checks that every offer gets at least what it asked for, then moves each asset straight from its owner to the next. If any step fails, the chain rolls the whole transaction back and nothing moves.',
      'Whoever settles gets back the storage deposits that the ring’s offers and approvals had locked. There is no tip and no protocol fee.',
    ],
    picture: 'In one transaction, the OBOL has moved to Ben, the relic to Cleo and the DRACHMA to Ana.',
  },
  {
    label: 'GnoSwap',
    title: 'A swap on the way.',
    body: [
      'Say Ben would rather have DRACHMA. Ana still gives 100 OBOL, and Kylix swaps it for DRACHMA on GnoSwap on the way to Ben, inside the same transaction. A ring can include one swap.',
      'On a swap, Ben’s minimum is his price. Anyone can arrange the pool so that he receives exactly his minimum and no more, so he should ask for what he wants to receive.',
    ],
    picture: 'On the way from Ana to Ben, the OBOL passes through a mixing bowl marked GnoSwap and comes out as DRACHMA.',
  },
]
