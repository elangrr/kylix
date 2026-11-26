import { describe, expect, it } from 'vitest';
import { links, prepareCancel, prepareClaim, preparePost, prepareSettle } from '../../src/app/actions.ts';
import type { ChainReads } from '../../src/app/actions.ts';
import { ringViews, safePicture } from '../../src/app/market.ts';
import { PATHS, TOKENS } from '../../src/lib/config.ts';
import type { ApproveRoute, Asset, DeliverableStatus, Offer } from '../../src/lib/kylix.ts';

const ME = 'g1wpca5kqm5xgqm27etsaq994z9tc0cl7m33vxds';
const SLOT = 'g1eceszdt9lt3adywvmy42sj4j8dt0e46negrc4j';
const SUB = 'g12v99cmsg0m4z0huyynhvp8elcapjeqvgv6l05f';
const UNREGISTERED = 'gno.land/r/gnoland/wugnot.WUGNOT';
const tok = (key: string, amount: bigint): Asset => ({ kind: 'fungible', key, id: '', amount });
const relic = (id: string): Asset => ({ kind: 'item', key: PATHS.kylixdemo, id, amount: 0n });

function fakeChain(over: Partial<ChainReads> = {}): ChainReads & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    approveRoute: async (a: Asset): Promise<ApproveRoute | null> => {
      calls.push(`route ${a.key}`);
      if (a.kind === 'item') {
        if (a.key === PATHS.adapterMns) return { kind: 'mns', pkgPath: PATHS.mnsLedger, adapter: PATHS.adapterMns };
        return a.key === PATHS.kylixdemo ? { kind: 'relic', pkgPath: PATHS.kylixdemo } : null;
      }
      return a.key.startsWith(PATHS.kylixdemo) ? { kind: 'kylixdemo', pkgPath: PATHS.kylixdemo, symbol: a.key.split('.').pop()! } : null;
    },
    nextSlot: async () => {
      calls.push('nextSlot');
      return { nonce: 3, slot: SLOT };
    },
    approveTarget: async () => {
      calls.push('approveTarget');
      return SUB;
    },
    tokenBalance: async (key: string) => {
      calls.push(`balance ${key}`);
      return key === UNREGISTERED ? null : 1_000n;
    },
    deliverable: async (ids: number[], opts?: { cacheMs?: number }) => {
      calls.push(`deliverable cacheMs=${opts?.cacheMs}`);
      return new Map(ids.map((id) => [id, { id, deliverable: true, reason: '' } as DeliverableStatus]));
    },
    faucetStatus: async () => ({ lastClaim: null, nextClaimHeight: 0, canClaimNow: true, height: 100 }),
    mnsName: async (name: string) => {
      calls.push(`mns ${name}`);
      return { name, owner: name === 'gone*gno' ? '' : ME, unmovable: name === 'short*gno' ? 'the lease on short*gno has less than 31 days left' : '' };
    },
    ...over,
  } as ChainReads & { calls: string[] };
}

