// Drives the trading app with the development mock wallet against live
// testnet reads, checks what each button hands to the wallet, and saves
// screenshots. The mock wallet signs nothing and sends nothing.
//
// Usage: npm run dev -- --port 5199 &   then
//        node scripts/app-check.mjs [outDir] [baseUrl]
import assert from 'node:assert/strict'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { chromium } from 'playwright'

const out = process.argv[2] ?? 'app-shots'
const base = process.argv[3] ?? 'http://localhost:5199/kylix/'
mkdirSync(out, { recursive: true })

// The owner of offer 4 on the live realm: holds OBOL, DRACHMA and GNS.
const OWNER = 'g1wpca5kqm5xgqm27etsaq994z9tc0cl7m33vxds'
const KYLIX = 'gno.land/r/nym-kylix000/kylix'
const DEMO = 'gno.land/r/nym-kylix000/kylixdemo'

const sizes = [
  { name: 'desktop', width: 1440, height: 900, mobile: false },
  { name: 'phone', width: 360, height: 760, mobile: true },
]

const browser = await chromium.launch()
const failures = []
const check = async (what, fn) => {
  try {
    await fn()
    console.log(`ok   ${what}`)
  } catch (e) {
    failures.push(what)
    console.log(`FAIL ${what}\n     ${String(e.message ?? e).split('\n').slice(0, 6).join('\n     ')}`)
  }
}

async function open(size, query) {
  const context = await browser.newContext({
    viewport: { width: size.width, height: size.height },
    deviceScaleFactor: size.mobile ? 2 : 1,
    isMobile: size.mobile,
    hasTouch: size.mobile,
  })
  const page = await context.newPage()
  const outside = []
  page.on('request', (r) => {
    const u = new URL(r.url())
    if (!['localhost', 'rpc.onyx.testnets.gno.land', 'indexer.onyx.testnets.gno.land'].includes(u.hostname) && !u.protocol.startsWith('data')) outside.push(r.url())
  })
  page.on('pageerror', (e) => failures.push(`page error: ${e.message}`))
  await page.goto(`${base}app${query}`, { waitUntil: 'domcontentloaded' })
  await page.evaluate(() => document.fonts.ready)
  return { page, context, outside }
}

const sent = (page) => page.evaluate(() => JSON.parse(JSON.stringify(window.__kylixMock.sent, (_k, v) => (typeof v === 'bigint' ? v.toString() : v))))
const shot = (page, name, full = true) => page.screenshot({ path: join(out, `${name}.png`), fullPage: full })
const waitTx = (page, text) => page.locator('.txbar-text').filter({ hasText: text }).waitFor({ timeout: 30_000 })

