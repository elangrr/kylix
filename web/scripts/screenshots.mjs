// Screenshots of every scene at a desktop and a phone width.
// Usage: npm run build && npx vite preview --port 4173 &  then
//        node scripts/screenshots.mjs [outDir] [baseUrl]
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { chromium } from 'playwright'

const out = process.argv[2] ?? 'screenshots'
const base = process.argv[3] ?? 'http://localhost:4173/kylix/'
mkdirSync(out, { recursive: true })

const sizes = [
  { name: 'desktop', width: 1440, height: 900, mobile: false },
  { name: 'phone', width: 360, height: 760, mobile: true },
]

const browser = await chromium.launch()
for (const size of sizes) {
  const context = await browser.newContext({
    viewport: { width: size.width, height: size.height },
    deviceScaleFactor: size.mobile ? 2 : 1,
    isMobile: size.mobile,
    hasTouch: size.mobile,
  })
  const page = await context.newPage()
  await page.goto(base, { waitUntil: 'networkidle' })
  await page.evaluate(() => document.fonts.ready)

  const steps = await page.locator('.step').count()
  for (let i = 0; i < steps; i++) {
    // Put the step's text just above the line the page uses to pick the active step.
    await page.evaluate(
      ({ i, mobile }) => {
        const el = document.querySelectorAll('.step-inner')[i]
        const line = window.innerHeight * (mobile ? 0.56 : 0.22)
        window.scrollTo(0, el.getBoundingClientRect().top + window.scrollY - line)
      },
      { i, mobile: size.mobile },
    )
    await page.waitForTimeout(1400)
    await page.screenshot({ path: join(out, `${size.name}-scene-${i + 1}.png`) })
  }

  await page.locator('#live-title').scrollIntoViewIfNeeded()
  await page.evaluate(() => window.scrollBy(0, -80))
  await page.waitForTimeout(500)
  await page.screenshot({ path: join(out, `${size.name}-scene-7.png`) })
  await page.locator('.live').screenshot({ path: join(out, `${size.name}-scene-7-full.png`) })

  await page.goto(`${base}app`, { waitUntil: 'networkidle' })
  await page.waitForTimeout(400)
  await page.screenshot({ path: join(out, `${size.name}-app.png`), fullPage: true })

  const reduced = await browser.newContext({
    viewport: { width: size.width, height: size.height },
    reducedMotion: 'reduce',
    deviceScaleFactor: 1,
  })
  const rp = await reduced.newPage()
  await rp.goto(base, { waitUntil: 'networkidle' })
  await rp.evaluate(() => document.fonts.ready)
  await rp.screenshot({ path: join(out, `${size.name}-reduced-motion.png`), fullPage: true })
  await reduced.close()
  await context.close()
}
await browser.close()
console.log(`saved to ${out}`)
