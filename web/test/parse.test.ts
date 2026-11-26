import { describe, expect, it } from 'vitest';
import {
  goString,
  isAddress,
  parseQeval,
  qevalAddress,
  qevalBool,
  qevalInt,
  qevalIsUndefined,
  qevalString,
  textFromBase64,
  ugnotFromCoins,
  unquoteGo,
} from '../src/lib/parse.ts';
import offer4 from './fixtures/offer-4.json';
import nextSlot from './fixtures/next-slot.json';
import lastClaimNone from './fixtures/last-claim-none.json';

const data = (f: { result: { response: { ResponseBase: { Data: string | null } } } }) =>
  textFromBase64(f.result.response.ResponseBase.Data ?? '');

describe('parseQeval', () => {
  it('reads a struct and a bool (GetOffer, recorded on onyx-1)', () => {
    const vals = parseQeval(data(offer4));
    expect(vals).toHaveLength(2);
    const [s, ok] = vals;
    expect(s!.type).toBe('gno.land/r/nym-kylix000/kylix.Offer');
    expect(s!.fields!.map((f) => f.value).slice(0, 3)).toEqual(['4', 'g1wpca5kqm5xgqm27etsaq994z9tc0cl7m33vxds', '2']);
    expect(s!.fields![3]!.fields!.map((f) => f.value)).toEqual(['1', 'gno.land/r/nym-kylix000/kylixdemo.OBOL', '', '100']);
    expect(ok).toEqual({ type: 'bool', value: 'true' });
  });

  it('reads an integer and an address (NextSlot)', () => {
    const t = data(nextSlot);
    expect(qevalInt(t, 0)).toBe(1n);
    expect(qevalAddress(t, 1)).toBe('g1hq2jzq39snc8vxumhmkdrpr4udjukcxck0lpgj');
  });

  it('reads the empty address and empty strings', () => {
    expect(qevalAddress('( .uverse.address)')).toBe('');
    expect(qevalString('("" string)')).toBe('');
    expect(parseQeval('(struct{( string),(0 int64)} x.T)')[0]!.fields).toEqual([
      { type: 'string', value: '' },
      { type: 'int64', value: '0' },
    ]);
  });

  it('reads (undefined) from a missing map entry', () => {
    expect(qevalIsUndefined(data(lastClaimNone))).toBe(true);
    expect(qevalIsUndefined('(5 int64)')).toBe(false);
  });

  it('reads bools, negative ints and transaction result data', () => {
    expect(qevalBool('(false bool)')).toBe(false);
    expect(qevalInt('(-12 int64)')).toBe(-12n);
    // A PostIntent's deliver_tx data, as the indexer shows it.
    expect(parseQeval('(4 uint64)\n\n')).toEqual([{ type: 'uint64', value: '4' }]);
    expect(parseQeval('\n\n')).toEqual([]);
  });

  it('decodes a Go-quoted JSON string with escapes and parentheses inside', () => {
    const t = '("{\\"a\\":\\"x) (y\\",\\"b\\":\\"\\\\u003c\\"}" string)';
    expect(JSON.parse(qevalString(t))).toEqual({ a: 'x) (y', b: '<' }); // the realm escapes < as \u003c
  });

  it('throws on a type mismatch', () => {
    expect(() => qevalString('(1 int64)')).toThrow(/expected a string/);
    expect(() => qevalInt('("x" string)')).toThrow(/expected an integer/);
  });
});

describe('unquoteGo', () => {
  it('handles every Go escape', () => {
    expect(unquoteGo('"a\\tb\\nc\\\\d\\"e"')).toBe('a\tb\nc\\d"e');
    expect(unquoteGo('"\\x41\\101\\u00e9\\U0001F600"')).toBe('AAé😀');
    expect(unquoteGo('"\\xc3\\xa9"')).toBe('é'); // UTF-8 bytes
    expect(unquoteGo('"plain ✓ text"')).toBe('plain ✓ text');
  });

  it('rejects a bad escape', () => {
    expect(() => unquoteGo('"\\q"')).toThrow();
  });
});

describe('goString', () => {
  it('quotes so that Go reads back the same string', () => {
    for (const s of ['', 'abc', 'a"b', 'back\\slash', 'new\nline', 'é😀', '"); panic("x']) {
      expect(unquoteGo(goString(s))).toBe(s);
    }
  });

  it('refuses a lone surrogate', () => {
    expect(() => goString('\uD800')).toThrow(/surrogate/);
  });
});

describe('small helpers', () => {
  it('isAddress', () => {
    expect(isAddress('g1wpca5kqm5xgqm27etsaq994z9tc0cl7m33vxds')).toBe(true);
    expect(isAddress('g1wpca5kqm5xgqm27etsaq994z9tc0cl7m33vxdb')).toBe(false); // b is not bech32
    expect(isAddress('g1short')).toBe(false);
    expect(isAddress('g1wpca5kqm5xgqm27etsaq994z9tc0cl7m33vxds")')).toBe(false);
  });

  it('ugnotFromCoins', () => {
    expect(ugnotFromCoins('34668423ugnot')).toBe(34668423n);
    expect(ugnotFromCoins('5foo,12ugnot')).toBe(12n);
    expect(ugnotFromCoins('')).toBe(0n);
  });
});