for (const size of sizes) {
  const s = size.name
  const { page, context, outside } = await open(size, `?wallet=mock&address=${OWNER}`)

  await check(`${s}: read-only view shows the ready ring 4, 5, 6 and the book`, async () => {
    await page.getByRole('button', { name: 'Connect Adena' }).waitFor()
    await page.locator('.ring-card h3', { hasText: 'Ring of 3' }).first().waitFor({ timeout: 60_000 })
    await page.locator('.offer-title', { hasText: 'Offer 4' }).waitFor()
    assert.equal(await page.locator('.ring-picture').count() >= 1, true, 'ring picture from the chain')
    assert.equal(await page.getByRole('button', { name: 'Settle this ring' }).first().isDisabled(), true)
    await shot(page, `${s}-1-read-only`)
  })

  await check(`${s}: connect shows balances, relics and the claim state`, async () => {
    await page.getByRole('button', { name: 'Connect Adena' }).click()
    await page.getByText(`Connected on onyx-1 as`).waitFor()
    await page.locator('.balances dt', { hasText: 'OBOL' }).waitFor({ timeout: 60_000 })
    await page.locator('.offer-mine .offer-title', { hasText: 'Offer 4' }).waitFor()
    await shot(page, `${s}-2-connected`)
  })

  await check(`${s}: an empty form is refused before the wallet opens, focus on the first bad field`, async () => {
    await page.getByRole('button', { name: 'Approve and post' }).click()
    await page.locator('#post-giveAmount-error').waitFor()
    assert.equal(await page.evaluate(() => document.activeElement?.id), 'post-giveAmount')
    assert.equal((await sent(page)).length, 0)
    await page.locator('#post-title').scrollIntoViewIfNeeded()
    await shot(page, `${s}-3-form-errors`, false)
  })

  await check(`${s}: post hands the wallet approve + PostIntent in one transaction`, async () => {
    await page.locator('#post-giveAmount').fill('10')
    await page.locator('#post-wantAmount').fill('5')
    await page.locator('#post-expiryDays').selectOption('3')
    await page.locator('.post-summary').waitFor()
    await page.getByRole('button', { name: 'Approve and post' }).click()
    await waitTx(page, 'Post an offer: done')
    const [plan] = await sent(page)
    assert.equal(plan.messages.length, 2)
    const [approve, post] = plan.messages.map((m) => m.value)
    assert.deepEqual([approve.pkg_path, approve.func, approve.args[0], approve.args[2]], [DEMO, 'Approve', 'OBOL', '10'])
    assert.match(approve.args[1], /^g1[0-9a-z]{38}$/)
    assert.equal(approve.caller, OWNER)
    assert.equal(post.pkg_path, KYLIX)
    assert.equal(post.func, 'PostIntent')
    assert.deepEqual(post.args.slice(0, 8), ['fungible', `${DEMO}.OBOL`, '', '10', 'fungible', `${DEMO}.DRACHMA`, '', '5'])
    assert.ok(Number(post.args[8]) > 1_400_000 + 3 * 17_280 - 100, `expiry ${post.args[8]}`)
    // The form clears after the transaction lands.
    assert.equal(await page.locator('#post-giveAmount').inputValue(), '')
    await shot(page, `${s}-4-posted`, false)
  })

  await check(`${s}: an MNS name the account does not hold is refused before the wallet opens`, async () => {
    await page.getByRole('button', { name: 'Close' }).click()
    const before = (await sent(page)).length
    await page.getByRole('radio', { name: 'An item' }).first().check()
    await page.locator('#post-giveItem').selectOption('mns')
    await page.locator('#post-giveMnsName').fill('kylix-no-such-name*gno')
    await page.locator('#post-wantAmount').fill('5')
    await page.getByRole('button', { name: 'Approve and post' }).click()
    await waitTx(page, 'You do not hold the MNS name kylix-no-such-name*gno.')
    assert.equal((await sent(page)).length, before)
    await page.locator('#post-title').scrollIntoViewIfNeeded()
    await shot(page, `${s}-4b-mns-refused`, false)
    await page.getByRole('radio', { name: 'A token' }).first().check()
  })

  await check(`${s}: settle hands the wallet SettleRing("4,5,6")`, async () => {
    await page.getByRole('button', { name: 'Close' }).click()
    const card = page.locator('.ring-card', { hasText: 'Offers 4, 5, 6' })
    await card.getByRole('button', { name: 'Settle this ring' }).click()
    await waitTx(page, 'Settle ring 4, 5, 6: done')
    const plan = (await sent(page)).at(-1)
    assert.equal(plan.messages.length, 1)
    assert.deepEqual(
      [plan.messages[0].value.pkg_path, plan.messages[0].value.func, plan.messages[0].value.args],
      [KYLIX, 'SettleRing', ['4,5,6']],
    )
    await card.scrollIntoViewIfNeeded()
    await shot(page, `${s}-5-settled`, false)
  })

  await check(`${s}: offer details ask the realm whether it is deliverable`, async () => {
    await page.getByRole('button', { name: 'Close' }).click()
    const row = page.locator('.offer', { hasText: 'Offer 5' })
    await row.getByRole('button', { name: /Details/ }).click()
    await row.getByText(/^(Ready|Not ready)/).waitFor({ timeout: 30_000 })
    assert.equal(await row.getByRole('button', { name: /Hide details/ }).getAttribute('aria-expanded'), 'true')
    await row.scrollIntoViewIfNeeded()
    await shot(page, `${s}-6-details`, false)
  })

  await check(`${s}: cancel on my own offer hands the wallet CancelIntent(4)`, async () => {
    await page.getByRole('radio', { name: /Mine/ }).check()
    const row = page.locator('.offer', { hasText: 'Offer 4' })
    assert.equal(await page.locator('.offer').count(), await page.locator('.offer-mine').count())
    await row.getByRole('button', { name: 'Cancel offer 4' }).click()
    await waitTx(page, 'Cancel offer 4: done')
    const plan = (await sent(page)).at(-1)
    assert.deepEqual([plan.messages[0].value.func, plan.messages[0].value.args], ['CancelIntent', ['4']])
  })

  await check(`${s}: claim hands the wallet kylixdemo.Claim, or shows the cooldown`, async () => {
    await page.getByRole('button', { name: 'Close' }).click()
    const claim = page.getByRole('button', { name: 'Claim demo assets' })
    if (await claim.count()) {
      await claim.click()
      await waitTx(page, 'Claim demo assets: done')
      const plan = (await sent(page)).at(-1)
      assert.deepEqual([plan.messages[0].value.pkg_path, plan.messages[0].value.func], [DEMO, 'Claim'])
    } else {
      await page.getByText(/You can claim again at block/).waitFor()
    }
  })

  await check(`${s}: only the testnet RPC and indexer were contacted`, async () => {
    assert.deepEqual(outside, [])
  })
  await context.close()

  // Wallet states.
  await check(`${s}: no wallet installed`, async () => {
    const { page: p, context: c } = await open(size, '?wallet=none')
    await p.getByText('Adena is not installed in this browser').waitFor()
    assert.equal(await p.getByRole('link', { name: 'adena.app' }).getAttribute('href'), 'https://adena.app')
    await shot(p, `${s}-7-not-installed`, false)
    await c.close()
  })

  await check(`${s}: wrong network, then switch`, async () => {
    const { page: p, context: c } = await open(size, '?wallet=mock-other-network')
    await p.getByRole('button', { name: 'Connect Adena' }).click()
    await p.getByRole('button', { name: 'Switch Adena to onyx-1' }).waitFor()
    await shot(p, `${s}-8-wrong-network`, false)
    await p.getByRole('button', { name: 'Switch Adena to onyx-1' }).click()
    await p.getByText('Connected on onyx-1 as').waitFor()
    await c.close()
  })

  await check(`${s}: account changed in the wallet`, async () => {
    const { page: p, context: c } = await open(size, `?wallet=mock&address=${OWNER}`)
    await p.getByRole('button', { name: 'Connect Adena' }).click()
    await p.getByText(OWNER).waitFor()
    const other = 'g1tu4h77px8wzyvsstxlc02d27996ht88gqnrhkm'
    await p.evaluate((a) => window.__kylixMock.switchAccount(a), other)
    await p.getByText(other).waitFor()
    await c.close()
  })

  await check(`${s}: a declined transaction says so`, async () => {
    const { page: p, context: c } = await open(size, '?wallet=mock-reject')
    await p.getByRole('button', { name: 'Connect Adena' }).click()
    const settle = p.getByRole('button', { name: 'Settle this ring' }).first()
    await settle.waitFor({ timeout: 60_000 })
    await settle.click()
    await waitTx(p, 'You declined it in the wallet')
    await c.close()
  })

  await check(`${s}: a chain refusal shows the cleaned reason`, async () => {
    const { page: p, context: c } = await open(size, '?wallet=mock-fail')
    await p.getByRole('button', { name: 'Connect Adena' }).click()
    const settle = p.getByRole('button', { name: 'Settle this ring' }).first()
    await settle.waitFor({ timeout: 60_000 })
    await settle.click()
    await waitTx(p, 'The chain refused it: insufficient allowance')
    await shot(p, `${s}-9-failed`, false)
    await c.close()
  })

  await check(`${s}: without the dev flag, the page looks for Adena and finds none`, async () => {
    const { page: p, context: c } = await open(size, '')
    await p.getByText('Adena is not installed in this browser').waitFor({ timeout: 10_000 })
    await c.close()
  })

  await check(`${s}: the story's live rings come from the chain`, async () => {
    const context2 = await browser.newContext({ viewport: { width: size.width, height: size.height }, deviceScaleFactor: 1 })
    const p = await context2.newPage()
    await p.goto(base, { waitUntil: 'domcontentloaded' })
    await p.locator('.live .ring-card').first().waitFor({ timeout: 60_000 })
    assert.equal(await p.locator('.live .tag', { hasText: 'Sample' }).count(), 0)
    await p.locator('.live').screenshot({ path: join(out, `${s}-10-story-live.png`) })
    await context2.close()
  })
}
await browser.close()
console.log(failures.length ? `\n${failures.length} failed:\n${failures.join('\n')}` : '\nall passed')
console.log(`screenshots in ${out}`)
process.exit(failures.length ? 1 : 0)
