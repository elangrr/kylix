import { describe, expect, it } from 'vitest';
import { GnoSwapQuoter, parseDrySwap } from '../src/lib/gnoswap.ts';
import { findBridgedRings, findRings, selectRings, verifyRing } from '../src/lib/rings.ts';
import type { Quote, Ring } from '../src/lib/rings.ts';
import { GnoRpc } from '../src/lib/rpc.ts';
import { buildSettle } from '../src/lib/tx.ts';
import { TOKENS } from '../src/lib/config.ts';
import type { Asset, Offer } from '../src/lib/kylix.ts';
import { abciOk, fakeFetch, noSleep } from './helpers.ts';

const W = TOKENS.WUGNOT;
const G = TOKENS.GNS;
const tok = (key: string, amount: number): Asset => ({ kind: 'fungible', key, id: '', amount: BigInt(amount) });
const relic = (id: string): Asset => ({ kind: 'item', key: 'gno.land/r/nym-kylix000/kylixdemo', id, amount: 0n });
const offer = (id: number, owner: string, give: Asset, want: Asset): Offer => ({ id, owner, nonce: 1, give, want, expiry: 0, viaSession: false });

/** A pool that pays 4.33 GNS base units per wugnot base unit, and nothing else. */
const quotes: string[] = [];
const fakeQuote: Quote = async (tin, tout, amount) => {
  quotes.push(`${tin}>${tout}:${amount}`);
  if (tin === W && tout === G) return { out: (amount * 433n) / 100n, fee: 3000 };
  return null;
};

describe('parseDrySwap', () => {
  it('reads the amount out on success', () => {
    expect(parseDrySwap('("1000000" string)\n("4334001" string)\n(undefined)')).toBe(4_334_001n);
  });
  it('returns null when the router reports an error, which the qeval parser cannot read', () => {
    const err = '("0" string)\n("0" string)\n(&(struct{("[GNOSWAP-ROUTER-020] insufficient liquidity for swap" string)} errors.errorString) *errors.errorString)';
    expect(parseDrySwap(err)).toBeNull();
    expect(parseDrySwap('("0" string)\n("0" string)\n(undefined)')).toBeNull();
  });
  it('refuses an answer of the wrong shape', () => {
    expect(() => parseDrySwap('("1" string)')).toThrow();
  });
});

describe('GnoSwapQuoter', () => {
  it('looks up the pools once per pair, then quotes each pool and keeps the best', async () => {
    const pool = (fee: number) => `vm/qeval gno.land/r/gnoswap/pool.ExistsPoolPath(GetPoolPath("${W}","${G}",${fee}))`;
    const dry = (a: string, b: string, amt: string, fee: number) =>
      `vm/qeval gno.land/r/gnoswap/router.DrySwapRoute("${a}","${b}","${amt}","EXACT_IN","${a}:${b}:${fee}","100","0")`;
    const { fetch, calls } = fakeFetch({
      [pool(100)]: abciOk('(false bool)'),
      [pool(500)]: abciOk('(true bool)'),
      [pool(3000)]: abciOk('(true bool)'),
      [pool(10000)]: abciOk('(false bool)'),
      [dry(W, G, '1000', 500)]: abciOk('("1000" string)\n("4000" string)\n(undefined)'),
      [dry(W, G, '1000', 3000)]: abciOk('("1000" string)\n("4330" string)\n(undefined)'),
      [dry(G, W, '50', 500)]: abciOk('("0" string)\n("0" string)\n(&(struct{("x" string)} errors.errorString) *errors.errorString)'),
      [dry(G, W, '50', 3000)]: abciOk('("50" string)\n("11" string)\n(undefined)'),
    });
    const q = new GnoSwapQuoter(new GnoRpc({ fetch, sleep: noSleep }));
    expect(await q.quote(W, G, 1000n)).toEqual({ out: 4330n, fee: 3000 });
    expect(await q.quote(W, G, 1000n)).toEqual({ out: 4330n, fee: 3000 });
    // The reverse direction reuses the pair's pool lookup.
    expect(await q.quote(G, W, 50n)).toEqual({ out: 11n, fee: 3000 });
    expect(calls.filter((c) => c.data?.includes('ExistsPoolPath'))).toHaveLength(4);
    expect(await q.quote(W, W, 5n)).toBeNull();
  });

  it('stops quoting past its limit and says so', async () => {
    const { fetch } = fakeFetch({});
    const q = new GnoSwapQuoter(new GnoRpc({ fetch, sleep: noSleep }), { maxQuotes: 0 });
    expect(await q.quote(W, G, 1n)).toBeNull();
    expect(q.truncated).toBe(true);
  });
});

