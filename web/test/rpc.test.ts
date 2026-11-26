import { describe, expect, it } from 'vitest';
import { GnoRpc, RpcError, VmError, indexedTx } from '../src/lib/rpc.ts';
import { abciOk, fakeFetch } from './helpers.ts';
import nextSlot from './fixtures/next-slot.json';
import errPanic from './fixtures/err-panic.json';
import errUndeclared from './fixtures/err-undeclared.json';
import status from './fixtures/status.json';
import bank from './fixtures/bank-balance.json';

const K = 'gno.land/r/nym-kylix000/kylix';
const A = 'g1jg8mtutu9khhfwc4nxmuhcpftf0pajdhfvsqf5';

function rpc(routes: Parameters<typeof fakeFetch>[0], opts: ConstructorParameters<typeof GnoRpc>[0] = {}) {
  const f = fakeFetch(routes);
  let t = 1_000_000;
  const sleeps: number[] = [];
  const client = new GnoRpc({
    fetch: f.fetch,
    sleep: async (ms) => {
      sleeps.push(ms);
      t += ms;
    },
    now: () => t,
    random: () => 1,
    ...opts,
  });
  return { client, calls: f.calls, sleeps, advance: (ms: number) => (t += ms) };
}

describe('GnoRpc', () => {
  it('sends abci_query with base64 data as text/plain and decodes the answer', async () => {
    const { client, calls } = rpc({ [`vm/qeval ${K}.NextSlot("${A}")`]: nextSlot });
    const text = await client.qeval(K, `NextSlot("${A}")`);
    expect(text).toBe('(1 uint64)\n("g1hq2jzq39snc8vxumhmkdrpr4udjukcxck0lpgj" .uverse.address)');
    expect(calls).toEqual([{ method: 'abci_query', path: 'vm/qeval', data: `${K}.NextSlot("${A}")`, contentType: 'text/plain' }]);
  });

  it('turns a realm panic into a VmError with the panic text', async () => {
    const { client } = rpc({ [`vm/qeval ${K}.Deliverable("")`]: errPanic });
    const e = await client.qeval(K, 'Deliverable("")').catch((x) => x);
    expect(e).toBeInstanceOf(VmError);
    expect(e.message).toBe('kylix: Deliverable takes 1 to 50 offer ids');
  });

  it('drops the VM preprocess stack from the message', async () => {
    const { client } = rpc({ [`vm/qeval ${K}.NoSuch()`]: errUndeclared });
    const e = await client.qeval(K, 'NoSuch()').catch((x) => x);
    expect(e.message).toBe('gno.land/r/nym-kylix000/kylix:0:0: name NoSuch not declared:');
    expect(e.detail).toContain('preprocess stack');
  });

  it('reads status and bank balances', async () => {
    const { client } = rpc({ status, [`bank/balances/${A} `]: bank });
    const s = await client.status();
    expect(s.chainId).toBe('onyx-1');
    expect(s.height).toBeGreaterThan(1_000_000);
    expect(await client.bankBalances(A)).toBe('34668423ugnot');
  });

  it('caches answers for a short time and then asks again', async () => {
    const { client, calls, advance } = rpc({ 'vm/qeval x.Y()': abciOk('(1 int)') }, { cacheMs: 4_000 });
    await client.qeval('x', 'Y()');
    await client.qeval('x', 'Y()');
    expect(calls).toHaveLength(1);
    advance(4_001);
    await client.qeval('x', 'Y()');
    expect(calls).toHaveLength(2);
    client.invalidate();
    await client.qeval('x', 'Y()');
    expect(calls).toHaveLength(3);
  });

  it('shares one request among identical reads in flight', async () => {
    const { client, calls } = rpc({ 'vm/qeval x.Y()': abciOk('(1 int)') });
    const all = await Promise.all([client.qeval('x', 'Y()'), client.qeval('x', 'Y()'), client.qeval('x', 'Y()')]);
    expect(all).toEqual(['(1 int)', '(1 int)', '(1 int)']);
    expect(calls).toHaveLength(1);
  });

  it('keeps a refusal like an answer', async () => {
    const { client, calls } = rpc({ [`vm/qeval ${K}.Deliverable("")`]: errPanic });
    await expect(client.qeval(K, 'Deliverable("")')).rejects.toBeInstanceOf(VmError);
    await expect(client.qeval(K, 'Deliverable("")')).rejects.toBeInstanceOf(VmError);
    expect(calls).toHaveLength(1);
  });

  it('retries a 429, honours Retry-After and pauses other requests', async () => {
    let n = 0;
    const { client, calls, sleeps } = rpc({
      'vm/qeval x.Y()': () => (++n <= 2 ? new Response('slow down', { status: 429, headers: { 'retry-after': '3' } }) : abciOk('(7 int)')),
    });
    expect(await client.qeval('x', 'Y()')).toBe('(7 int)');
    expect(calls).toHaveLength(3);
    expect(sleeps.every((ms) => ms >= 3_000)).toBe(true);
  });

  it('retries network errors with growing delays, then gives up', async () => {
    let n = 0;
    const f: typeof fetch = async () => {
      n++;
      throw new TypeError('Failed to fetch');
    };
    const sleeps: number[] = [];
    const client = new GnoRpc({ fetch: f, maxRetries: 3, baseDelayMs: 100, random: () => 1, sleep: async (ms) => void sleeps.push(ms) });
    const e = await client.qeval('x', 'Y()').catch((x) => x);
    expect(e).toBeInstanceOf(RpcError);
    expect(e.kind).toBe('network');
    expect(n).toBe(4);
    expect(sleeps).toEqual([100, 200, 400]);
  });

  it('does not retry a 400 or a JSON-RPC error', async () => {
    const { client, calls } = rpc({
      'vm/qeval x.A()': () => new Response('bad', { status: 400 }),
      'vm/qeval x.B()': { jsonrpc: '2.0', id: 1, error: { code: -32603, message: 'Internal error', data: 'boom' } },
    });
    await expect(client.qeval('x', 'A()')).rejects.toMatchObject({ kind: 'http', status: 400 });
    await expect(client.qeval('x', 'B()')).rejects.toMatchObject({ kind: 'rpc' });
    expect(calls).toHaveLength(2);
  });

  it('runs at most maxConcurrent requests at once', async () => {
    let active = 0;
    let peak = 0;
    const f: typeof fetch = async (_u, init) => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 5));
      active--;
      const body = JSON.parse(String(init?.body));
      return new Response(JSON.stringify(abciOk(`(${body.id} int)`)));
    };
    const client = new GnoRpc({ fetch: f, maxConcurrent: 2 });
    await Promise.all(Array.from({ length: 6 }, (_, i) => client.qeval('x', `Y(${i})`)));
    expect(peak).toBe(2);
  });
});

