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

async function open(size, query, prepare) {
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
  if (prepare) await prepare(page)
  await page.goto(`${base}app${query}`, { waitUntil: 'domcontentloaded' })
  await page.evaluate(() => document.fonts.ready)
  return { page, context, outside }
}

// Hostile chain data, fed by rewriting the RPC's answers in the browser: a
// third-party collection whose name copies the official one and pads it with
// no-break spaces, one with a 64-character name, an offer with 64-character
// item ids, and a Deliverable reason with a bidi override.
const NBSP = '\u00a0'
const RLO = '\u202e'
const EVIL = 'gno.land/r/evil/fake'
const LONG = 'gno.land/r/evil/longname'
const HOSTILE_ID = 999_999
const hostileCollections = [
  { key: EVIL, name: `Kylix Relics (official collection)${NBSP.repeat(15)}`, adapter: false, target: '', official: false, label: 'third-party collection', approvalCheck: true },
  { key: LONG, name: `X${RLO}${'X'.repeat(62)}`, adapter: false, target: '', official: false, label: 'third-party collection', approvalCheck: true },
]
const hostileOffer = {
  id: HOSTILE_ID,
  owner: 'g1tu4h77px8wzyvsstxlc02d27996ht88gqnrhkm',
  nonce: 9,
  slot: 'g12v99cmsg0m4z0huyynhvp8elcapjeqvgv6l05f',
  approve: 'g12v99cmsg0m4z0huyynhvp8elcapjeqvgv6l05f',
  give: { kind: 'item', key: DEMO, id: 'A'.repeat(64), amount: '0' },
  want: { kind: 'item', key: LONG, id: 'B'.repeat(64), amount: '0' },
  expiry: 9_999_999,
  viaSession: false,
}

function abciText(text, id) {
  const Data = Buffer.from(text, 'utf8').toString('base64')
  return { jsonrpc: '2.0', id, result: { response: { ResponseBase: { Error: null, Data, Events: null, Log: '', Info: '' }, Height: '0' } } }
}

async function feedHostile(page) {
  await page.route('https://rpc.onyx.testnets.gno.land/**', async (route) => {
    const req = route.request()
    let body
    try {
      body = JSON.parse(req.postData() ?? '')
    } catch {
      return route.continue()
    }
    const data = body?.params?.data ? Buffer.from(body.params.data, 'base64').toString('utf8') : ''
    if (data.startsWith(`${KYLIX}.ExportGraphJSONPage(0,`)) {
      const res = await route.fetch()
      const json = await res.json()
      const text = Buffer.from(json.result.response.ResponseBase.Data, 'base64').toString('utf8')
      const m = /^\("(.*)" string\)\s*$/s.exec(text)
      const page = JSON.parse(JSON.parse(`"${m[1]}"`))
      page.collections = [...(page.collections ?? []), ...hostileCollections]
      page.offers = [...page.offers, hostileOffer]
      return route.fulfill({ response: res, json: abciText(`(${JSON.stringify(JSON.stringify(page))} string)`, body.id) })
    }
    if (data.startsWith(`${KYLIX}.Deliverable("${HOSTILE_ID}")`)) {
      const reason = `owner ${RLO}no longer holds ${'Z'.repeat(80)}`
      const answer = { height: 1, offers: [{ id: HOSTILE_ID, deliverable: false, reason }] }
      return route.fulfill({ json: abciText(`(${JSON.stringify(JSON.stringify(answer))} string)`, body.id) })
    }
    return route.continue()
  })
}

const noSideScroll = async (page, what) => {
  const w = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, inner: window.innerWidth }))
  assert.ok(w.scroll <= w.inner, `${what}: page is ${w.scroll}px wide in a ${w.inner}px window`)
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

  await check(`${s}: hostile names and 64-character ids wrap, are cleaned, and the picker shows trust first`, async () => {
    const { page: p, context: c } = await open(size, `?wallet=mock&address=${OWNER}`, feedHostile)
    const row = p.locator('.offer', { hasText: `Offer ${HOSTILE_ID}` })
    await row.waitFor({ timeout: 60_000 })
    await noSideScroll(p, 'book with a 64-character item id')
    const note = await row.locator('.asset-note').allInnerTexts()
    assert.ok(note.every((t) => !t.includes(RLO)), `bidi override shown: ${JSON.stringify(note)}`)
    assert.equal(await row.locator('bdi').count() >= 2, true, 'chain names in <bdi>')
    await row.getByRole('button', { name: /Details/ }).click()
    const reason = row.getByText(/^Not ready: owner no longer holds Z+/)
    await reason.waitFor({ timeout: 30_000 })
    assert.ok(!(await reason.innerText()).includes(RLO), 'bidi override in the realm reason')
    await noSideScroll(p, 'offer details with a long reason')
    await row.scrollIntoViewIfNeeded()
    await shot(p, `${s}-11-hostile-book`, false)

    await p.getByRole('button', { name: 'Connect Adena' }).click()
    await p.getByText('Connected on onyx-1 as').waitFor()
    await p.getByRole('radio', { name: 'An item' }).nth(1).check()
    const options = await p.locator('#post-wantCollection option').allInnerTexts()
    const evil = options.find((t) => t.includes(EVIL))
    assert.ok(evil, `no option for ${EVIL}: ${JSON.stringify(options)}`)
    assert.ok(evil.startsWith('Third-party: '), `trust mark not first: ${JSON.stringify(evil)}`)
    assert.ok(!/[\u00a0\u202e]/.test(evil) && !/\s{2}/.test(evil), `odd spaces kept: ${JSON.stringify(evil)}`)
    const official = options.find((t) => t.includes(`${DEMO}`))
    assert.ok(official?.startsWith('Official: '), `official option: ${JSON.stringify(official)}`)
    await p.locator('#post-wantCollection').selectOption(LONG)
    await p.locator('#post-wantItemId').fill('B'.repeat(64))
    await p.locator('#post-giveAmount').fill('1')
    await p.getByRole('radio', { name: 'A token' }).first().check()
    await p.locator('.post-summary').waitFor()
    await noSideScroll(p, 'post form with a 64-character collection name')
    await p.locator('#post-title').scrollIntoViewIfNeeded()
    await shot(p, `${s}-12-hostile-form`, false)
    await c.close()
  })

  await check(`${s}: a typed known token key is refused, and a hyphenated namespace is accepted`, async () => {
    const { page: p, context: c } = await open(size, `?wallet=mock&address=${OWNER}`)
    await p.getByRole('button', { name: 'Connect Adena' }).click()
    await p.getByText('Connected on onyx-1 as').waitFor()
    await p.locator('#post-giveToken').selectOption('other')
    await p.locator('#post-giveTokenOther').fill('gno.land/r/gnoswap/gns.GNS')
    await p.locator('#post-giveAmount').fill('1000000')
    await p.locator('#post-wantAmount').fill('1')
    const before = (await sent(p)).length
    await p.getByRole('button', { name: 'Approve and post' }).click()
    await p.locator('#post-giveTokenOther-error', { hasText: 'This is GNS. Choose GNS from the token list instead.' }).waitFor()
    await p.locator('#post-giveTokenOther').fill(`${DEMO}.NOPE`)
    await p.getByRole('button', { name: 'Approve and post' }).click()
    // The key passes the form; the app then refuses before the wallet opens.
    await waitTx(p, 'Post an offer failed')
    assert.equal(await p.locator('#post-giveTokenOther-error').count(), 0)
    assert.equal((await sent(p)).length, before)
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
