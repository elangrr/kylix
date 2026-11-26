// Quotes for a GnoSwap hop, ported from the solver (solver/rpc/gnoswap.go).
// For a token pair it asks the pool realm which fee tiers have a pool, then
// asks the router's DrySwapRoute what each pool would pay for the amount,
// and keeps the best. Tokens are named by their grc20reg keys, as Kylix
// passes them to GnoSwap. Reads only.

import { GNOSWAP_FEE_TIERS } from './config.ts';
import { goString, parseQeval } from './parse.ts';
import { GnoRpc } from './rpc.ts';

export const GNOSWAP_POOL = 'gno.land/r/gnoswap/pool';
export const GNOSWAP_ROUTER = 'gno.land/r/gnoswap/router';

export interface SwapQuote {
  /** What the swap would pay out, in the output token's base units. */
  out: bigint;
  /** The fee tier of the pool that pays the most. */
  fee: number;
}

/** Answers a quote, or null when no pool can do the swap. */
export type QuoteFn = (tokenIn: string, tokenOut: string, amountIn: bigint) => Promise<SwapQuote | null>;

/**
 * DrySwapRoute answers three lines: amount in, amount out, and an error,
 * which is "(undefined)" on success. The error is a pointer to a struct the
 * qeval parser does not read, so this reads it line by line, as the solver
 * does. Returns the amount out, or null when the router reports an error.
 */
export function parseDrySwap(text: string): bigint | null {
  const lines = text.trim().split('\n');
  if (lines.length !== 3) throw new Error(`DrySwapRoute returned ${lines.length} values, wanted 3`);
  if (lines[2]!.trim() !== '(undefined)') return null;
  const vals = parseQeval(`${lines[0]}\n${lines[1]}`);
  const out = vals[1];
  if (out?.type !== 'string' || !/^\d+$/.test(out.value)) throw new Error('DrySwapRoute: bad amount out');
  const n = BigInt(out.value);
  return n > 0n ? n : null;
}

export interface QuoterOptions {
  /** Distinct uncached quotes allowed over this quoter's life. Default 24. */
  maxQuotes?: number;
  /** Distinct token pairs whose pools may be looked up. Default 12. */
  maxPairs?: number;
  feeTiers?: readonly number[];
}

export class GnoSwapQuoter {
  readonly rpc: GnoRpc;
  private readonly maxQuotes: number;
  private readonly maxPairs: number;
  private readonly tiers: readonly number[];
  private readonly pairs = new Map<string, Promise<number[]>>();
  private readonly quotes = new Map<string, Promise<SwapQuote | null>>();
  /** Set when a limit stopped a lookup; the answer was null for that reason. */
  truncated = false;

  constructor(rpc: GnoRpc = new GnoRpc(), opts: QuoterOptions = {}) {
    this.rpc = rpc;
    this.maxQuotes = opts.maxQuotes ?? 24;
    this.maxPairs = opts.maxPairs ?? 12;
    this.tiers = opts.feeTiers ?? GNOSWAP_FEE_TIERS;
  }

  /** The fee tiers with a pool for the pair, in either order. */
  poolTiers(a: string, b: string): Promise<number[]> {
    const [x, y] = a <= b ? [a, b] : [b, a];
    const key = `${x}\n${y}`;
    let p = this.pairs.get(key);
    if (!p) {
      if (this.pairs.size >= this.maxPairs) {
        this.truncated = true;
        return Promise.resolve([]);
      }
      p = (async () => {
        const out: number[] = [];
        for (const fee of this.tiers) {
          const text = await this.rpc.qeval(GNOSWAP_POOL, `ExistsPoolPath(GetPoolPath(${goString(x)},${goString(y)},${fee}))`, { cacheMs: 300_000 });
          const v = parseQeval(text)[0];
          if (v?.type === 'bool' && v.value === 'true') out.push(fee);
        }
        return out;
      })();
      this.pairs.set(key, p);
      p.catch(() => this.pairs.delete(key));
    }
    return p;
  }

  /** The best quote across the pair's pools for an exact input. */
  quote: QuoteFn = (tokenIn, tokenOut, amountIn) => {
    if (!tokenIn || !tokenOut || tokenIn === tokenOut || amountIn <= 0n) return Promise.resolve(null);
    const key = `${tokenIn}\n${tokenOut}\n${amountIn}`;
    let p = this.quotes.get(key);
    if (!p) {
      if (this.quotes.size >= this.maxQuotes) {
        this.truncated = true;
        return Promise.resolve(null);
      }
      p = (async () => {
        const tiers = await this.poolTiers(tokenIn, tokenOut);
        let best: SwapQuote | null = null;
        for (const fee of tiers) {
          const route = `${tokenIn}:${tokenOut}:${fee}`;
          const expr = `DrySwapRoute(${[tokenIn, tokenOut, String(amountIn), 'EXACT_IN', route, '100', '0'].map(goString).join(',')})`;
          const out = parseDrySwap(await this.rpc.qeval(GNOSWAP_ROUTER, expr, { cacheMs: 15_000 }));
          if (out !== null && (!best || out > best.out || (out === best.out && fee < best.fee))) best = { out, fee };
        }
        return best;
      })();
      this.quotes.set(key, p);
      p.catch(() => this.quotes.delete(key));
    }
    return p;
  };
}