describe('indexedTx', () => {
  it('reads a transaction from the indexer', async () => {
    const f: typeof fetch = async (_u, init) => {
      expect(String(init?.body)).toContain('getTransactions');
      return new Response(
        JSON.stringify({
          data: { getTransactions: [{ hash: 'hSQPeDIZAYMPwkWCHzyqb18WmasED8zIFvISLve1vDM=', block_height: 1422968, success: true, gas_used: 18984540, gas_wanted: 40000000, response: { error: '', log: '' } }] },
        }),
      );
    };
    const t = await indexedTx('hSQPeDIZAYMPwkWCHzyqb18WmasED8zIFvISLve1vDM=', { fetch: f });
    expect(t).toEqual({ hash: 'hSQPeDIZAYMPwkWCHzyqb18WmasED8zIFvISLve1vDM=', height: 1422968, success: true, gasUsed: 18984540, gasWanted: 40000000, error: '' });
  });

  it('answers null until indexed and refuses a malformed hash', async () => {
    const f: typeof fetch = async () => new Response(JSON.stringify({ data: { getTransactions: [] } }));
    expect(await indexedTx('hSQPeDIZAYMPwkWCHzyqb18WmasED8zIFvISLve1vDM=', { fetch: f })).toBeNull();
    await expect(indexedTx('"}) { x', { fetch: f })).rejects.toThrow(/bad transaction hash/);
  });
});
