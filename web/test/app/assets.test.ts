import { describe, expect, it } from 'vitest';
import { assetName, assetPlain, blocksToText, displayText, formatUnits, parseUnits, shortAddress } from '../../src/app/assets.ts';
import { errorText } from '../../src/app/txState.ts';
import { VmError } from '../../src/lib/rpc.ts';
import { PATHS, TOKENS } from '../../src/lib/config.ts';
import type { Collection } from '../../src/lib/kylix.ts';

describe('formatUnits', () => {
  it('writes whole tokens with separators', () => {
    expect(formatUnits(1234567n, 0)).toBe('1,234,567');
  });
  it('places the decimal point and trims zeros', () => {
    expect(formatUnits(1_500_000n, 6)).toBe('1.5');
    expect(formatUnits(18_208_885n, 6)).toBe('18.208885');
    expect(formatUnits(2_000_000n, 6)).toBe('2');
    expect(formatUnits(5n, 6)).toBe('0.000005');
  });
});

describe('parseUnits', () => {
  it('reads whole numbers and decimals into base units', () => {
    expect(parseUnits('100', 0)).toEqual({ ok: true, value: 100n });
    expect(parseUnits(' 1,000 ', 0)).toEqual({ ok: true, value: 1000n });
    expect(parseUnits('1.5', 6)).toEqual({ ok: true, value: 1_500_000n });
    expect(parseUnits('.25', 6)).toEqual({ ok: true, value: 250_000n });
    expect(parseUnits('2.', 6)).toEqual({ ok: true, value: 2_000_000n });
  });
  it('refuses empty, zero, negative, junk and too many decimals', () => {
    for (const t of ['', '0', '0.0', '-5', '1e3', 'abc', '.', '1.2.3']) expect(parseUnits(t, 6).ok).toBe(false);
    expect(parseUnits('1.5', 0)).toMatchObject({ ok: false, error: expect.stringContaining('whole number') });
    expect(parseUnits('1.1234567', 6)).toMatchObject({ ok: false, error: expect.stringContaining('6 decimals') });
  });
  it('refuses amounts past int64', () => {
    expect(parseUnits('9223372036854775807', 0).ok).toBe(true);
    expect(parseUnits('9223372036854775808', 0).ok).toBe(false);
  });
});

describe('assetName', () => {
  const cols: Collection[] = [
    { key: PATHS.adapterMns, name: 'MNS Names (v2)', adapter: true, target: 'x', official: true, label: 'official adapter', approvalCheck: true },
    { key: 'gno.land/r/someone/cards', name: 'Kylix Relics', adapter: false, target: '', official: false, label: 'third-party collection', approvalCheck: false },
  ];

  it('names known tokens by symbol with a note', () => {
    expect(assetName({ kind: 'fungible', key: TOKENS.OBOL, id: '', amount: 100n })).toEqual({ main: '100 OBOL', note: 'demo token', unlisted: false });
    expect(assetName({ kind: 'fungible', key: TOKENS.GNS, id: '', amount: 1_500_000n }).main).toBe('1.5 GNS');
  });

  it('shows the full key of any other token, even one with a known symbol', () => {
    const fake = assetName({ kind: 'fungible', key: 'gno.land/r/evil/kylixdemo.OBOL', id: '', amount: 100n });
    expect(fake).toEqual({ main: '100 units', note: 'unlisted token', key: 'gno.land/r/evil/kylixdemo.OBOL', unlisted: true });
    expect(assetPlain({ kind: 'fungible', key: 'gno.land/r/evil/kylixdemo.OBOL', id: '', amount: 100n })).toContain('gno.land/r/evil/kylixdemo.OBOL');
  });

  it('names demo relics, registered collections and unknown ones', () => {
    expect(assetName({ kind: 'item', key: PATHS.kylixdemo, id: 'relic-1', amount: 0n }).note).toContain('Kylix Relics');
    expect(assetName({ kind: 'item', key: PATHS.adapterMns, id: 'alice', amount: 0n }, cols)).toMatchObject({
      main: 'alice',
      note: 'MNS Names (v2), official adapter',
      key: PATHS.adapterMns,
      unlisted: false,
    });
    // A third-party collection that borrows the demo's name is marked and shows its key.
    expect(assetName({ kind: 'item', key: 'gno.land/r/someone/cards', id: 'relic-1', amount: 0n }, cols)).toMatchObject({
      unlisted: true,
      key: 'gno.land/r/someone/cards',
    });
    expect(assetName({ kind: 'item', key: 'gno.land/r/nobody/x', id: '1', amount: 0n }, cols).note).toBe('unregistered collection');
  });
});

describe('small helpers', () => {
  it('shortens addresses', () => {
    expect(shortAddress('g1wpca5kqm5xgqm27etsaq994z9tc0cl7m33vxds')).toBe('g1wpca…vxds');
  });
  it('turns blocks into rough time', () => {
    expect(blocksToText(0)).toBe('now');
    expect(blocksToText(12)).toBe('about a minute');
    expect(blocksToText(720)).toBe('about 60 minutes');
    expect(blocksToText(17_280 * 7)).toBe('about 7 days');
  });
});

describe('displayText', () => {
  it('drops bidi controls and zero-width characters', () => {
    expect(displayText('abc\u202Efdp.exe')).toBe('abcfdp.exe');
    expect(displayText('\u2066Kylix\u2069 \u2067Relics\u2069')).toBe('Kylix Relics');
    expect(displayText('Ky\u200Blix\u200C\u200D\u2060\uFEFF')).toBe('Kylix');
    expect(displayText('a\u061Cb\u200E\u200Fc')).toBe('abc');
    expect(displayText('a\u0000b\u0007c\u009Bd\u00ADe')).toBe('abcde');
  });

  it('turns runs of odd spaces into one plain space', () => {
    const spoof = 'Kylix Relics (official collection)' + '\u00a0'.repeat(15);
    expect(displayText(spoof)).toBe('Kylix Relics (official collection)');
    expect(displayText('a\u2003\u2003b\u3000c\td\ne\u202Ff')).toBe('a b c d e f');
  });

  it('keeps ordinary text, other scripts and long runs as they are', () => {
    expect(displayText('relic-12')).toBe('relic-12');
    expect(displayText('Ἀθηνᾶ · שלום · 東京')).toBe('Ἀθηνᾶ · שלום · 東京');
    expect(displayText('A'.repeat(64))).toBe('A'.repeat(64));
  });

  it('is applied to names, keys and errors shown on the page', () => {
    const evil: Collection = {
      key: 'gno.land/r/evil/\u202Efake',
      name: 'Kylix Relics\u00a0\u00a0\u202E(official)',
      adapter: false,
      target: '',
      official: false,
      label: 'third-party collection',
      approvalCheck: true,
    };
    const n = assetName({ kind: 'item', key: evil.key, id: 'relic\u200B-1', amount: 0n }, [evil]);
    expect(n).toEqual({ main: 'relic-1', note: 'Kylix Relics (official), third-party collection', key: 'gno.land/r/evil/fake', unlisted: true });
    expect(errorText(new VmError('kylix: offer\u202E 4\u00a0\u00a0is not open', ''))).toBe('The chain refused it: kylix: offer 4 is not open');
  });
});
