import { describe, expect, it } from 'vitest';
import { MNS_ITEM, OTHER_TOKEN, emptyForm, validTokenKey, validateOffer } from '../../src/app/offerForm.ts';
import type { OfferForm } from '../../src/app/offerForm.ts';
import { LIMITS, PATHS, TOKENS } from '../../src/lib/config.ts';

const H = 1_427_802;
const form = (over: Partial<OfferForm>): OfferForm => ({ ...emptyForm(), ...over });

describe('validateOffer', () => {
  it('accepts a token for a token, with the realm default expiry', () => {
    const r = validateOffer(form({ giveAmount: '100', wantAmount: '50' }), { height: H });
    expect(r).toEqual({
      ok: true,
      give: { kind: 'fungible', key: TOKENS.OBOL, id: '', amount: 100n },
      want: { kind: 'fungible', key: TOKENS.DRACHMA, id: '', amount: 50n },
      expiry: 0,
    });
  });

  it('turns a number of days into an expiry height', () => {
    const r = validateOffer(form({ giveAmount: '1', wantAmount: '1', expiryDays: '30' }), { height: H });
    expect(r).toMatchObject({ ok: true, expiry: H + LIMITS.maxExpiryBlocks });
    expect(validateOffer(form({ giveAmount: '1', wantAmount: '1', expiryDays: '31' }), { height: H })).toMatchObject({
      ok: false,
      errors: { expiryDays: expect.any(String) },
    });
    expect(validateOffer(form({ giveAmount: '1', wantAmount: '1', expiryDays: '3' }), { height: 0 })).toMatchObject({ ok: false });
  });

  it('uses the token decimals: GNS takes up to 6', () => {
    const r = validateOffer(form({ giveAmount: '5', wantToken: TOKENS.GNS, wantAmount: '0.5' }), { height: H });
    expect(r).toMatchObject({ ok: true, want: { amount: 500_000n } });
  });

  it('reports every bad field at once', () => {
    const r = validateOffer(form({ giveAmount: '', wantAmount: '-3' }), { height: H });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errors.giveAmount).toBeTruthy();
      expect(r.errors.wantAmount).toBeTruthy();
    }
  });

  it('refuses giving more than the account holds', () => {
    const balances = new Map<string, bigint | null>([[TOKENS.OBOL, 10n]]);
    const r = validateOffer(form({ giveAmount: '100', wantAmount: '1' }), { height: H, balances });
    expect(r).toMatchObject({ ok: false, errors: { giveAmount: 'You hold less than this amount.' } });
  });

  it('refuses the same asset on both sides, with the realm’s rule', () => {
    const r = validateOffer(form({ giveAmount: '1', wantToken: TOKENS.OBOL, wantAmount: '2' }), { height: H });
    expect(r).toMatchObject({ ok: false, errors: { form: 'an offer cannot give the asset it wants' } });
  });

  it('checks a typed token key', () => {
    expect(validTokenKey('gno.land/r/gnoland/wugnot.wugnot')).toBe(true);
    expect(validTokenKey('gno.land/r/gnoswap/v1/gns.GNS')).toBe(true);
    expect(validTokenKey('wugnot')).toBe(false);
    expect(validTokenKey('gno.land/p/demo/x.FOO')).toBe(false);
    expect(validTokenKey('gno.land/r/x.FOO"); evil')).toBe(false);
    const r = validateOffer(form({ giveToken: OTHER_TOKEN, giveTokenOther: 'OBOL', giveAmount: '1', wantAmount: '1' }), { height: H });
    expect(r).toMatchObject({ ok: false, errors: { giveTokenOther: expect.any(String) } });
    const ok = validateOffer(form({ giveToken: OTHER_TOKEN, giveTokenOther: ' gno.land/r/foo/bar.BAZ ', giveAmount: '7', wantAmount: '1' }), { height: H });
    expect(ok).toMatchObject({ ok: true, give: { key: 'gno.land/r/foo/bar.BAZ', amount: 7n } });
  });

  it('gives an item the account holds, for a token', () => {
    const items = [`${PATHS.kylixdemo}#relic-1`];
    const r = validateOffer(form({ giveKind: 'item', giveItem: items[0], wantAmount: '100', wantToken: TOKENS.OBOL }), { height: H, items });
    expect(r).toMatchObject({ ok: true, give: { kind: 'item', key: PATHS.kylixdemo, id: 'relic-1', amount: 0n } });
    const notMine = validateOffer(form({ giveKind: 'item', giveItem: `${PATHS.kylixdemo}#relic-9`, wantAmount: '1' }), { height: H, items });
    expect(notMine).toMatchObject({ ok: false, errors: { giveItem: 'You do not hold this item.' } });
    expect(validateOffer(form({ giveKind: 'item', wantAmount: '1' }), { height: H })).toMatchObject({ ok: false, errors: { giveItem: expect.any(String) } });
  });

  it('gives a typed MNS name through the nsnft adapter', () => {
    const ok = validateOffer(form({ giveKind: 'item', giveItem: MNS_ITEM, giveMnsName: ' alice*gno ', wantAmount: '10' }), { height: H, items: [] });
    expect(ok).toMatchObject({ ok: true, give: { kind: 'item', key: PATHS.adapterMns, id: 'alice*gno', amount: 0n } });
    for (const name of ['alice', '*gno', 'alice*', 'a*b*c', 'al ice*gno', '']) {
      expect(validateOffer(form({ giveKind: 'item', giveItem: MNS_ITEM, giveMnsName: name, wantAmount: '10' }), { height: H })).toMatchObject({
        ok: false,
        errors: { giveMnsName: expect.any(String) },
      });
    }
  });

  it('wants an item by collection and id, with the realm’s id rules', () => {
    const ok = validateOffer(form({ giveAmount: '50', wantKind: 'item', wantCollection: PATHS.kylixdemo, wantItemId: 'relic-1' }), { height: H });
    expect(ok).toMatchObject({ ok: true, want: { kind: 'item', key: PATHS.kylixdemo, id: 'relic-1', amount: 0n } });
    for (const id of ['', 'has space', 'x'.repeat(65), 'quote"']) {
      expect(validateOffer(form({ giveAmount: '50', wantKind: 'item', wantItemId: id }), { height: H })).toMatchObject({
        ok: false,
        errors: { wantItemId: expect.any(String) },
      });
    }
  });
});