describe('preparePost', () => {
  it('approves exactly the amount to the next slot, then posts, in one transaction', async () => {
    const c = fakeChain();
    const plan = await preparePost(c, { caller: ME, give: tok(TOKENS.OBOL, 100n), want: tok(TOKENS.DRACHMA, 50n), expiry: 0 });
    expect(c.calls).toEqual([`route ${TOKENS.OBOL}`, `balance ${TOKENS.OBOL}`, 'nextSlot']);
    expect(plan.messages.map((m) => [m.value.pkg_path, m.value.func, m.value.args])).toEqual([
      [PATHS.kylixdemo, 'Approve', ['OBOL', SLOT, '100']],
      [PATHS.kylix, 'PostIntent', ['fungible', TOKENS.OBOL, '', '100', 'fungible', TOKENS.DRACHMA, '', '50', '0']],
    ]);
    expect(plan.messages.every((m) => m.value.caller === ME && m.value.send === '')).toBe(true);
  });

  it('asks the realm which address to approve for an item', async () => {
    const c = fakeChain();
    const plan = await preparePost(c, { caller: ME, give: relic('relic-2'), want: tok(TOKENS.OBOL, 5n), expiry: 1_500_000 });
    expect(c.calls).toContain('approveTarget');
    expect(plan.messages[0]!.value).toMatchObject({ func: 'ApproveRelic', args: [SUB, 'relic-2'] });
    expect(plan.messages[1]!.value.args.at(-1)).toBe('1500000');
  });

  it('approves an MNS name on its ledger, to the adapter address, after checking it on chain', async () => {
    const c = fakeChain();
    const give: Asset = { kind: 'item', key: PATHS.adapterMns, id: 'alice*gno', amount: 0n };
    const plan = await preparePost(c, { caller: ME, give, want: tok(TOKENS.OBOL, 50n), expiry: 0 });
    expect(c.calls).toEqual([`route ${PATHS.adapterMns}`, 'mns alice*gno', 'nextSlot', 'approveTarget']);
    expect(plan.messages.map((m) => [m.value.pkg_path, m.value.func, m.value.args])).toEqual([
      [PATHS.mnsLedger, 'Approve', [SUB, 'alice*gno']],
      [PATHS.kylix, 'PostIntent', ['item', PATHS.adapterMns, 'alice*gno', '0', 'fungible', TOKENS.OBOL, '', '50', '0']],
    ]);
  });

  it('refuses an MNS name the caller does not hold, or one the adapter cannot move', async () => {
    const want = tok(TOKENS.OBOL, 1n);
    const name = (id: string): Asset => ({ kind: 'item', key: PATHS.adapterMns, id, amount: 0n });
    await expect(preparePost(fakeChain(), { caller: ME, give: name('gone*gno'), want, expiry: 0 })).rejects.toThrow('You do not hold the MNS name gone*gno.');
    await expect(preparePost(fakeChain(), { caller: ME, give: name('short*gno'), want, expiry: 0 })).rejects.toThrow(/less than 31 days left/);
  });

  it('checks the token is registered and held before the wallet opens', async () => {
    const tusd = 'gno.land/r/demo/tusd.tUSD';
    const c = fakeChain({ approveRoute: async () => ({ kind: 'spender-amount', pkgPath: 'gno.land/r/demo/tusd' }) });
    await expect(preparePost(c, { caller: ME, give: tok(tusd, 5_000n), want: tok(TOKENS.OBOL, 1n), expiry: 0 })).rejects.toThrow(
      `You hold 1,000 units of ${tusd}, less than the 5,000 units of ${tusd} this offer gives.`,
    );
    await expect(preparePost(c, { caller: ME, give: tok(UNREGISTERED, 5n), want: tok(TOKENS.OBOL, 1n), expiry: 0 })).rejects.toThrow(
      /No token is registered/,
    );
    expect(c.calls).not.toContain('nextSlot');
    await expect(preparePost(c, { caller: ME, give: tok(tusd, 1_000n), want: tok(TOKENS.OBOL, 1n), expiry: 0 })).resolves.toBeTruthy();
  });

  it('stops before the wallet when there is no known way to approve', async () => {
    await expect(
      preparePost(fakeChain(), { caller: ME, give: tok('gno.land/r/x/y.Z', 1n), want: tok(TOKENS.OBOL, 1n), expiry: 0 }),
    ).rejects.toThrow(/Approve/);
  });
});

