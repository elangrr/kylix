# Kylix web app

The Kylix website: a scrolling story that explains how a ring settles, and the trading app at `/app`. It is a static Vite, React and TypeScript site with no server. It is published at https://elangrr.github.io/kylix/ .

## Run

```sh
cd web
npm install
npm run dev        # http://localhost:5173/kylix/
```

## Check and build

```sh
npm run lint
npm test           # unit tests, no network
npm run test:live  # reads the real onyx-1 realm and GnoSwap pool; sends nothing
npm run build      # type-checks, then writes the site to dist/
npm run preview    # serves dist/ at http://localhost:4173/kylix/
```

## The trading app

`/app` reads the book from the realm and works without a wallet. With Adena connected on onyx-1 it shows the account's GNOT, the known tokens and its demo relics, claims demo assets, posts offers (approve and post in one transaction of two messages), settles ready rings and cancels the account's own offers. The ring finder runs in the browser, including rings with one GnoSwap hop. An offer can give a demo relic, a token, or an MNS name through the nsnft adapter.

The page reads the book 30 seconds after the last read finished and the balances 45 seconds after theirs, only while the tab is visible, so a slow read never overlaps the next. After each of the user's transactions it drops the cached reads and reads both again, then once more six seconds later. It talks to nothing but the onyx-1 RPC and indexer.

To stay inside the RPC's rate limit, one read of the book asks `Deliverable` about at most 200 offers and makes at most 16 GnoSwap quotes. When either limit cuts the search short, the ready rings panel says that some rings may be missing.

### Without Adena, in development only

`npm run dev` honours a `wallet` query flag that puts `MockWallet` in place of Adena. The mock signs nothing and sends nothing; it records what it was asked to sign in `window.__kylixMock.sent`. The production build drops this code.

| Flag | What you get |
|---|---|
| `?wallet=mock` | A wallet that connects at once. Add `&address=g1...` to read that account's balances and offers. |
| `?wallet=mock-other-network` | A wallet on another chain, to try the network switch |
| `?wallet=mock-reject` | A wallet that declines every transaction |
| `?wallet=mock-fail` | A wallet whose transactions the chain refuses |
| `?wallet=none` | No wallet installed |

`scripts/app-check.mjs` drives these with Playwright against live testnet reads: connect, balances, the post form, settle, details, cancel, claim and each wallet state, at 1440 px and 360 px. It checks the transaction handed to the wallet each time and saves screenshots. It also rewrites some RPC answers in the browser to feed the page hostile data (a collection name padded with no-break spaces, bidi overrides, 64-character item ids) and checks that the page never scrolls sideways and that the collection picker shows the trust mark first.

```sh
npm run dev -- --port 5199 &
node scripts/app-check.mjs /path/to/output
```

The build copies `index.html` to `app/index.html` and to `404.html`, so `/kylix/app` and other deep links load on GitHub Pages, which has no rewrite rules. When you add a route, add it to `routes` in `vite.config.ts` as well.

## Screenshots

With `npm run preview` running:

```sh
npx playwright install chromium   # once
npm run shots -- /path/to/output
```

This saves every scene at 1440 px and 360 px wide, the `/app` page, and the page with reduced motion turned on.

## Deploy

`.github/workflows/pages.yml` builds `web/` and deploys it to GitHub Pages on every push to `main` that changes `web/`. You can also run it by hand from the Actions tab. In the repository settings, under Pages, set the source to "GitHub Actions" once.

## Layout

| Path | What it is |
|---|---|
| `src/story/` | The story: step text (`steps.ts`), the pinned picture (`Stage.tsx`), the drawings (`art.tsx`) and the scroll hooks. |
| `src/lib/` | The chain and wallet library: reads, ring finder, GnoSwap quotes, transaction builders, Adena. See `src/lib/README.md`. |
| `src/app/` | App logic without React: asset names and amounts (`assets.ts`), the post form's checks (`offerForm.ts`), transaction states (`txState.ts`), building each transaction from fresh reads (`actions.ts`), the market and account reads (`market.ts`, `account.ts`), the page's one wallet (`walletSession.ts`) and the hooks (`hooks.ts`). |
| `src/trade/` | The app's panels: wallet, balances and claim, post form, ready rings, open offers, and the transaction bar. |
| `src/components/` | Header, footer, meander, ring card and glyph, asset label. |
| `src/pages/` | The story page, the trading page and the not-found page. |
| `test/` | Unit tests (`test/app/` for the app logic) and live reads (`test/live/`). |

Everything read from the chain is treated as text written by strangers. It is rendered as text, the realm's ring picture is shown only through an `<img>` with a `data:image/svg+xml;base64` URI, and a token outside the known set is shown by its full key so a look-alike symbol stands out. Before display, every chain string goes through `displayText` in `src/app/assets.ts`, which removes bidi and zero-width controls and turns runs of odd spaces into one space; names sit in `<bdi>`, long runs wrap, and the collection picker puts "Official" or "Third-party" before the name.

Fonts (Marcellus, Alegreya, Alegreya Sans SC) come from Fontsource packages and are bundled with the site, so no page asks a font server for anything.
