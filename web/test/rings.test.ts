import { describe, expect, it } from 'vitest';
import { findRings, satisfies, selectRings, verifyRing } from '../src/lib/rings.ts';
import type { Ring } from '../src/lib/rings.ts';
import type { Asset, Offer } from '../src/lib/kylix.ts';
import { parseGraphPage } from '../src/lib/kylix.ts';
import { qevalString, textFromBase64 } from '../src/lib/parse.ts';
import graphPage from './fixtures/graph-page.json';

const tok = (key: string, amount: number): Asset => ({ kind: 'fungible', key, id: '', amount: BigInt(amount) });
const item = (key: string, id: string): Asset => ({ kind: 'item', key, id, amount: 0n });
const offer = (id: number, owner: string, give: Asset, want: Asset, expiry = 0): Offer => ({ id, owner, nonce: 1, give, want, expiry, viaSession: false });
const ids = (rings: Ring[]) => rings.map((r) => r.ids.join(',')).sort();

const [A, B, C, D, E, F, G] = ['a.AAA', 'b.BBB', 'c.CCC', 'd.DDD', 'e.EEE', 'f.FFF', 'g.GGG'] as const;
const COL1 = 'gno.land/r/kylixdemo/relics';
const COL2 = 'gno.land/r/other/cards';
const all = { officialOnly: false };

// The direct-ring cases of solver/ring/finder_test.go TestFindRings_TableDriven.
describe('findRings, the Go solver cases', () => {
  const cases: Array<[string, Offer[], string[], number?]> = [
    ['no ring', [offer(1, 'alice', tok(A, 100), tok(B, 100)), offer(2, 'bob', tok(B, 100), tok(C, 100))], []],
    ['2-ring fungible exact and surplus', [offer(10, 'alice', tok(A, 120), tok(B, 90)), offer(5, 'bob', tok(B, 100), tok(A, 100))], ['5,10']],
    ['2-ring item for fungible', [offer(1, 'alice', item(COL1, 'relic-7'), tok(A, 50)), offer(2, 'bob', tok(A, 50), item(COL1, 'relic-7'))], ['1,2']],
    [
      '6-ring accepted',
      [
        offer(1, 'u1', tok(A, 10), tok(F, 10)),
        offer(2, 'u2', tok(B, 10), tok(A, 10)),
        offer(3, 'u3', tok(C, 10), tok(B, 10)),
        offer(4, 'u4', tok(D, 10), tok(C, 10)),
        offer(5, 'u5', tok(E, 10), tok(D, 10)),
        offer(6, 'u6', tok(F, 10), tok(E, 10)),
      ],
      ['1,2,3,4,5,6'],
    ],
    [
      '7-cycle refused',
      [
        offer(1, 'u1', tok(A, 10), tok(G, 10)),
        offer(2, 'u2', tok(B, 10), tok(A, 10)),
        offer(3, 'u3', tok(C, 10), tok(B, 10)),
        offer(4, 'u4', tok(D, 10), tok(C, 10)),
        offer(5, 'u5', tok(E, 10), tok(D, 10)),
        offer(6, 'u6', tok(F, 10), tok(E, 10)),
        offer(7, 'u7', tok(G, 10), tok(F, 10)),
      ],
      [],
    ],
    ['same owner twice refused', [offer(1, 'alice', tok(A, 10), tok(C, 10)), offer(2, 'bob', tok(B, 10), tok(A, 10)), offer(3, 'alice', tok(C, 10), tok(B, 10))], []],
    ['amount below minimum refused', [offer(1, 'alice', tok(A, 99), tok(B, 100)), offer(2, 'bob', tok(B, 100), tok(A, 100))], []],
    ['item id mismatch refused', [offer(1, 'alice', item(COL1, 'relic-7'), tok(A, 50)), offer(2, 'bob', tok(A, 50), item(COL1, 'relic-8'))], []],
    ['collection key mismatch refused', [offer(1, 'alice', item(COL1, 'relic-7'), tok(A, 50)), offer(2, 'bob', tok(A, 50), item(COL2, 'relic-7'))], []],
    [
      'duplicate given item refused',
      [
        offer(1, 'alice', item(COL1, 'relic-1'), tok(A, 10)),
        offer(2, 'bob', tok(A, 10), item(COL1, 'relic-1')),
        offer(3, 'carol', item(COL1, 'relic-1'), tok(B, 10)),
        offer(4, 'dave', tok(B, 10), item(COL1, 'relic-1')),
      ],
      ['1,2', '3,4'],
    ],
    ['expired offer skipped', [offer(1, 'alice', tok(A, 10), tok(B, 10), 499), offer(2, 'bob', tok(B, 10), tok(A, 10), 500)], [], 500],
    ['offer expiring at current height still valid', [offer(1, 'alice', tok(A, 10), tok(B, 10), 500), offer(2, 'bob', tok(B, 10), tok(A, 10), 0)], ['1,2'], 500],
  ];
  for (const [name, offers, want, height] of cases) {
    it(name, () => {
      const r = findRings(offers, { ...all, height: height ?? 0, expiryMargin: 0 });
      expect(ids(r.rings)).toEqual(want);
      for (const ring of r.rings) expect(verifyRing(ring, offers, height ?? 0)).toBeNull();
    });
  }
});