describe('prepareSettle', () => {
  const offers: Offer[] = [
    { id: 4, owner: ME, nonce: 2, give: tok(TOKENS.OBOL, 100n), want: tok(TOKENS.DRACHMA, 50n), expiry: 0, viaSession: false },
    { id: 5, owner: SLOT, nonce: 2, give: relic('relic-1'), want: tok(TOKENS.OBOL, 100n), expiry: 0, viaSession: false },
    { id: 6, owner: SUB, nonce: 2, give: tok(TOKENS.DRACHMA, 50n), want: relic('relic-1'), expiry: 0, viaSession: false },
  ];

  it('builds SettleRing with the ids in ring order, after a Deliverable read that skips the cache', async () => {
    const c = fakeChain();
    const plan = await prepareSettle(c, ME, offers);
    expect(c.calls).toEqual(['deliverable cacheMs=0']);
    expect(plan.messages).toHaveLength(1);
    expect(plan.messages[0]!.value).toMatchObject({ pkg_path: PATHS.kylix, func: 'SettleRing', args: ['4,5,6'], caller: ME });
  });

  it('builds SettleRingVia for a bridged ring', async () => {
    const plan = await prepareSettle(fakeChain(), ME, offers, { hop: 1, feeTier: 3000 });
    expect(plan.messages[0]!.value).toMatchObject({ func: 'SettleRingVia', args: ['4,5,6', '3000'] });
  });

  it('quotes a swapped hop again and settles through the pool that pays most now', async () => {
    const W = TOKENS.WUGNOT;
    const G = TOKENS.GNS;
    const ring: Offer[] = [
      { id: 1, owner: ME, nonce: 1, give: tok(TOKENS.OBOL, 100n), want: tok(G, 400n), expiry: 0, viaSession: false },
      { id: 2, owner: SLOT, nonce: 1, give: tok(W, 100n), want: tok(TOKENS.OBOL, 100n), expiry: 0, viaSession: false },
    ];
    const plan = await prepareSettle(fakeChain(), ME, ring, { hop: 1, feeTier: 500 }, async () => ({ out: 433n, fee: 3000 }));
    expect(plan.messages[0]!.value).toMatchObject({ func: 'SettleRingVia', args: ['1,2', '3000'] });
    await expect(prepareSettle(fakeChain(), ME, ring, { hop: 1, feeTier: 3000 }, async () => ({ out: 399n, fee: 3000 }))).rejects.toThrow(
      /less than offer 1’s minimum of 0.0004 GNS/,
    );
    await expect(prepareSettle(fakeChain(), ME, ring, { hop: 1, feeTier: 3000 }, async () => null)).rejects.toThrow(/no pool/);
  });

  it('refuses a ring whose offer stopped being deliverable, with the realm’s reason', async () => {
    const c = fakeChain({
      deliverable: async (ids: number[]) =>
        new Map(ids.map((id) => [id, { id, deliverable: id !== 5, reason: id === 5 ? 'expired' : '' }])),
    });
    await expect(prepareSettle(c, ME, offers)).rejects.toThrow('Offer 5: expired.');
  });
});

describe('claim and cancel', () => {
  it('claims only when the faucet allows', async () => {
    expect((await prepareClaim(fakeChain(), ME)).messages[0]!.value.func).toBe('Claim');
    const c = fakeChain({ faucetStatus: async () => ({ lastClaim: 90, nextClaimHeight: 810, canClaimNow: false, height: 100 }) });
    await expect(prepareClaim(c, ME)).rejects.toThrow('810');
  });
  it('cancels by id', () => {
    expect(prepareCancel(ME, 4).messages[0]!.value).toMatchObject({ func: 'CancelIntent', args: ['4'] });
  });
});

describe('rings and links', () => {
  const o = (id: number): Offer => ({ id, owner: ME, nonce: 1, give: tok(TOKENS.OBOL, 1n), want: tok(TOKENS.DRACHMA, 1n), expiry: 0, viaSession: false });

  it('maps ring ids to offers and drops rings with a missing offer', () => {
    const v = ringViews([{ ids: [4, 5] }, { ids: [6, 7] }], [o(4), o(5), o(6)]);
    expect(v).toHaveLength(1);
    expect(v[0]).toMatchObject({ key: '4,5', ids: [4, 5] });
    expect(v[0]!.offers.map((x) => x.id)).toEqual([4, 5]);
  });

  it('accepts only a base64 SVG data URI as a picture', () => {
    expect(safePicture('data:image/svg+xml;base64,PHN2Zz4=')).toBe('data:image/svg+xml;base64,PHN2Zz4=');
    expect(safePicture('data:image/svg+xml,<svg onload=alert(1)>')).toBeNull();
    expect(safePicture('javascript:alert(1)')).toBeNull();
    expect(safePicture(null)).toBeNull();
  });

  it('links to the realm pages on the testnet', () => {
    expect(links.offer(4)).toBe('https://onyx.testnets.gno.land/r/nym-kylix000/kylix:offer/4');
    expect(links.ring([4, 5, 6])).toBe('https://onyx.testnets.gno.land/r/nym-kylix000/kylix:ring/4,5,6');
  });
});
