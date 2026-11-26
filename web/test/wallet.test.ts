import { describe, expect, it } from 'vitest';
import { AdenaWallet, MockWallet, WalletError, parseSendResult, postedOfferId } from '../src/lib/wallet.ts';
import type { AdenaInjected } from '../src/lib/wallet.ts';
import { buildClaim, buildCancel } from '../src/lib/tx.ts';
import { base64FromText } from '../src/lib/parse.ts';

const ME = 'g1wpca5kqm5xgqm27etsaq994z9tc0cl7m33vxds';
const OTHER = 'g1jg8mtutu9khhfwc4nxmuhcpftf0pajdhfvsqf5';

const ok = <D>(type: string, data: D) => ({ code: 0, status: 'success' as const, type, message: '', data });
const fail = (type: string, code: number, message: string, data: unknown = {}) => ({ code, status: 'failure' as const, type, message, data });

/** A stand-in for window.adena that records calls. Shapes from Adena 1.22.5's inject.ts. */
function fakeAdena(over: Partial<AdenaInjected> = {}) {
  const calls: Array<[string, unknown[]]> = [];
  const listeners: Record<string, Array<(v: string) => void>> = {};
  let chainId = 'onyx-1';
  const a: AdenaInjected = {
    version: '1.22.5',
    async AddEstablish(...args) {
      calls.push(['AddEstablish', args]);
      return fail('ALREADY_CONNECTED', 4001, 'The account is already connected to this website.');
    },
    async GetAccount() {
      calls.push(['GetAccount', []]);
      return ok('GET_ACCOUNT', { address: ME, chainId, coins: '5000000ugnot' });
    },
    async GetNetwork() {
      calls.push(['GetNetwork', []]);
      return ok('GET_NETWORK', { chainId, rpcUrl: 'https://rpc.onyx.testnets.gno.land:443' });
    },
    async SwitchNetwork(id) {
      calls.push(['SwitchNetwork', [id]]);
      chainId = id;
      return ok('SWITCH_NETWORK_SUCCESS', { chainId: id });
    },
    async AddNetwork(n) {
      calls.push(['AddNetwork', [n]]);
      return ok('ADD_NETWORK_SUCCESS', n);
    },
    async DoContract(params) {
      calls.push(['DoContract', [params]]);
      return ok('TRANSACTION_SUCCESS', {
        hash: 'hSQPeDIZAYMPwkWCHzyqb18WmasED8zIFvISLve1vDM=',
        height: '1422968',
        check_tx: { ResponseBase: { Error: null, Data: null, Log: '' }, GasWanted: '45000000', GasUsed: '0' },
        deliver_tx: { ResponseBase: { Error: null, Data: base64FromText('\n\n(7 uint64)\n\n'), Log: '' }, GasWanted: '45000000', GasUsed: '26000000' },
      });
    },
    On(event, cb) {
      (listeners[event] ??= []).push(cb);
      return true;
    },
    ...over,
  };
  return { a, calls, listeners, setChain: (c: string) => (chainId = c) };
}

