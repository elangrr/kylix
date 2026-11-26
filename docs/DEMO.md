# Demo video script

A plan for a video of about three minutes. Record the screen at 1920×1080 with the browser at 100% zoom, and speak the lines or put them on screen as captions.

## Before recording

- Adena installed, set to the `onyx-1` testnet, with an account that holds a few test GNOT. The faucet gives 50 GNOT: `POST https://faucet-agent.onyx.testnets.gno.land/fund` with `{"address":"g1...","chain_id":"onyx-1"}`.
- The book holds two offers that wait for a third: one gives a relic and wants at least 100 OBOL, the other gives 50 DRACHMA and wants that relic. Your offer in step 4 closes the ring. To set this up, run `NS=nym-kylix000 scripts/testnet-rehearsal.sh seed` and then cancel the seeded offer that gives OBOL.
- A second ring with a GnoSwap swap, ready for step 6, if you want to show the swap in the web app. Otherwise show the ring picture from the README.
- Two tabs open: https://elangrr.github.io/kylix/ and https://onyx.testnets.gno.land/r/nym-kylix000/kylix.

## Shots

| # | Time | On screen | Say |
|---|---|---|---|
| 1 | 0:00 to 0:25 | The story page. Scroll slowly through scenes 1 to 3: three traders in the cup, then the arrows round the circle. | "Ana has OBOL and wants DRACHMA. Ben has a relic and wants OBOL. Cleo has DRACHMA and wants the relic. No two of them can trade, but all three can trade in a circle. Kylix settles that circle on Gno.land in one transaction." |
| 2 | 0:25 to 0:45 | Keep scrolling through scenes 4 to 6: the approvals, the settlement, the GnoSwap bowl. | "Kylix never holds your assets. Each offer gets its own address, and you approve it for exactly what you give. If someone in the ring wants a different token, Kylix swaps it on GnoSwap on the way, in the same transaction." |
| 3 | 0:45 to 1:10 | Click **Start trading**. Connect Adena. Click **Claim demo assets** and sign. The balances fill in. | "This is the trading app. It is a static page that reads the realm on the onyx-1 testnet. I connect Adena and claim demo assets: two tokens and one relic." |
| 4 | 1:10 to 1:40 | In **Post an offer**: give 100 OBOL, want at least 50 DRACHMA. Click **Approve and post**. Show the Adena window with two messages, then sign. | "I offer 100 OBOL for at least 50 DRACHMA. My wallet signs one transaction with two steps: the approval for exactly 100 OBOL, and the offer. The tokens stay in my wallet." |
| 5 | 1:40 to 2:10 | The ring appears under **Rings ready to settle** with its picture. Click **Settle this ring** and sign. The balances change. | "Two offers were already waiting. Mine closes the ring, and the browser finds it. The picture is drawn by the realm itself. Anyone can settle. I do, and all three trades happen at once: I gave OBOL and received DRACHMA from someone who never wanted my OBOL." |
| 6 | 2:10 to 2:35 | The realm's page on gnoweb: the home page, then a ring page with a GnoSwap hop, or the solver in a terminal printing a settle command. | "Everything also works without this website. The realm renders its own pages, and an off-chain solver finds rings and prints the settle command. Whoever settles gets back the storage deposits the ring had locked." |
| 7 | 2:35 to 3:00 | The README on GitHub: the feature list and the test table. | "Kylix has no admin key and no custody. Collections plug in through adapters, so MNS names trade today. It is live on onyx-1, and the code and tests are public." |

## If something goes wrong while recording

- Adena shows one message where two are expected, or refuses the transaction: stop and note what it showed. The two-step transaction has only been checked against Adena's source code.
- The ring does not appear after posting: the app refreshes right after your own transaction and then every 30 seconds, so wait for that or reload. If it still does not appear, open the offer's details to see whether the realm calls it deliverable.
- The RPC answers slowly or with errors: the testnet rate-limits. Wait a minute and reload.
