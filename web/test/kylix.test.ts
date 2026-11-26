import { describe, expect, it } from 'vitest';
import { KylixClient, parseGraphPage, ringPictureFromRender } from '../src/lib/kylix.ts';
import { GnoRpc } from '../src/lib/rpc.ts';
import { qevalString, textFromBase64 } from '../src/lib/parse.ts';
import { TOKENS } from '../src/lib/config.ts';
import { abciOk, abciPanic, fakeFetch, noSleep } from './helpers.ts';
import graphPage from './fixtures/graph-page.json';
import collections from './fixtures/collections.json';
import offer4 from './fixtures/offer-4.json';
import offerMissing from './fixtures/offer-missing.json';
import deliverable from './fixtures/deliverable.json';
import nextSlot from './fixtures/next-slot.json';
import ringRender from './fixtures/ring-render.json';
import tokenBalance from './fixtures/token-balance.json';
import tokenMissing from './fixtures/token-missing.json';
import bank from './fixtures/bank-balance.json';
import lastClaim from './fixtures/last-claim.json';
import lastClaimNone from './fixtures/last-claim-none.json';
import relicOwners from './fixtures/relic-owners.json';
import approveTarget from './fixtures/approve-target.json';
import status from './fixtures/status.json';
import gnsFuncs from './fixtures/gns-qfuncs.json';

const K = 'gno.land/r/nym-kylix000/kylix';
const D = 'gno.land/r/nym-kylix000/kylixdemo';
const REG = 'gno.land/r/nt/grc20reg/v0';
const ANA = 'g1wpca5kqm5xgqm27etsaq994z9tc0cl7m33vxds';
const NEW = 'g1jg8mtutu9khhfwc4nxmuhcpftf0pajdhfvsqf5';

function client(routes: Parameters<typeof fakeFetch>[0]) {
  const f = fakeFetch(routes);
  return { k: new KylixClient(new GnoRpc({ fetch: f.fetch, sleep: noSleep })), calls: f.calls };
}

const recordedPage = () => {
  const d = graphPage.result.response.ResponseBase.Data;
  return qevalString(textFromBase64(d));
};

describe('parsing recorded answers', () => {
  it('parses an export page from onyx-1', () => {
    const p = parseGraphPage(recordedPage());
    expect(p.realm).toBe(K);
    expect(p.offers.map((o) => o.id)).toEqual([4, 5, 6]);
    expect(p.offers[0]).toMatchObject({
      owner: ANA,
      nonce: 2,
      slot: 'g1eceszdt9lt3adywvmy42sj4j8dt0e46negrc4j',
      give: { kind: 'fungible', key: TOKENS.OBOL, id: '', amount: 100n },
      want: { kind: 'fungible', key: TOKENS.DRACHMA, id: '', amount: 50n },
    });
    expect(p.offers[1]!.give).toEqual({ kind: 'item', key: D, id: 'relic-1', amount: 0n });
    expect(p.collections!.map((c) => c.key)).toContain(D);
    expect(p.collections!.find((c) => c.key === D)).toMatchObject({ official: true, label: 'official collection', approvalCheck: true });
    expect(p.hasMore).toBe(false);
  });

  it('pulls the ring picture out of the ring page', () => {
    const md = textFromBase64(ringRender.result.response.ResponseBase.Data);
    const uri = ringPictureFromRender(md)!;
    expect(uri.startsWith('data:image/svg+xml;base64,')).toBe(true);
    const svg = textFromBase64(uri.slice('data:image/svg+xml;base64,'.length));
    expect(svg.startsWith('<svg')).toBe(true);
    expect(ringPictureFromRender('# Ring: 1,2\n\n> [!WARNING] Cannot settle this ring')).toBeNull();
  });
});

