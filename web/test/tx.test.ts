import { describe, expect, it } from 'vitest';
import {
  approveMessage,
  buildApproveAndPost,
  buildCancel,
  buildClaim,
  buildPost,
  buildPrune,
  buildSettle,
  minFee,
  settleGasWanted,
  settleMaxDeposit,
  withCaller,
} from '../src/lib/tx.ts';
import type { Asset, Offer } from '../src/lib/kylix.ts';
import { TOKENS } from '../src/lib/config.ts';

const K = 'gno.land/r/nym-kylix000/kylix';
const D = 'gno.land/r/nym-kylix000/kylixdemo';
const ME = 'g1wpca5kqm5xgqm27etsaq994z9tc0cl7m33vxds';
const SLOT = 'g1eceszdt9lt3adywvmy42sj4j8dt0e46negrc4j';

const tok = (key: string, amount: number): Asset => ({ kind: 'fungible', key, id: '', amount: BigInt(amount) });
const relic = (id: string): Asset => ({ kind: 'item', key: D, id, amount: 0n });
const offer = (id: number, give: Asset, want: Asset): Offer => ({ id, owner: ME, nonce: 1, give, want, expiry: 0, viaSession: false });

describe('fees', () => {
  it('is gas wanted / 1,000, rounded up', () => {
    expect(minFee(35_000_000)).toBe(35_000);
    expect(minFee(1_001)).toBe(2);
  });
});

describe('buildClaim', () => {
  it('calls kylixdemo.Claim with no args', () => {
    const p = buildClaim(ME);
    expect(p.messages).toEqual([
      { type: '/vm.m_call', value: { caller: ME, send: '', max_deposit: '1500000ugnot', pkg_path: D, func: 'Claim', args: [] } },
    ]);
    expect(p.gasWanted).toBe(20_000_000);
    expect(p.gasFee).toBe(20_000);
    expect(p.maxDeposit).toBe(1_500_000n);
  });
});

describe('buildApproveAndPost', () => {
  it('approves exactly the offered OBOL to the slot, then posts, in one transaction', () => {
    const p = buildApproveAndPost({
      caller: ME,
      give: tok(TOKENS.OBOL, 100),
      want: tok(TOKENS.DRACHMA, 50),
      nonce: 2,
      slot: SLOT,
      route: { kind: 'kylixdemo', pkgPath: D, symbol: 'OBOL' },
    });
    expect(p.messages.map((m) => [m.value.pkg_path, m.value.func, m.value.args])).toEqual([
      [D, 'Approve', ['OBOL', SLOT, '100']],
      // The exact args of offer 4's PostIntent on onyx-1 (tx zvKhbvmW...).
      [K, 'PostIntent', ['fungible', TOKENS.OBOL, '', '100', 'fungible', TOKENS.DRACHMA, '', '50', '0']],
    ]);
    expect(p.messages.map((m) => m.value.max_deposit)).toEqual(['500000ugnot', '1500000ugnot']);
    expect(p.gasWanted).toBe(45_000_000);
    expect(p.gasFee).toBe(45_000);
    expect(p.maxDeposit).toBe(2_000_000n);
    expect(p.summary).toContain(TOKENS.OBOL);
  });

  it('approves a relic by id', () => {
    const p = buildApproveAndPost({
      caller: ME,
      give: relic('relic-2'),
      want: tok(TOKENS.OBOL, 100),
      nonce: 3,
      slot: SLOT,
      route: { kind: 'relic', pkgPath: D },
      expiry: 1_500_000,
    });
    expect(p.messages[0]!.value).toMatchObject({ pkg_path: D, func: 'ApproveRelic', args: [SLOT, 'relic-2'] });
    expect(p.messages[1]!.value.args).toEqual(['item', D, 'relic-2', '0', 'fungible', TOKENS.OBOL, '', '100', '1500000']);
  });

  it('approves wugnot or GNS at the token realm', () => {
    const p = buildApproveAndPost({
      caller: ME,
      give: tok(TOKENS.WUGNOT, 1_000_000),
      want: tok(TOKENS.OBOL, 10),
      nonce: 1,
      slot: SLOT,
      route: { kind: 'spender-amount', pkgPath: 'gno.land/r/gnoland/wugnot' },
    });
    expect(p.messages[0]!.value).toMatchObject({ pkg_path: 'gno.land/r/gnoland/wugnot', func: 'Approve', args: [SLOT, '1000000'] });
  });

  it('approves the adapter address when one is given', () => {
    const target = 'g1hq2jzq39snc8vxumhmkdrpr4udjukcxck0lpgj';
    const p = buildApproveAndPost({
      caller: ME, give: relic('relic-1'), want: tok(TOKENS.OBOL, 1), nonce: 1, slot: SLOT, approveTarget: target,
      route: { kind: 'relic', pkgPath: D },
    });
    expect(p.messages[0]!.value.args[0]).toBe(target);
  });

  it('refuses what the realm would refuse', () => {
    const base = { caller: ME, nonce: 1, slot: SLOT, route: { kind: 'kylixdemo', pkgPath: D, symbol: 'OBOL' } as const };
    expect(() => buildApproveAndPost({ ...base, give: tok(TOKENS.OBOL, 0), want: tok(TOKENS.DRACHMA, 1) })).toThrow(/amount above 0/);
    expect(() => buildApproveAndPost({ ...base, give: tok(TOKENS.OBOL, 5), want: tok(TOKENS.OBOL, 1) })).toThrow(/cannot give the asset it wants/);
    expect(() => buildApproveAndPost({ ...base, give: tok(TOKENS.DRACHMA, 5), want: tok(TOKENS.OBOL, 1) })).toThrow(/route does not match/);
    expect(() => buildApproveAndPost({ ...base, slot: 'nope', give: tok(TOKENS.OBOL, 5), want: tok(TOKENS.DRACHMA, 1) })).toThrow(/invalid approve target/);
    expect(() =>
      buildApproveAndPost({ ...base, route: { kind: 'relic', pkgPath: D }, give: relic('bad id!'), want: tok(TOKENS.OBOL, 1) }),
    ).toThrow(/item id/);
  });

  it('can post alone', () => {
    const p = buildPost(ME, relic('x'), tok(TOKENS.OBOL, 1));
    expect(p.messages).toHaveLength(1);
    expect(p.gasWanted).toBe(35_000_000);
  });
});

