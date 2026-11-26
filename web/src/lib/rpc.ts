// A small read-only client for a Gno.land node's JSON-RPC.
//
// abci_query takes a path and base64 data:
//   vm/qeval    data "<pkgpath>.<expression>"   one "(value type)" per result
//   vm/qrender  data "<pkgpath>:<render path>"  the Render output as text
//   vm/qfuncs   data "<pkgpath>"                 exported functions as JSON
//   bank/balances/<addr>  no data               "\"123ugnot\""
// The answer is result.response.ResponseBase: Data (base64) on success, Error
// and Log when the VM or the realm refused.
//
// The public RPC rate-limits with HTTP 429, so every read goes through a short
// cache, identical reads in flight share one request, at most a few requests
// run at once, and 429s and network errors are retried with backoff. A 429
// pauses every request, not only the one that got it.

import { INDEXER_URL, RPC_URL } from './config.ts';
import { base64FromText, textFromBase64 } from './parse.ts';

export interface RpcOptions {
  url?: string;
  fetch?: typeof fetch;
  /** How long a successful answer is reused. Default 4 s. */
  cacheMs?: number;
  /** Retries after the first attempt, for 429, 5xx and network errors. Default 5. */
  maxRetries?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  /** Requests allowed at once. Default 4. */
  maxConcurrent?: number;
  timeoutMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  random?: () => number;
}

/** The request did not get an answer: HTTP error, network error, timeout or JSON-RPC error. */
export class RpcError extends Error {
  readonly kind: 'http' | 'network' | 'timeout' | 'rpc';
  readonly status: number | undefined;
  constructor(message: string, kind: RpcError['kind'], status?: number) {
    super(message);
    this.name = 'RpcError';
    this.kind = kind;
    this.status = status;
  }
}

/** The node answered, but the VM or the realm refused the query (a panic, a bad expression). */
export class VmError extends Error {
  /** The full error text from the node. */
  readonly detail: string;
  constructor(message: string, detail: string) {
    super(message);
    this.name = 'VmError';
    this.detail = detail;
  }
}

export interface ChainStatus {
  chainId: string;
  height: number;
  time: string;
}

interface AbciResponse {
  response?: {
    ResponseBase?: {
      Error?: { value?: unknown } | null;
      Data?: string | null;
      Log?: string;
    };
    Height?: string;
  };
}

type Cached = { at: number; ok: true; value: unknown } | { at: number; ok: false; error: VmError };

export class GnoRpc {
  readonly url: string;
  private readonly fetchFn: typeof fetch;
  private readonly cacheMs: number;
  private readonly maxRetries: number;
  private readonly baseDelayMs: number;
  private readonly maxDelayMs: number;
  private readonly maxConcurrent: number;
  private readonly timeoutMs: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;
  private readonly random: () => number;

  private readonly cache = new Map<string, Cached>();
  private readonly inflight = new Map<string, Promise<unknown>>();
  private active = 0;
  private readonly waiting: Array<() => void> = [];
  private pausedUntil = 0;
  private nextId = 1;
  /** Requests actually sent (after cache and dedupe), for tests and diagnostics. */
  requests = 0;

  constructor(opts: RpcOptions = {}) {
    this.url = opts.url ?? RPC_URL;
    this.fetchFn = opts.fetch ?? ((input, init) => globalThis.fetch(input, init));
    this.cacheMs = opts.cacheMs ?? 4_000;
    this.maxRetries = opts.maxRetries ?? 5;
    this.baseDelayMs = opts.baseDelayMs ?? 500;
    this.maxDelayMs = opts.maxDelayMs ?? 15_000;
    this.maxConcurrent = opts.maxConcurrent ?? 4;
    this.timeoutMs = opts.timeoutMs ?? 20_000;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.now = opts.now ?? (() => Date.now());
    this.random = opts.random ?? Math.random;
  }

  /** Forget every cached answer, for example after sending a transaction. */
  invalidate(): void {
    this.cache.clear();
  }

  /** vm/qeval: evaluates `expr` inside the package. Returns the raw "(value type)" text. */
  qeval(pkgPath: string, expr: string, opts?: { cacheMs?: number }): Promise<string> {
    return this.abciText('vm/qeval', `${pkgPath}.${expr}`, opts);
  }