describe('findRings, more', () => {
  it('finds ring 4,5,6 in the book recorded on onyx-1', () => {
    const p = parseGraphPage(qevalString(textFromBase64(graphPage.result.response.ResponseBase.Data)));
    const r = findRings(p.offers, { height: p.height, collections: p.collections! });
    expect(r.rings).toEqual([{ ids: [4, 5, 6] }]);
  });

  it('skips offers near expiry by the margin', () => {
    const offers = [offer(1, 'a', tok(A, 1), tok(B, 1), 105), offer(2, 'b', tok(B, 1), tok(A, 1), 200)];
    expect(findRings(offers, { ...all, height: 100 }).rings).toEqual([]); // 5 blocks left < 10
    expect(findRings(offers, { ...all, height: 100, expiryMargin: 0 }).rings).toHaveLength(1);
  });

  it('skips items of collections that are not official, unless asked', () => {
    const offers = [offer(1, 'a', item(COL2, 'x'), tok(A, 1)), offer(2, 'b', tok(A, 1), item(COL2, 'x'))];
    const cols = [{ key: COL2, name: 'Cards', adapter: false, target: '', official: false, label: 'third-party collection', approvalCheck: false }];
    const off = findRings(offers, { collections: cols });
    expect(off.rings).toEqual([]);
    expect(off.stats.skippedUnofficial).toBe(2);
    expect(findRings(offers, { collections: cols, officialOnly: false }).rings).toHaveLength(1);
  });

  it('lists each ring once, smallest id first', () => {
    const offers = [offer(9, 'a', tok(A, 1), tok(C, 1)), offer(3, 'b', tok(B, 1), tok(A, 1)), offer(5, 'c', tok(C, 1), tok(B, 1))];
    expect(findRings(offers, all).rings).toEqual([{ ids: [3, 5, 9] }]);
  });

  it('caps one owner per wanted asset and reports it', () => {
    const offers = [offer(1, 'a', tok(A, 1), tok(B, 1))];
    for (let i = 0; i < 6; i++) offers.push(offer(10 + i, 'spammer', tok(B, 1), tok(A, 1)));
    const r = findRings(offers, all);
    expect(r.rings).toHaveLength(4);
    expect(r.stats.truncatedReason).toBe('max_per_owner');
  });

  it('stays bounded on a large dense book', () => {
    const offers: Offer[] = [];
    for (let i = 1; i <= 400; i++) offers.push(offer(i, `u${i}`, tok(i % 2 ? A : B, 10), tok(i % 2 ? B : A, 10)));
    const t0 = Date.now();
    const r = findRings(offers, { ...all, maxRings: 500 });
    expect(Date.now() - t0).toBeLessThan(5_000);
    expect(r.rings.length).toBeLessThanOrEqual(500);
    expect(r.stats.truncated).toBe(true);
  });

  // Every ring found is valid, and on small books with no bounds the search
  // finds exactly the rings a brute-force enumeration finds.
  it('matches brute force on random small books', () => {
    let seed = 7;
    const rnd = (n: number) => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed % n;
    };
    const keys = [A, B, C];
    for (let round = 0; round < 200; round++) {
      const n = 2 + rnd(7);
      const offers: Offer[] = [];
      for (let i = 1; i <= n; i++) {
        const give = rnd(4) === 0 ? item(COL1, `r${rnd(3)}`) : tok(keys[rnd(3)]!, 1 + rnd(3));
        let want = rnd(4) === 0 ? item(COL1, `r${rnd(3)}`) : tok(keys[rnd(3)]!, 1 + rnd(3));
        if (give.kind === want.kind && give.key === want.key && give.id === want.id) want = tok('z.ZZZ', 1);
        offers.push(offer(i, `o${rnd(5)}`, give, want));
      }
      const got = ids(findRings(offers, { ...all, maxFanout: -1, maxSteps: -1, maxStepsPerStart: -1, maxRings: -1 }).rings);
      expect(got).toEqual(ids(bruteForce(offers)));
    }
  });
});

