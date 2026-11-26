# Kylix web app

The Kylix website: a scrolling story that explains how a ring settles, and, later, the trading app. It is a static Vite, React and TypeScript site with no server. It is published at https://elangrr.github.io/kylix/ .

## Run

```sh
cd web
npm install
npm run dev        # http://localhost:5173/kylix/
```

## Check and build

```sh
npm run lint
npm run build      # type-checks, then writes the site to dist/
npm run preview    # serves dist/ at http://localhost:4173/kylix/
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
| `src/sampleData.ts` | Sample rings for the prototype. The chain data layer will replace it. |
| `src/lib/` | Reserved for the chain and wallet layer. |
| `src/pages/` | The story page, the `/app` placeholder and the not-found page. |

Fonts (Marcellus, Alegreya, Alegreya Sans SC) come from Fontsource packages and are bundled with the site, so no page asks a font server for anything.