  /** vm/qrender: the package's Render(path) output. */
  qrender(pkgPath: string, path: string, opts?: { cacheMs?: number }): Promise<string> {
    return this.abciText('vm/qrender', `${pkgPath}:${path}`, opts);
  }

  /** vm/qfuncs: the package's exported functions and their parameter types. */
  async qfuncs(pkgPath: string): Promise<Array<{ FuncName: string; Params: Array<{ Name: string; Type: string }> | null }>> {
    const text = await this.abciText('vm/qfuncs', pkgPath, { cacheMs: 300_000 });
    return JSON.parse(text);
  }

  /** The account's ugnot balance as a coins string, e.g. "34668423ugnot". */
  async bankBalances(address: string): Promise<string> {
    const text = await this.abciText(`bank/balances/${address}`, '');
    const v: unknown = JSON.parse(text);
    if (typeof v !== 'string') throw new RpcError('unexpected bank/balances answer', 'rpc');
    return v;
  }

  /** The node's chain id and latest block. */
  async status(opts?: { cacheMs?: number }): Promise<ChainStatus> {
    const r = await this.cached('status', opts?.cacheMs, async () => {
      const res = (await this.call('status', {})) as {
        node_info?: { network?: string };
        sync_info?: { latest_block_height?: string; latest_block_time?: string };
      };
      const height = Number(res.sync_info?.latest_block_height);
      if (!res.node_info?.network || !Number.isSafeInteger(height)) {
        throw new RpcError('unexpected status answer', 'rpc');
      }
      return { chainId: res.node_info.network, height, time: res.sync_info?.latest_block_time ?? '' };
    });
    return r as ChainStatus;
  }

  /** abci_query, decoded to text. Throws VmError when the node reports an error. */
  async abciText(path: string, data: string, opts?: { cacheMs?: number }): Promise<string> {
    const key = `abci ${path} ${data}`;
    const v = await this.cached(key, opts?.cacheMs, async () => {
      const res = (await this.call('abci_query', {
        path,
        data: data === '' ? '' : base64FromText(data),
      })) as AbciResponse;
      const base = res.response?.ResponseBase;
      if (!base) throw new RpcError('abci_query answer has no ResponseBase', 'rpc');
      if (base.Error) throw vmError(base.Error, base.Log ?? '');
      return base.Data ? textFromBase64(base.Data) : '';
    });
    return v as string;
  }

  /** One JSON-RPC call, with retries. Not cached. */
  async call(method: string, params: Record<string, unknown>): Promise<unknown> {
    // text/plain keeps this a "simple" CORS request: no preflight, half the requests.
    const body = JSON.stringify({ jsonrpc: '2.0', id: this.nextId++, method, params });
    for (let attempt = 0; ; attempt++) {
      await this.waitPause();
      let retryAfterMs = 0;
      let err: RpcError;
      await this.acquire();
      try {
        this.requests++;
        const res = await this.fetchWithTimeout(body);
        if (res.ok) {
          const json = (await res.json()) as { result?: unknown; error?: { message?: string; data?: string } };
          if (json.error) {
            throw new RpcError(`${method}: ${json.error.message ?? 'error'} ${json.error.data ?? ''}`.trim(), 'rpc');
          }
          return json.result;
        }
        err = new RpcError(`${method}: HTTP ${res.status}`, 'http', res.status);
        retryAfterMs = retryAfter(res.headers.get('retry-after'));
        if (res.status !== 429 && res.status < 500) throw err;
      } catch (e) {
        if (e instanceof RpcError && (e.kind === 'rpc' || (e.kind === 'http' && e.status !== 429 && (e.status ?? 0) < 500))) {
          throw e;
        }
        err = e instanceof RpcError ? e : toNetworkError(method, e);
      } finally {
        this.release();
      }
      if (attempt >= this.maxRetries) throw err;
      const backoff = Math.min(this.maxDelayMs, this.baseDelayMs * 2 ** attempt);
      const delay = Math.max(retryAfterMs, backoff * (0.5 + this.random() / 2));
      if (err.status === 429) this.pausedUntil = Math.max(this.pausedUntil, this.now() + delay);
      await this.sleep(delay);
    }
  }