describe('AdenaWallet', () => {
  it('reports when Adena is missing', async () => {
    const w = new AdenaWallet({ getAdena: () => undefined });
    expect(w.isInstalled()).toBe(false);
    await expect(w.connect('Kylix')).rejects.toMatchObject({ kind: 'not-installed' });
  });

  it('connects (ALREADY_CONNECTED counts) and reads the account', async () => {
    const f = fakeAdena();
    const w = new AdenaWallet({ getAdena: () => f.a });
    expect(await w.connect('Kylix')).toEqual({ address: ME, chainId: 'onyx-1', coins: '5000000ugnot' });
    expect(f.calls[0]).toEqual(['AddEstablish', ['Kylix']]);
  });

  it('a refused connection is a rejected error', async () => {
    const f = fakeAdena({ AddEstablish: async () => fail('CONNECTION_REJECTED', 4000, 'The connection request has been rejected by the user.') });
    await expect(new AdenaWallet({ getAdena: () => f.a }).connect('Kylix')).rejects.toMatchObject({ kind: 'rejected', type: 'CONNECTION_REJECTED' });
  });

  it('a locked wallet has no account', async () => {
    const f = fakeAdena({ GetAccount: async () => fail('WALLET_LOCKED', 2000, 'Adena is locked.', null) as never });
    expect(await new AdenaWallet({ getAdena: () => f.a }).account()).toBeNull();
  });

  it('switches to onyx-1, adding it first when the wallet does not know it', async () => {
    const f = fakeAdena();
    f.setChain('gnoland-1');
    let first = true;
    f.a.SwitchNetwork = async (id) => {
      f.calls.push(['SwitchNetwork', [id]]);
      if (first) {
        first = false;
        return fail('UNADDED_NETWORK', 4001, 'The network has not been added on Adena.');
      }
      f.setChain(id);
      return ok('SWITCH_NETWORK_SUCCESS', { chainId: id });
    };
    await new AdenaWallet({ getAdena: () => f.a }).ensureNetwork();
    expect(f.calls.map((c) => c[0])).toEqual(['GetNetwork', 'SwitchNetwork', 'AddNetwork', 'SwitchNetwork', 'GetNetwork']);
    expect(f.calls[2]![1]).toEqual([{ chainId: 'onyx-1', chainName: 'Gno.land Onyx testnet', rpcUrl: 'https://rpc.onyx.testnets.gno.land:443' }]);
  });

  it('does nothing when already on onyx-1', async () => {
    const f = fakeAdena();
    await new AdenaWallet({ getAdena: () => f.a }).ensureNetwork();
    expect(f.calls.map((c) => c[0])).toEqual(['GetNetwork']);
  });

  it('signs every message in one DoContract, fills the caller, asks for the block', async () => {
    const f = fakeAdena();
    const w = new AdenaWallet({ getAdena: () => f.a });
    const p = buildClaim('');
    const r = await w.signAndSend(p);
    const [, [params]] = f.calls.find((c) => c[0] === 'DoContract')! as [string, [Record<string, unknown>]];
    expect(params).toMatchObject({ gasWanted: 20_000_000, gasFee: 20_000, commit: true });
    expect((params.messages as Array<{ value: { caller: string } }>)[0]!.value.caller).toBe(ME);
    expect(r).toMatchObject({ committed: true, height: 1422968, gasUsed: 26000000 });
    expect(postedOfferId(r)).toBe(7);
  });

  it('refuses a plan made for another account, and a wrong network', async () => {
    const f = fakeAdena();
    const w = new AdenaWallet({ getAdena: () => f.a });
    await expect(w.signAndSend(buildCancel(OTHER, 1))).rejects.toMatchObject({ kind: 'wrong-account' });
    f.setChain('gnoland-1');
    await expect(w.signAndSend(buildCancel(ME, 1))).rejects.toMatchObject({ kind: 'wrong-network' });
    expect(f.calls.some((c) => c[0] === 'DoContract')).toBe(false);
  });

  it('maps a rejection and a chain failure', async () => {
    const rejected = fakeAdena({ DoContract: async () => fail('TRANSACTION_REJECTED', 4000, 'The transaction has been rejected by the user.') });
    await expect(new AdenaWallet({ getAdena: () => rejected.a }).signAndSend(buildClaim(ME))).rejects.toMatchObject({ kind: 'rejected' });

    const failed = fakeAdena({
      DoContract: async () =>
        fail('TRANSACTION_FAILED', 4001, 'Adena could not execute the transaction.', {
          hash: 'x',
          error: 'VM call panic: kylixdemo: already claimed; claim again from height 1423677\nStacktrace:\npanic: kylixdemo: already claimed; claim again from height 1423677\n...',
        }),
    });
    const e = await new AdenaWallet({ getAdena: () => failed.a }).signAndSend(buildClaim(ME)).catch((x) => x);
    expect(e).toBeInstanceOf(WalletError);
    expect(e.kind).toBe('failed');
    expect(e.message).toBe('kylixdemo: already claimed; claim again from height 1423677');
  });

  it('registers each event once with Adena and fans out', () => {
    const f = fakeAdena();
    const w = new AdenaWallet({ getAdena: () => f.a });
    const seen: string[] = [];
    const off = w.onAccountChange((a) => seen.push(`1:${a}`));
    w.onAccountChange((a) => seen.push(`2:${a}`));
    w.onNetworkChange((c) => seen.push(`net:${c}`));
    expect(f.listeners.changedAccount).toHaveLength(1);
    f.listeners.changedAccount![0]!(OTHER);
    off();
    f.listeners.changedAccount![0]!(ME);
    f.listeners.changedNetwork![0]!('gnoland-1');
    expect(seen).toEqual([`1:${OTHER}`, `2:${OTHER}`, `2:${ME}`, 'net:gnoland-1']);
  });
});

describe('parseSendResult', () => {
  it('reads a sync broadcast (hash only)', () => {
    expect(parseSendResult({ error: null, data: null, Log: '', hash: 'abc' })).toEqual({ hash: 'abc', committed: false, returned: [] });
  });

  it('throws on a deliver_tx error', () => {
    expect(() =>
      parseSendResult({ hash: 'h', height: '5', deliver_tx: { ResponseBase: { Error: { value: 'panic: kylix: offer 4 is not open' }, Data: null, Log: '' } } }),
    ).toThrow(/kylix: offer 4 is not open/);
  });
});

describe('MockWallet', () => {
  it('records what it was asked to sign', async () => {
    const w = new MockWallet({ address: ME });
    await expect(w.signAndSend(buildClaim(''))).rejects.toMatchObject({ kind: 'not-connected' });
    await w.connect();
    const r = await w.signAndSend(buildClaim(''));
    expect(r.committed).toBe(true);
    expect(w.sent).toHaveLength(1);
    expect(w.sent[0]!.messages[0]!.value).toMatchObject({ caller: ME, func: 'Claim' });
  });

  it('can answer with an error and simulate switches', async () => {
    const w = new MockWallet({ result: new WalletError('rejected', 'no') });
    await w.connect();
    await expect(w.signAndSend(buildClaim(''))).rejects.toMatchObject({ kind: 'rejected' });
    const nets: string[] = [];
    w.onNetworkChange((c) => nets.push(c));
    w.switchTo('gnoland-1');
    await expect(w.signAndSend(buildClaim(''))).rejects.toMatchObject({ kind: 'wrong-network' });
    await w.ensureNetwork();
    expect(nets).toEqual(['gnoland-1', 'onyx-1']);
  });
});