describe('approving an MNS name', () => {
  const A = 'gno.land/r/nym-kylix000/adapters/nsnft';
  const L = 'gno.land/r/nym-mnsrehearsal001/nsnft/v2';
  const name: Asset = { kind: 'item', key: A, id: 'alice*gno', amount: 0n };
  it('calls the ledger’s Approve(to, name) for the one name', () => {
    expect(approveMessage(ME, name, SLOT, { kind: 'mns', pkgPath: L, adapter: A }).value).toMatchObject({
      pkg_path: L,
      func: 'Approve',
      args: [SLOT, 'alice*gno'],
      max_deposit: '500000ugnot',
    });
  });
  it('refuses a route for another collection or a token', () => {
    expect(() => approveMessage(ME, { ...name, key: D }, SLOT, { kind: 'mns', pkgPath: L, adapter: A })).toThrow(/collection/);
    expect(() => approveMessage(ME, tok(TOKENS.OBOL, 1), SLOT, { kind: 'mns', pkgPath: L, adapter: A })).toThrow(/item/);
  });
});

describe('buildSettle', () => {
  const ring = [offer(4, tok(TOKENS.OBOL, 100), tok(TOKENS.DRACHMA, 50)), offer(5, relic('relic-1'), tok(TOKENS.OBOL, 100)), offer(6, tok(TOKENS.DRACHMA, 50), relic('relic-1'))];

  it('sizes gas and deposit as the solver does', () => {
    expect(settleGasWanted(ring)).toBe(25_000_000 + 5_000_000 + 25_000_000 + 5_000_000);
    expect(settleMaxDeposit(ring)).toBe(250_000n + 100_000n + 250_000n);
    expect(settleGasWanted(ring.slice(0, 2), true)).toBe(25_000_000 + 5_000_000 + 25_000_000 + 150_000_000);
    expect(settleMaxDeposit([ring[1]!, ring[1]!], 0)).toBe(250_000n + 100_000n + 250_000n);
  });

  it('calls SettleRing for a direct ring', () => {
    const p = buildSettle({ caller: ME, offers: ring });
    expect(p.messages[0]!.value).toEqual({ caller: ME, send: '', max_deposit: '600000ugnot', pkg_path: K, func: 'SettleRing', args: ['4,5,6'] });
    expect(p.gasWanted).toBe(60_000_000);
    expect(p.gasFee).toBe(60_000);
  });

  it('calls SettleRingVia with the pool for a ring with a GnoSwap hop', () => {
    const p = buildSettle({ caller: ME, offers: ring.slice(0, 2), bridge: { hop: 1, feeTier: 3000 } });
    expect(p.messages[0]!.value).toMatchObject({ func: 'SettleRingVia', args: ['4,5', '3000'], max_deposit: '750000ugnot' });
    expect(() => buildSettle({ caller: ME, offers: ring, bridge: { hop: 0, feeTier: 42 } })).toThrow(/fee tier/);
    expect(() => buildSettle({ caller: ME, offers: ring.slice(0, 1) })).toThrow(/2 to 6/);
  });
});

describe('cancel, prune and caller', () => {
  it('builds cancel and prune', () => {
    expect(buildCancel(ME, 7).messages[0]!.value).toMatchObject({ func: 'CancelIntent', args: ['7'], max_deposit: '500000ugnot' });
    expect(buildCancel(ME, 7).gasWanted).toBe(15_000_000);
    expect(buildPrune(ME, 8).messages[0]!.value).toMatchObject({ func: 'PruneIntent', args: ['8'] });
    expect(() => buildCancel(ME, 0)).toThrow();
  });

  it('leaves the caller empty for the wallet to fill, and fills it', () => {
    const p = buildClaim('');
    expect(p.messages[0]!.value.caller).toBe('');
    expect(withCaller(p, ME).messages[0]!.value.caller).toBe(ME);
    expect(() => buildClaim('g1bad')).toThrow(/invalid caller/);
  });
});