  private async fetchWithTimeout(body: string): Promise<Response> {
    const ctrl = typeof AbortController === 'undefined' ? undefined : new AbortController();
    const timer = ctrl ? setTimeout(() => ctrl.abort(), this.timeoutMs) : undefined;
    try {
      return await this.fetchFn(this.url, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain' },
        body,
        ...(ctrl ? { signal: ctrl.signal } : {}),
      });
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  private async cached(key: string, cacheMs: number | undefined, load: () => Promise<unknown>): Promise<unknown> {
    const ttl = cacheMs ?? this.cacheMs;
    const hit = this.cache.get(key);
    if (hit && this.now() - hit.at < ttl) {
      if (hit.ok) return hit.value;
      throw hit.error;
    }
    const running = this.inflight.get(key);
    if (running) return running;
    const p = (async () => {
      try {
        const value = await load();
        if (ttl > 0) this.cache.set(key, { at: this.now(), ok: true, value });
        return value;
      } catch (e) {
        // A refusal is an answer: keep it as long as a success. Transport
        // errors are not kept.
        if (e instanceof VmError && ttl > 0) this.cache.set(key, { at: this.now(), ok: false, error: e });
        throw e;
      } finally {
        this.inflight.delete(key);
      }
    })();
    this.inflight.set(key, p);
    return p;
  }

  private async waitPause(): Promise<void> {
    const wait = this.pausedUntil - this.now();
    if (wait > 0) await this.sleep(wait);
  }

  private acquire(): Promise<void> {
    if (this.active < this.maxConcurrent) {
      this.active++;
      return Promise.resolve();
    }
    return new Promise((resolve) => this.waiting.push(() => {
      this.active++;
      resolve();
    }));
  }

  private release(): void {
    this.active--;
    const next = this.waiting.shift();
    if (next) next();
  }
}

function retryAfter(h: string | null): number {
  if (!h) return 0;
  const s = Number(h);
  return Number.isFinite(s) && s >= 0 ? Math.min(s * 1000, 60_000) : 0;
}

function toNetworkError(method: string, e: unknown): RpcError {
  const name = (e as { name?: string } | null)?.name;
  if (name === 'AbortError') return new RpcError(`${method}: timed out`, 'timeout');
  return new RpcError(`${method}: ${(e as Error)?.message ?? String(e)}`, 'network');
}

/** Turns the node's error into a short message: the realm's panic text, without the VM's stack. */
function vmError(error: { value?: unknown }, log: string): VmError {
  const raw = typeof error.value === 'string' ? error.value : log || JSON.stringify(error);
  const first = raw.split('\n--- preprocess stack ---')[0] ?? raw;
  const message = first.split('\n')[0]?.trim() || 'query refused';
  return new VmError(message, raw + (log && log !== raw ? `\n${log}` : ''));
}

export interface IndexedTx {
  hash: string;
  height: number;
  success: boolean;
  gasUsed: number;
  gasWanted: number;
  /** The chain's error text when the transaction failed. */
  error: string;
}

/**
 * Looks a transaction up in the tx indexer by its base64 hash. The onyx-1 RPC
 * runs with tx_index off, so after a broadcast_tx_sync this is how to learn
 * whether and where the transaction landed. Null until it is indexed.
 */
export async function indexedTx(hash: string, opts: { url?: string; fetch?: typeof fetch } = {}): Promise<IndexedTx | null> {
  if (!/^[A-Za-z0-9+/=_-]{20,100}$/.test(hash)) throw new RpcError('bad transaction hash', 'rpc');
  const f = opts.fetch ?? ((input, init) => globalThis.fetch(input, init));
  const query = `{ getTransactions(where: {hash: {eq: ${JSON.stringify(hash)}}}) { hash block_height success gas_used gas_wanted response { error log } } }`;
  const res = await f(opts.url ?? INDEXER_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query }),
  });
  if (!res.ok) throw new RpcError(`indexer: HTTP ${res.status}`, 'http', res.status);
  const j = (await res.json()) as {
    data?: { getTransactions?: Array<{ hash: string; block_height: number; success: boolean; gas_used: number; gas_wanted: number; response?: { error?: string; log?: string } }> };
    errors?: Array<{ message?: string }>;
  };
  if (j.errors?.length) throw new RpcError(`indexer: ${j.errors[0]?.message ?? 'error'}`, 'rpc');
  const t = j.data?.getTransactions?.[0];
  if (!t) return null;
  return {
    hash: t.hash,
    height: t.block_height,
    success: t.success,
    gasUsed: t.gas_used,
    gasWanted: t.gas_wanted,
    error: t.response?.error ?? '',
  };
}
