import { describe, expect, it } from 'vitest';
import { errorText, idleTx, isBusy, txReducer, txSentence } from '../../src/app/txState.ts';
import type { TxEvent, TxState } from '../../src/app/txState.ts';
import { WalletError } from '../../src/lib/wallet.ts';
import { RpcError, VmError } from '../../src/lib/rpc.ts';

const meta = { label: 'Settle ring 4, 5, 6' };
const run = (...events: TxEvent[]): TxState => events.reduce(txReducer, idleTx);

describe('txReducer', () => {
  it('goes preparing, signing, landed', () => {
    let s = run({ type: 'start', meta });
    expect(s.phase).toBe('preparing');
    s = txReducer(s, { type: 'built' });
    expect(s.phase).toBe('signing');
    s = txReducer(s, { type: 'landed', hash: 'abc', height: 10 });
    expect(s).toEqual({ phase: 'landed', meta, hash: 'abc', height: 10 });
    expect(isBusy(s)).toBe(false);
  });

  it('goes through sent when the wallet did not wait for the block', () => {
    const s = run({ type: 'start', meta }, { type: 'built' }, { type: 'sent', hash: 'h' });
    expect(s).toEqual({ phase: 'sent', meta, hash: 'h' });
    expect(isBusy(s)).toBe(true);
    expect(txReducer(s, { type: 'landed', hash: 'h', height: 5 }).phase).toBe('landed');
  });

  it('fails from any busy phase and keeps the hash', () => {
    expect(run({ type: 'start', meta }, { type: 'failed', message: 'no' })).toEqual({ phase: 'failed', meta, message: 'no' });
    expect(run({ type: 'start', meta }, { type: 'built' }, { type: 'sent', hash: 'h' }, { type: 'failed', message: 'x', hash: 'h' })).toMatchObject({
      phase: 'failed',
      hash: 'h',
    });
  });

  it('ignores a second start while one is running, and events out of order', () => {
    const s = run({ type: 'start', meta }, { type: 'built' });
    expect(txReducer(s, { type: 'start', meta: { label: 'other' } })).toBe(s);
    expect(txReducer(s, { type: 'dismiss' })).toBe(s);
    expect(run({ type: 'built' })).toBe(idleTx);
    expect(run({ type: 'landed', hash: 'x' })).toBe(idleTx);
    expect(run({ type: 'start', meta }, { type: 'sent', hash: 'x' }).phase).toBe('preparing');
  });

  it('starts again after a result, and dismiss clears a result', () => {
    const done = run({ type: 'start', meta }, { type: 'built' }, { type: 'landed', hash: 'h' });
    expect(txReducer(done, { type: 'dismiss' })).toBe(idleTx);
    expect(txReducer(done, { type: 'start', meta: { label: 'Cancel offer 4' } }).phase).toBe('preparing');
  });
});

describe('txSentence', () => {
  it('says what is happening', () => {
    expect(txSentence(run({ type: 'start', meta }, { type: 'built' }))).toBe('Settle ring 4, 5, 6: waiting for your signature in the wallet.');
    expect(txSentence(run({ type: 'start', meta }, { type: 'built' }, { type: 'landed', hash: 'h', height: 1427900 }))).toBe(
      'Settle ring 4, 5, 6: done, in block 1,427,900.',
    );
    expect(txSentence(idleTx)).toBe('');
  });
});

describe('errorText', () => {
  it('words wallet errors plainly', () => {
    expect(errorText(new WalletError('rejected', 'User rejected', 'TRANSACTION_REJECTED', 4000))).toMatch(/declined/);
    expect(errorText(new WalletError('failed', 'insufficient allowance', 'TRANSACTION_FAILED', 4001))).toBe('The chain refused it: insufficient allowance');
    expect(errorText(new WalletError('busy', '', 'UNRESOLVED_TRANSACTION_EXISTS'))).toMatch(/already has a request open/);
  });
  it('words chain and network errors', () => {
    expect(errorText(new VmError('offer 9 not open', 'detail'))).toBe('The chain refused it: offer 9 not open');
    expect(errorText(new RpcError('HTTP 429', 'http', 429))).toMatch(/busy/);
    expect(errorText(new Error('plain'))).toBe('plain');
  });
});