describe('findBridgedRings', () => {
  // Ann gives 100 OBOL and wants at least 400 GNS. Bo gives 100 wugnot and
  // wants 100 OBOL. GnoSwap turns Bo's 100 wugnot into 433 GNS for Ann.
  const OBOL = TOKENS.OBOL;
  const book = [offer(1, 'ann', tok(OBOL, 100), tok(G, 400)), offer(2, 'bo', tok(W, 100), tok(OBOL, 100))];

  it('finds a two-offer ring through the pool, with the swap on the closing hop', async () => {
    quotes.length = 0;
    const res = await findBridgedRings(book, fakeQuote);
    expect(res.rings).toEqual([
      {
        ids: [1, 2],
        bridgedHop: 1,
        bridge: { fromOffer: 2, toOffer: 1, tokenIn: W, tokenOut: G, amountIn: 100n, wantMin: 400n, expectedOut: 433n, fee: 3000 },
      },
    ]);
    expect(quotes).toEqual([`${W}>${G}:100`]);
    expect(verifyRing(res.rings[0]!, book)).toBeNull();
    expect(findRings(book).rings).toEqual([]);
  });

  it('keeps no ring when the quote is below the minimum', async () => {
    const greedy = [offer(1, 'ann', tok(OBOL, 100), tok(G, 500)), book[1]!];
    expect((await findBridgedRings(greedy, fakeQuote)).rings).toEqual([]);
  });

  it('rotates a longer ring so the smallest id is first and moves the hop with it', async () => {
    // The walk starts at 7, the only offer that wants a token: 7 -> 3 -> 5, then 5's wugnot is swapped for 7's GNS.
    const three = [
      offer(7, 'cy', relic('relic-2'), tok(G, 400)),
      offer(3, 'di', tok(OBOL, 10), relic('relic-2')),
      offer(5, 'ed', tok(W, 100), tok(OBOL, 10)),
    ];
    const collections = [
      { key: 'gno.land/r/nym-kylix000/kylixdemo', name: 'Kylix Relics', adapter: false, target: '', official: true, label: 'official collection', approvalCheck: true },
    ];
    expect((await findBridgedRings(three, fakeQuote)).stats.skippedUnofficial).toBe(2);
    const res = await findBridgedRings(three, fakeQuote, { collections });
    expect(res.rings).toHaveLength(1);
    const r = res.rings[0]!;
    expect(r.ids).toEqual([3, 5, 7]);
    expect(r.bridge).toMatchObject({ fromOffer: 5, toOffer: 7, expectedOut: 433n });
    expect(r.bridgedHop).toBe(1);
    expect(verifyRing(r, three)).toBeNull();
  });

  it('skips offer sets already settled directly', async () => {
    const direct: Ring[] = [{ ids: [1, 2] }];
    expect((await findBridgedRings(book, fakeQuote, { direct })).rings).toEqual([]);
  });

  it('treats a failing quote as no pool', async () => {
    const res = await findBridgedRings(book, async () => {
      throw new Error('429');
    });
    expect(res.rings).toEqual([]);
  });
});

describe('bridged rings downstream', () => {
  const bridged: Ring = {
    ids: [1, 2],
    bridgedHop: 1,
    bridge: { fromOffer: 2, toOffer: 1, tokenIn: W, tokenOut: G, amountIn: 100n, wantMin: 400n, expectedOut: 433n, fee: 3000 },
  };
  const book = [offer(1, 'ann', tok(TOKENS.OBOL, 100), tok(G, 400)), offer(2, 'bo', tok(W, 100), tok(TOKENS.OBOL, 100))];

  it('verifyRing checks the quote against the offers', () => {
    expect(verifyRing({ ...bridged, bridge: { ...bridged.bridge!, expectedOut: 399n } }, book)).toMatch(/below the minimum/);
    expect(verifyRing({ ...bridged, bridge: { ...bridged.bridge!, amountIn: 99n } }, book)).toMatch(/does not match/);
    expect(verifyRing({ ids: [1, 2], bridgedHop: 1 }, book)).toMatch(/no quote/);
    expect(verifyRing({ ...bridged, bridgedHop: 5 }, book)).toMatch(/out of range/);
  });

  it('selectRings prefers a direct ring of the same length', () => {
    const direct: Ring = { ids: [3, 4] };
    expect(selectRings([bridged, direct])).toEqual([direct, bridged]);
    const overlapping: Ring = { ids: [1, 9] };
    expect(selectRings([bridged, overlapping])).toEqual([overlapping]);
  });

  it('settles through the quoted pool with SettleRingVia', () => {
    const p = buildSettle({ caller: '', offers: book, bridge: { hop: bridged.bridgedHop!, feeTier: bridged.bridge!.fee } });
    expect(p.messages[0]!.value).toMatchObject({ func: 'SettleRingVia', args: ['1,2', '3000'] });
  });
});
