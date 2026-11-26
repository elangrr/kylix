// Reads the real Kylix realm on onyx-1 and checks the shapes. Sends nothing.
// The book changes, so these tests check structure, not particular offers.

import { beforeAll, describe, expect, it } from 'vitest';
import { CHAIN_ID, PATHS, TOKENS } from '../../src/lib/config.ts';
import { GnoRpc } from '../../src/lib/rpc.ts';
import { KylixClient } from '../../src/lib/kylix.ts';
import type { Graph } from '../../src/lib/kylix.ts';
import { findRings, verifyRing } from '../../src/lib/rings.ts';
import { buildSettle } from '../../src/lib/tx.ts';
import { isAddress, textFromBase64 } from '../../src/lib/parse.ts';
import { GnoSwapQuoter } from '../../src/lib/gnoswap.ts';

const rpc = new GnoRpc({ maxConcurrent: 2, cacheMs: 30_000 });
const k = new KylixClient(rpc);
let graph: Graph;

beforeAll(async () => {
  graph = await k.graph();
});

describe('onyx-1, read only', () => {
  it('the node is onyx-1', async () => {
    const s = await rpc.status();
    expect(s.chainId).toBe(CHAIN_ID);
    expect(s.height).toBeGreaterThan(1_400_000);
  });

  it('the book has the export shape', () => {
    expect(graph.realm).toBe(PATHS.kylix);
    expect(graph.height).toBeGreaterThan(0);
    expect(graph.total).toBeGreaterThanOrEqual(graph.offers.length);
    for (const o of graph.offers) {
      expect(o.id).toBeGreaterThan(0);
      expect(isAddress(o.owner)).toBe(true);
      expect(isAddress(o.slot!)).toBe(true);
      expect(['fungible', 'item']).toContain(o.give.kind);
      expect(typeof o.give.amount).toBe('bigint');
      expect(o.expiry).toBeGreaterThanOrEqual(graph.height);
    }
    const demo = graph.collections.find((c) => c.key === PATHS.kylixdemo);
    expect(demo).toMatchObject({ name: 'Kylix Relics', official: true, label: 'official collection' });
  });

  it('GetOffer agrees with the export', async () => {
    const first = graph.offers[0];
    if (!first) return; // empty book: nothing to compare
    const o = await k.offer(first.id);
    expect(o).toMatchObject({ id: first.id, owner: first.owner, nonce: first.nonce, give: first.give, want: first.want, expiry: first.expiry });
    expect(await k.offer(999_999_999)).toBeNull();
  });

  it('Deliverable answers for every id asked', async () => {
    const ids = graph.offers.slice(0, 5).map((o) => o.id).concat([999_999_999]);
    const d = await k.deliverable(ids);
    for (const id of ids) expect(d.has(id)).toBe(true);
    expect(d.get(999_999_999)).toEqual({ id: 999_999_999, deliverable: false, reason: 'not open' });
  });

  it('NextSlot gives a nonce and an address; SlotAddress agrees for an existing offer', async () => {
    const fresh = await k.nextSlot('g1jg8mtutu9khhfwc4nxmuhcpftf0pajdhfvsqf5');
    expect(fresh.nonce).toBeGreaterThanOrEqual(1);
    expect(isAddress(fresh.slot)).toBe(true);
    const first = graph.offers[0];
    if (first) {
      const target = await k.approveTarget(first.owner, first.nonce, first.give.key);
      expect(target).toBe(first.approve);
    }
  });

  it('every ring found in the book verifies, and the realm draws it', async () => {
    const found = findRings(graph.offers, { height: graph.height, collections: graph.collections });
    const byId = new Map(graph.offers.map((o) => [o.id, o]));
    for (const r of found.rings) expect(verifyRing(r, byId, graph.height)).toBeNull();
    const ring = found.rings[0];
    if (!ring) return; // no ring open right now
    const uri = await k.ringPicture(ring.ids);
    expect(uri).not.toBeNull();
    expect(textFromBase64(uri!.split(',')[1]!).startsWith('<svg')).toBe(true);
    const p = buildSettle({ caller: '', offers: ring.ids.map((id) => byId.get(id)!) });
    expect(p.messages[0]!.value.args[0]).toBe(ring.ids.join(','));
  });

  it('readyRings checks deliverability', async () => {
    const r = await k.readyRings(graph);
    for (const ring of r.rings) for (const id of ring.ids) expect(r.status.get(id)?.deliverable).toBe(true);
  });

  it('reads balances, token metadata, relics and the faucet', async () => {
    const owner = graph.offers[0]?.owner ?? 'g1wpca5kqm5xgqm27etsaq994z9tc0cl7m33vxds';
    const b = await k.demoBalances(owner);
    for (const key of [TOKENS.OBOL, TOKENS.DRACHMA, TOKENS.WUGNOT, TOKENS.GNS]) expect(typeof b.get(key)).toBe('bigint');
    expect(await k.tokenBalance('gno.land/r/nym-kylix000/nope.NOPE', owner)).toBeNull();
    expect(await k.gnotBalance(owner)).toBeGreaterThanOrEqual(0n);

    const obol = await k.tokenInfo(TOKENS.OBOL);
    expect(obol).toEqual({ key: TOKENS.OBOL, name: 'Obol', symbol: 'OBOL', decimals: 0 });

    const relics = await k.relicOwners();
    expect(relics.length).toBeGreaterThan(0);
    expect(relics[0]!.id).toBe('relic-1');
    expect(relics[0]!.owner).toBe(await k.relicOwner('relic-1'));

    const f = await k.faucetStatus(owner);
    expect(f.height).toBeGreaterThan(0);
    if (f.lastClaim !== null) expect(f.nextClaimHeight).toBe(f.lastClaim + 720);
  });

  it('knows how to approve the demo tokens, wugnot, GNS and relics', async () => {
    expect(await k.approveRoute({ kind: 'fungible', key: TOKENS.OBOL, id: '', amount: 1n })).toMatchObject({ kind: 'kylixdemo', symbol: 'OBOL' });
    expect(await k.approveRoute({ kind: 'fungible', key: TOKENS.WUGNOT, id: '', amount: 1n })).toEqual({ kind: 'spender-amount', pkgPath: PATHS.wugnot });
    expect(await k.approveRoute({ kind: 'fungible', key: TOKENS.GNS, id: '', amount: 1n })).toEqual({ kind: 'spender-amount', pkgPath: PATHS.gns });
    expect(await k.approveRoute({ kind: 'item', key: PATHS.kylixdemo, id: 'relic-1', amount: 0n })).toEqual({ kind: 'relic', pkgPath: PATHS.kylixdemo });
  });

  it('quotes the one GnoSwap pool on onyx-1, wugnot and GNS at fee 3000, both ways', async () => {
    const q = new GnoSwapQuoter(rpc);
    expect(await q.poolTiers(TOKENS.WUGNOT, TOKENS.GNS)).toEqual([3000]);
    const there = await q.quote(TOKENS.WUGNOT, TOKENS.GNS, 1_000_000n);
    expect(there?.fee).toBe(3000);
    expect(there!.out).toBeGreaterThan(0n);
    expect((await q.quote(TOKENS.GNS, TOKENS.WUGNOT, 1_000_000n))?.fee).toBe(3000);
    expect(await q.quote(TOKENS.OBOL, TOKENS.DRACHMA, 10n)).toBeNull();
  });

  it('asks the nsnft adapter about an MNS name that does not exist', async () => {
    const n = await k.mnsName('kylix-no-such-name*gno');
    expect(n.owner).toBe('');
    expect(n.unmovable).toMatch(/no record/);
  });

  it('kept the request count modest', () => {
    // Cache and de-duplication: a whole run should stay well under 100 requests.
    expect(rpc.requests).toBeLessThan(100);
  });
});