function bruteForce(offers: Offer[]): Ring[] {
  const out: Ring[] = [];
  const sorted = [...offers].sort((a, b) => a.id - b.id);
  const byId = new Map(sorted.map((o) => [o.id, o]));
  const walk = (path: Offer[]) => {
    if (path.length >= 2 && satisfies(path[path.length - 1]!.give, path[0]!.want)) {
      const r = { ids: path.map((o) => o.id) };
      if (verifyRing(r, byId) === null) out.push(r);
    }
    if (path.length === 6) return;
    for (const o of sorted) {
      if (o.id <= path[0]!.id || path.includes(o)) continue;
      if (satisfies(path[path.length - 1]!.give, o.want)) walk([...path, o]);
    }
  };
  for (const o of sorted) walk([o]);
  return out;
}

describe('verifyRing', () => {
  const book = [offer(1, 'a', tok(A, 10), tok(B, 5)), offer(2, 'b', tok(B, 5), tok(A, 10)), offer(3, 'a', tok(B, 5), tok(A, 10))];
  it('accepts a ring and names what is wrong otherwise', () => {
    expect(verifyRing({ ids: [1, 2] }, book)).toBeNull();
    expect(verifyRing({ ids: [1] }, book)).toMatch(/length 1/);
    expect(verifyRing({ ids: [1, 9] }, book)).toMatch(/offer 9 not found/);
    expect(verifyRing({ ids: [1, 3] }, book)).toMatch(/same owner/);
    expect(verifyRing({ ids: [1, 1] }, book)).toMatch(/duplicate offer/);
    expect(verifyRing({ ids: [2, 1] }, [offer(1, 'a', tok(A, 9), tok(B, 5)), offer(2, 'b', tok(B, 5), tok(A, 10))])).toMatch(/hop 1->0/);
    expect(verifyRing({ ids: [1, 2] }, [offer(1, 'a', tok(A, 10), tok(B, 5), 50), offer(2, 'b', tok(B, 5), tok(A, 10))], 51)).toMatch(/expired/);
  });
});

describe('selectRings', () => {
  it('takes longer rings first, then the oldest offers, with no offer twice', () => {
    const picked = selectRings([{ ids: [5, 6] }, { ids: [1, 2, 3] }, { ids: [3, 4] }, { ids: [2, 7] }, { ids: [8, 9] }]);
    expect(picked).toEqual([{ ids: [1, 2, 3] }, { ids: [5, 6] }, { ids: [8, 9] }]);
  });
});