describe('KylixClient', () => {
  it('reads every page of the book', async () => {
    const page1 = JSON.stringify({
      realm: K, height: 100, collections: [], collectionsHasMore: false, collectionsNext: '',
      offers: [{ id: 1, owner: ANA, nonce: 1, slot: NEW, approve: NEW, give: { kind: 'fungible', key: 'a.A', id: '', amount: '1' }, want: { kind: 'fungible', key: 'b.B', id: '', amount: '1' }, expiry: 200, viaSession: false }],
      hasMore: true, next: 1, total: 2,
    });
    const page2 = JSON.stringify({
      realm: K, height: 101,
      offers: [{ id: 2, owner: NEW, nonce: 1, slot: ANA, approve: ANA, give: { kind: 'fungible', key: 'b.B', id: '', amount: '1' }, want: { kind: 'fungible', key: 'a.A', id: '', amount: '1' }, expiry: 200, viaSession: false }],
      hasMore: false, next: 0, total: 2,
    });
    const { k, calls } = client({
      [`vm/qeval ${K}.ExportGraphJSONPage(0, 500)`]: abciOk(`(${JSON.stringify(page1)} string)`),
      [`vm/qeval ${K}.ExportGraphJSONPage(1, 500)`]: abciOk(`(${JSON.stringify(page2)} string)`),
    });
    const g = await k.graph();
    expect(g.offers.map((o) => o.id)).toEqual([1, 2]);
    expect(g.height).toBe(100);
    expect(calls).toHaveLength(2);
  });

  it('reads the recorded book, offers, readiness and slots', async () => {
    const { k } = client({
      [`vm/qeval ${K}.ExportGraphJSONPage(0, 500)`]: graphPage,
      [`vm/qeval ${K}.GetOffer(4)`]: offer4,
      [`vm/qeval ${K}.GetOffer(999)`]: offerMissing,
      [`vm/qeval ${K}.Deliverable("4,5,6,999")`]: deliverable,
      [`vm/qeval ${K}.NextSlot("${NEW}")`]: nextSlot,
      [`vm/qeval ${K}.ApproveTarget("${ANA}", 3, "gno.land/r/nym-kylix000/adapters/nsnft")`]: approveTarget,
      [`vm/qeval ${K}.ExportCollectionsJSON("", 0)`]: collections,
    });
    const g = await k.graph();
    expect(g.offers).toHaveLength(3);
    expect(g.collections).toHaveLength(3);

    const o = await k.offer(4);
    expect(o).toMatchObject({ id: 4, owner: ANA, nonce: 2, expiry: 1543948, viaSession: false });
    expect(o!.give).toEqual({ kind: 'fungible', key: TOKENS.OBOL, id: '', amount: 100n });
    expect(await k.offer(999)).toBeNull();

    const d = await k.deliverable([4, 5, 6, 999, 4]);
    expect(d.get(4)).toEqual({ id: 4, deliverable: true, reason: '' });
    expect(d.get(999)).toEqual({ id: 999, deliverable: false, reason: 'not open' });

    expect(await k.nextSlot(NEW)).toEqual({ nonce: 1, slot: 'g1hq2jzq39snc8vxumhmkdrpr4udjukcxck0lpgj' });
    expect(await k.approveTarget(ANA, 3, 'gno.land/r/nym-kylix000/adapters/nsnft')).toMatch(/^g1/);
    expect((await k.collections()).map((c) => c.official)).toEqual([true, true, true]);
  });

  it('refuses to put a malformed address or id into an expression', async () => {
    const { k, calls } = client({});
    await expect(k.nextSlot('g1x") ; panic("')).rejects.toThrow(/invalid address/);
    await expect(k.offer(-1)).rejects.toThrow(/invalid offer id/);
    await expect(k.deliverable([1.5])).rejects.toThrow(/invalid offer id/);
    expect(calls).toHaveLength(0);
  });

  it('batches Deliverable in groups of 50', async () => {
    const ids = Array.from({ length: 120 }, (_, i) => i + 1);
    const answer = (from: number, to: number) =>
      abciOk(`(${JSON.stringify(JSON.stringify({ height: 1, offers: ids.slice(from, to).map((id) => ({ id, deliverable: true, reason: '' })) }))} string)`);
    const { k, calls } = client({
      [`vm/qeval ${K}.Deliverable("${ids.slice(0, 50).join(',')}")`]: answer(0, 50),
      [`vm/qeval ${K}.Deliverable("${ids.slice(50, 100).join(',')}")`]: answer(50, 100),
      [`vm/qeval ${K}.Deliverable("${ids.slice(100).join(',')}")`]: answer(100, 120),
    });
    const d = await k.deliverable(ids);
    expect(d.size).toBe(120);
    expect(calls).toHaveLength(3);
  });

  it('reads balances: any grc20reg token, a missing token, GNOT', async () => {
    const { k } = client({
      [`vm/qeval ${REG}.Get("${TOKENS.GNS}").BalanceOf("${ANA}")`]: tokenBalance,
      [`vm/qeval ${REG}.Get("gno.land/r/nope.X").BalanceOf("${ANA}")`]: tokenMissing,
      [`bank/balances/${ANA} `]: bank,
    });
    expect(await k.tokenBalance(TOKENS.GNS, ANA)).toBe(18208885n);
    expect(await k.tokenBalance('gno.land/r/nope.X', ANA)).toBeNull();
    expect(await k.gnotBalance(ANA)).toBe(34668423n);
  });

  it('reads token metadata', async () => {
    const key = TOKENS.GNS;
    const { k } = client({
      [`vm/qeval ${REG}.Get("${key}").GetName()+"\\n"+Get("${key}").GetSymbol()`]: abciOk('("Gnoswap\\nGNS" string)'),
      [`vm/qeval ${REG}.Get("${key}").GetDecimals()`]: abciOk('(6 int)'),
    });
    expect(await k.tokenInfo(key)).toEqual({ key, name: 'Gnoswap', symbol: 'GNS', decimals: 6 });
  });

  it('reads relic owners and the faucet cooldown', async () => {
    const owners3 = `string(OwnerOfRelic("relic-1"))+","+string(OwnerOfRelic("relic-2"))+","+string(OwnerOfRelic("relic-3"))`;
    const { k } = client({
      [`vm/qeval ${D}.relics.TotalSupply()`]: abciOk('(3 int64)'),
      [`vm/qeval ${D}.${owners3}`]: relicOwners,
      [`vm/qeval ${D}.lastClaim.Get("${ANA}")`]: lastClaim,
      [`vm/qeval ${D}.lastClaim.Get("${NEW}")`]: lastClaimNone,
      status,
    });
    expect(await k.relicOwners()).toEqual([
      { id: 'relic-1', owner: 'g1tu4h77px8wzyvsstxlc02d27996ht88gqnrhkm' },
      { id: 'relic-2', owner: 'g14zcsd35u8wk46a0dq09hwk5m2744edxlx9qtsx' },
      { id: 'relic-3', owner: 'g14zcsd35u8wk46a0dq09hwk5m2744edxlx9qtsx' },
    ]);
    expect(await k.relicsOf('g14zcsd35u8wk46a0dq09hwk5m2744edxlx9qtsx')).toEqual(['relic-2', 'relic-3']);

    const claimed = await k.faucetStatus(ANA);
    expect(claimed.lastClaim).toBe(1422957);
    expect(claimed.nextClaimHeight).toBe(1422957 + 720);
    expect(claimed.canClaimNow).toBe(true); // the status fixture is later than that
    const fresh = await k.faucetStatus(NEW);
    expect(fresh).toMatchObject({ lastClaim: null, nextClaimHeight: 0, canClaimNow: true });
  });

  it('finds how to approve each kind of asset', async () => {
    const { k } = client({
      'vm/qfuncs gno.land/r/gnoswap/gns': abciOk(JSON.stringify(gnsFuncs)),
      'vm/qfuncs gno.land/r/nope': abciPanic('package not found'),
      'vm/qfuncs gno.land/r/odd': abciOk(JSON.stringify([{ FuncName: 'Approve', Params: [{ Name: 'spender', Type: 'string' }] }])),
    });
    expect(await k.approveRoute({ kind: 'fungible', key: TOKENS.OBOL, id: '', amount: 1n })).toEqual({ kind: 'kylixdemo', pkgPath: D, symbol: 'OBOL' });
    expect(await k.approveRoute({ kind: 'item', key: D, id: 'relic-1', amount: 0n })).toEqual({ kind: 'relic', pkgPath: D });
    expect(await k.approveRoute({ kind: 'fungible', key: TOKENS.GNS, id: '', amount: 1n })).toEqual({ kind: 'spender-amount', pkgPath: 'gno.land/r/gnoswap/gns' });
    expect(await k.approveRoute({ kind: 'fungible', key: 'gno.land/r/nope.X', id: '', amount: 1n })).toBeNull();
    expect(await k.approveRoute({ kind: 'fungible', key: 'gno.land/r/odd.X', id: '', amount: 1n })).toBeNull();
    expect(await k.approveRoute({ kind: 'item', key: 'gno.land/r/nym-kylix000/adapters/nsnft', id: 'a*b', amount: 0n })).toBeNull();
  });

  it('finds the recorded ring 4,5,6 ready to settle', async () => {
    const { k } = client({
      [`vm/qeval ${K}.ExportGraphJSONPage(0, 500)`]: graphPage,
      [`vm/qeval ${K}.Deliverable("4,5,6")`]: abciOk(
        `(${JSON.stringify(JSON.stringify({ height: 1, offers: [4, 5, 6].map((id) => ({ id, deliverable: true, reason: '' })) }))} string)`,
      ),
    });
    const r = await k.readyRings();
    expect(r.rings).toEqual([{ ids: [4, 5, 6] }]);
  });

  it('drops a ring when one offer cannot deliver', async () => {
    const { k } = client({
      [`vm/qeval ${K}.ExportGraphJSONPage(0, 500)`]: graphPage,
      [`vm/qeval ${K}.Deliverable("4,5,6")`]: abciOk(
        `(${JSON.stringify(JSON.stringify({ height: 1, offers: [{ id: 4, deliverable: true, reason: '' }, { id: 5, deliverable: false, reason: 'owner no longer holds relic-1' }, { id: 6, deliverable: true, reason: '' }] }))} string)`,
      ),
    });
    const r = await k.readyRings();
    expect(r.rings).toEqual([]);
    expect(r.status.get(5)!.reason).toMatch(/no longer holds/);
  });
});
