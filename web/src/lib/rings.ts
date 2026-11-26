// Finding rings among open offers, in the browser. A port of the direct-ring
// part of the Go solver (solver/ring: finder.go, verify.go, select.go): the
// same eligibility filter, neighbour lists, depth-first search, bounds,
// verifier and selection order. findBridgedRings ports the solver's second
// phase: rings with one GnoSwap hop.
//
// A ring lists offer ids in ring order, smallest id first: offer ids[i] gives
// its asset to the owner of ids[(i+1) % n].

import { LIMITS } from './config.ts';
import type { Asset, Collection, Offer } from './kylix.ts';

export interface Ring {
  ids: number[];
  /** For a ring with a GnoSwap hop: the index of the hop, ids[hop] -> ids[hop + 1]. */
  bridgedHop?: number;
  bridge?: BridgeInfo;
}

/** The GnoSwap hop of a bridged ring, as quoted when it was found. */
export interface BridgeInfo {
  fromOffer: number;
  toOffer: number;
  tokenIn: string;
  tokenOut: string;
  amountIn: bigint;
  wantMin: bigint;
  /** What the best pool would pay, at least wantMin. */
  expectedOut: bigint;
  /** That pool's fee tier, for SettleRingVia. */
  fee: number;
}

export interface FindOptions {
  /** Chain height the book was read at; offers past their expiry are skipped. 0 skips the check. */
  height?: number;
  /** Also skip offers expiring within this many blocks. Default 10, as the solver. */
  expiryMargin?: number;
  /** Collections from the export; needed for officialOnly. */
  collections?: Collection[];
  /** Skip offers that give or want an item of a collection that is not official (or not listed). Default true. */
  officialOnly?: boolean;
  maxFanout?: number; // default 64; negative disables
  maxPerOwner?: number; // default 4; negative disables
  maxSteps?: number; // default 500,000
  maxStepsPerStart?: number; // default 2,000
  maxRings?: number; // default 10,000
  maxRingsPerStart?: number; // default 100
}

export interface FindStats {
  offersInput: number;
  offersEligible: number;
  skippedExpiry: number;
  skippedUnofficial: number;
  steps: number;
  truncated: boolean;
  truncatedReason: string;
}

export interface FindResult {
  rings: Ring[];
  stats: FindStats;
}

const DEFAULTS = {
  maxFanout: 64,
  maxPerOwner: 4,
  maxSteps: 500_000,
  maxStepsPerStart: 2_000,
  maxRings: 10_000,
  maxRingsPerStart: 100,
  expiryMargin: 10,
};

// --- Asset rules (the realm's p/ring checks) ------------------------------------

export function validAsset(a: Asset): boolean {
  if (a.kind === 'fungible') return a.key !== '' && a.id === '' && a.amount > 0n;
  if (a.kind === 'item') return a.key !== '' && a.id !== '' && a.amount === 0n;
  return false;
}

export function sameAsset(a: Asset, b: Asset): boolean {
  return a.kind === b.kind && a.key === b.key && a.id === b.id;
}

/** Whether giving `give` satisfies an offer that wants `want`, directly (no swap). */
export function satisfies(give: Asset, want: Asset): boolean {
  if (give.kind !== want.kind || give.key !== want.key) return false;
  return give.kind === 'item' ? give.id === want.id : give.amount >= want.amount;
}

function touchesUnofficial(o: Offer, official: Set<string>): boolean {
  return (o.give.kind === 'item' && !official.has(o.give.key)) || (o.want.kind === 'item' && !official.has(o.want.key));
}

function expiredOrNear(height: number, expiry: number, margin: number): boolean {
  if (height <= 0 || expiry <= 0) return false;
  if (height > expiry) return true;
  return expiry - height < Math.max(0, margin);
}

// --- Search ----------------------------------------------------------------------

/**
 * The eligible offers in id order and who can give to whom directly. Build
 * it once with prepareBook and pass it to findRings and findBridgedRings, so
 * a refresh does the work once. Both searches must use the options it was
 * made with.
 */
export interface PreparedBook {
  readonly cfg: ReturnType<typeof resolve>;
  /** Counts from preparing; each search starts from a copy. */
  readonly stats: Readonly<FindStats>;
  readonly offers: Offer[];
  readonly adj: number[][];
}

interface Search {
  cfg: PreparedBook['cfg'];
  stats: FindStats;
  truncate: (why: string) => void;
  offers: Offer[];
  adj: number[][];
}

export function prepareBook(input: Offer[], opts: FindOptions = {}): PreparedBook {
  const cfg = resolve(opts);
  const stats: FindStats = {
    offersInput: input.length,
    offersEligible: 0,
    skippedExpiry: 0,
    skippedUnofficial: 0,
    steps: 0,
    truncated: false,
    truncatedReason: '',
  };
  const truncate = truncator(stats);

  // Eligible offers, in id order.
  const official = new Set((opts.collections ?? []).filter((c) => c.official).map((c) => c.key));
  const seen = new Set<number>();
  const offers: Offer[] = [];
  for (const o of input) {
    if (o.id <= 0 || o.owner === '' || seen.has(o.id)) continue;
    if (expiredOrNear(opts.height ?? 0, o.expiry, cfg.expiryMargin)) {
      stats.skippedExpiry++;
      continue;
    }
    if (!validAsset(o.give) || !validAsset(o.want) || sameAsset(o.give, o.want)) continue;
    if (cfg.officialOnly && touchesUnofficial(o, official)) {
      stats.skippedUnofficial++;
      continue;
    }
    seen.add(o.id);
    offers.push(o);
  }
  offers.sort((a, b) => a.id - b.id);
  stats.offersEligible = offers.length;
  const adj = offers.length < LIMITS.ringMinLegs ? [] : buildAdjacency(offers, cfg.maxFanout, cfg.maxPerOwner, truncate);
  return { cfg, stats, offers, adj };
}

function truncator(stats: FindStats): (why: string) => void {
  return (why) => {
    if (!stats.truncated) {
      stats.truncated = true;
      stats.truncatedReason = why;
    }
  };
}

/** A search over a prepared book, with its own copy of the counts. */
function startSearch(input: Offer[] | PreparedBook, opts: FindOptions): Search {
  const book = Array.isArray(input) ? prepareBook(input, opts) : input;
  const stats = { ...book.stats };
  return { cfg: book.cfg, stats, truncate: truncator(stats), offers: book.offers, adj: book.adj };
}

/** Direct rings. `input` is the book, or a book made by prepareBook. */
export function findRings(input: Offer[] | PreparedBook, opts: FindOptions = {}): FindResult {
  const { cfg, stats, truncate, offers, adj } = startSearch(input, opts);
  const rings: Ring[] = [];
  if (offers.length < LIMITS.ringMinLegs) return { rings, stats };

  const perStart = fairPerStart(cfg.maxStepsPerStart, cfg.maxSteps, offers.length);
  const keys = new Set<string>();

  const path: number[] = [];
  const owners: string[] = [];
  const items: string[] = [];

  for (let start = 0; start < offers.length; start++) {
    if (cfg.maxRings > 0 && rings.length >= cfg.maxRings) break;
    if (cfg.maxSteps > 0 && stats.steps >= cfg.maxSteps) {
      truncate('max_steps');
      break;
    }
    const s = offers[start]!;
    path.length = 0;
    owners.length = 0;
    items.length = 0;
    path.push(start);
    owners.push(s.owner);
    if (s.give.kind === 'item') items.push(itemKey(s.give));
    let startSteps = 0;
    let startRings = 0;
    let stop = false;

    const dfs = (depth: number): void => {
      const u = path[depth - 1]!;
      for (const v of adj[u] ?? []) {
        if (stop) return;
        if (v <= start) continue;
        if (perStart > 0 && startSteps >= perStart) {
          truncate('max_steps_per_start');
          stop = true;
          return;
        }
        if (cfg.maxSteps > 0 && stats.steps >= cfg.maxSteps) {
          truncate('max_steps');
          stop = true;
          return;
        }
        const o = offers[v]!;
        if (path.includes(v) || owners.includes(o.owner)) continue;
        const ik = o.give.kind === 'item' ? itemKey(o.give) : '';
        if (ik && items.includes(ik)) continue;

        startSteps++;
        stats.steps++;
        path.push(v);
        owners.push(o.owner);
        if (ik) items.push(ik);

        const len = depth + 1;
        if (len >= LIMITS.ringMinLegs && satisfies(o.give, s.want)) {
          const ids = path.map((i) => offers[i]!.id);
          const key = ids.join(',');
          if (!keys.has(key)) {
            keys.add(key);
            rings.push({ ids });
            startRings++;
            if (cfg.maxRings > 0 && rings.length >= cfg.maxRings) {
              truncate('max_rings');
              stop = true;
            } else if (cfg.maxRingsPerStart > 0 && startRings >= cfg.maxRingsPerStart) {
              truncate('max_rings_per_start');
              stop = true;
            }
          }
        }
        if (!stop && len < LIMITS.ringMaxLegs) dfs(len);

        path.pop();
        owners.pop();
        if (ik) items.pop();
      }
    };
    dfs(1);
  }
  return { rings, stats };
}

// --- Rings with one GnoSwap hop ----------------------------------------------------

/** Answers what a GnoSwap swap would pay, or null when no pool can do it (see gnoswap.ts). */
export type Quote = (tokenIn: string, tokenOut: string, amountIn: bigint) => Promise<{ out: bigint; fee: number } | null>;

export interface BridgedOptions extends FindOptions {
  /** Rings already found directly; their offer sets are skipped. */
  direct?: Ring[];
  /** Most candidate paths kept for quoting. Default 2,000. */
  maxCandidates?: number;
}

/**
 * Rings in which exactly one hop swaps one token for another on GnoSwap, as
 * the solver's second phase finds them. Every other hop is direct. The
 * search starts at each offer that wants a token, walks direct hops, and at
 * each step tests the closing hop back to the start as the swapped one: the
 * last offer must give a token other than the one the start wants, and the
 * quote for its whole amount must reach the start's minimum.
 *
 * The walk itself makes no requests. The distinct swaps it needs are then
 * quoted (the quoter caps how many), and the rings whose quote holds are
 * kept, rotated so the smallest id is first.
 */
export async function findBridgedRings(input: Offer[] | PreparedBook, quote: Quote, opts: BridgedOptions = {}): Promise<FindResult> {
  const { cfg, stats, truncate, offers, adj } = startSearch(input, opts);
  const rings: Ring[] = [];
  if (offers.length < LIMITS.ringMinLegs) return { rings, stats };

  const giveKeys = new Set(offers.filter((o) => o.give.kind === 'fungible').map((o) => o.give.key));
  let starts: number[] = [];
  offers.forEach((o, i) => {
    if (o.want.kind !== 'fungible' || giveKeys.size === 0) return;
    if (giveKeys.size === 1 && giveKeys.has(o.want.key)) return;
    starts.push(i);
  });
  starts = roundRobinByOwner(offers, starts);
  const perStart = fairPerStart(cfg.maxStepsPerStart, cfg.maxSteps, starts.length);
  const maxCandidates = opts.maxCandidates ?? 2_000;

  const seen = new Set((opts.direct ?? []).map((r) => [...r.ids].sort((a, b) => a - b).join(',')));
  const candidates: number[][] = [];
  const path: number[] = [];
  const owners: string[] = [];
  const items: string[] = [];

  for (const start of starts) {
    if (candidates.length >= maxCandidates) {
      truncate('max_candidates');
      break;
    }
    if (cfg.maxSteps > 0 && stats.steps >= cfg.maxSteps) {
      truncate('max_steps');
      break;
    }
    const s = offers[start]!;
    path.length = 0;
    owners.length = 0;
    items.length = 0;
    path.push(start);
    owners.push(s.owner);
    if (s.give.kind === 'item') items.push(itemKey(s.give));
    let startSteps = 0;
    let stop = false;

    const dfs = (depth: number): void => {
      const u = path[depth - 1]!;
      for (const v of adj[u] ?? []) {
        if (stop) return;
        if (perStart > 0 && startSteps >= perStart) {
          truncate('max_steps_per_start');
          stop = true;
          return;
        }
        if (cfg.maxSteps > 0 && stats.steps >= cfg.maxSteps) {
          truncate('max_steps');
          stop = true;
          return;
        }
        const o = offers[v]!;
        if (path.includes(v) || owners.includes(o.owner)) continue;
        const ik = o.give.kind === 'item' ? itemKey(o.give) : '';
        if (ik && items.includes(ik)) continue;

        startSteps++;
        stats.steps++;
        path.push(v);
        owners.push(o.owner);
        if (ik) items.push(ik);

        const len = depth + 1;
        if (len >= LIMITS.ringMinLegs && o.give.kind === 'fungible' && o.give.key !== s.want.key) {
          if (candidates.length < maxCandidates) candidates.push([...path]);
          else {
            truncate('max_candidates');
            stop = true;
          }
        }
        if (!stop && len < LIMITS.ringMaxLegs) dfs(len);

        path.pop();
        owners.pop();
        if (ik) items.pop();
      }
    };
    dfs(1);
  }

  // Quote each distinct swap once, in the order the walk found them.
  const quotes = new Map<string, Promise<{ out: bigint; fee: number } | null>>();
  const qkey = (p: number[]) => {
    const last = offers[p[p.length - 1]!]!;
    return `${last.give.key}\n${offers[p[0]!]!.want.key}\n${last.give.amount}`;
  };
  for (const p of candidates) {
    const k = qkey(p);
    if (quotes.has(k)) continue;
    const last = offers[p[p.length - 1]!]!;
    quotes.set(
      k,
      quote(last.give.key, offers[p[0]!]!.want.key, last.give.amount).catch(() => null),
    );
  }
  const answered = new Map<string, { out: bigint; fee: number } | null>();
  for (const [k, q] of quotes) answered.set(k, await q);

  for (const p of candidates) {
    const q = answered.get(qkey(p));
    const start = offers[p[0]!]!;
    if (!q || q.out < start.want.amount) continue;
    const ids = p.map((i) => offers[i]!.id);
    const sortedKey = [...ids].sort((a, b) => a - b).join(',');
    if (seen.has(sortedKey)) continue;
    seen.add(sortedKey);
    rings.push(canonicalBridged(offers, p, q));
    if (cfg.maxRings > 0 && rings.length >= cfg.maxRings) {
      truncate('max_rings');
      break;
    }
  }
  return { rings, stats };
}

/** Rotates a bridged path (closing hop bridged) so the smallest id comes first. */
function canonicalBridged(offers: Offer[], path: number[], q: { out: bigint; fee: number }): Ring {
  const n = path.length;
  let minPos = 0;
  for (let i = 1; i < n; i++) if (offers[path[i]!]!.id < offers[path[minPos]!]!.id) minPos = i;
  const ids = Array.from({ length: n }, (_, i) => offers[path[(minPos + i) % n]!]!.id);
  const hop = n - 1;
  const from = offers[path[hop]!]!;
  const to = offers[path[0]!]!;
  return {
    ids,
    bridgedHop: (hop - minPos + n) % n,
    bridge: {
      fromOffer: from.id,
      toOffer: to.id,
      tokenIn: from.give.key,
      tokenOut: to.want.key,
      amountIn: from.give.amount,
      wantMin: to.want.amount,
      expectedOut: q.out,
      fee: q.fee,
    },
  };
}

function resolve(o: FindOptions) {
  const maxFanout = o.maxFanout ?? DEFAULTS.maxFanout;
  const maxRings = o.maxRings ?? DEFAULTS.maxRings;
  return {
    maxFanout,
    maxPerOwner: o.maxPerOwner ?? (maxFanout < 0 ? -1 : DEFAULTS.maxPerOwner),
    maxSteps: o.maxSteps ?? DEFAULTS.maxSteps,
    maxStepsPerStart: o.maxStepsPerStart ?? DEFAULTS.maxStepsPerStart,
    maxRings,
    maxRingsPerStart: o.maxRingsPerStart ?? (maxRings < 0 ? -1 : DEFAULTS.maxRingsPerStart),
    expiryMargin: o.expiryMargin ?? DEFAULTS.expiryMargin,
    officialOnly: o.officialOnly ?? true,
  };
}

function itemKey(a: Asset): string {
  return `${a.key}#${a.id}`;
}

/** Each step's share of the global budget, at least 32, at most perStart. */
function fairPerStart(perStart: number, total: number, starts: number): number {
  if (total <= 0 || starts <= 0) return perStart;
  const share = Math.max(32, Math.floor(total / starts));
  return perStart <= 0 || share < perStart ? share : perStart;
}

/**
 * For each offer u, the offers v whose want u's give satisfies: same item, or
 * same token with v's minimum at most u's amount. Per wanted asset, at most
 * maxPerOwner offers per owner are kept (tokens: lowest minimum first). Then
 * neighbours are ordered oldest first, one offer per owner per round, and cut
 * at maxFanout.
 *
 * Each bucket is kept twice: by minimum (to find, by binary search, how many
 * minimums u's amount meets) and by age, with each offer's rank by minimum.
 * The neighbours of u are then read off the age order, skipping ranks past
 * the cut, and the walk stops once the first round has maxFanout owners. So
 * no bucket is copied or sorted per offer.
 */
function buildAdjacency(offers: Offer[], maxFanout: number, maxPerOwner: number, truncate: (why: string) => void): number[][] {
  const wantItems = new Map<string, number[]>();
  const wantTokens = new Map<string, number[]>();
  offers.forEach((o, i) => {
    const m = o.want.kind === 'item' ? wantItems : wantTokens;
    const k = o.want.kind === 'item' ? itemKey(o.want) : o.want.key;
    const list = m.get(k);
    if (list) list.push(i);
    else m.set(k, [i]);
  });

  interface Bucket {
    /** Minimums, ascending (tokens only). */
    mins: bigint[];
    /** Offer indexes, oldest first. */
    byAge: number[];
    /** Rank by minimum of each entry of byAge. */
    rank: Int32Array;
  }
  const bucket = (byMin: number[], fungible: boolean): Bucket => {
    const rankOf = new Map<number, number>();
    byMin.forEach((v, r) => rankOf.set(v, r));
    const byAge = [...byMin].sort((a, b) => a - b);
    return {
      mins: fungible ? byMin.map((v) => offers[v]!.want.amount) : [],
      byAge,
      rank: Int32Array.from(byAge, (v) => rankOf.get(v)!),
    };
  };
  const items = new Map<string, Bucket>();
  const tokens = new Map<string, Bucket>();
  for (const [k, list] of wantItems) items.set(k, bucket(capPerOwner(offers, list, maxPerOwner, truncate), false));
  for (const [k, list] of wantTokens) {
    list.sort((a, b) => cmpBig(offers[a]!.want.amount, offers[b]!.want.amount) || a - b);
    tokens.set(k, bucket(capPerOwner(offers, list, maxPerOwner, truncate), true));
  }

  const perOwner = new Map<string, number>();
  return offers.map((o, u) => {
    let b: Bucket | undefined;
    let cut: number;
    if (o.give.kind === 'item') {
      b = items.get(itemKey(o.give));
      cut = b ? b.byAge.length : 0;
    } else {
      b = tokens.get(o.give.key);
      cut = b ? upperBound(b.mins, o.give.amount) : 0;
    }
    if (!b || cut === 0) return [];
    perOwner.clear();
    const rounds: number[][] = [];
    let full = false;
    for (let j = 0; j < b.byAge.length; j++) {
      if (b.rank[j]! >= cut) continue;
      const v = b.byAge[j]!;
      const w = offers[v]!;
      if (v === u || w.owner === o.owner) continue;
      if (o.give.kind === 'item' && w.give.kind === 'item' && sameAsset(w.give, o.give)) continue;
      if (full) {
        // One more neighbour than fits: the list is cut.
        truncate('max_fanout');
        break;
      }
      const r = perOwner.get(w.owner) ?? 0;
      perOwner.set(w.owner, r + 1);
      (rounds[r] ??= []).push(v);
      // Every later neighbour lands in a later place than the first round's
      // maxFanout entries, so the rest cannot make the cut.
      if (maxFanout > 0 && rounds[0]!.length >= maxFanout) full = true;
    }
    let nb = rounds.flat();
    if (maxFanout > 0 && nb.length > maxFanout) {
      nb = nb.slice(0, maxFanout);
      truncate('max_fanout');
    }
    return nb;
  });
}

/** How many of the ascending `xs` are at most `x`. */
function upperBound(xs: bigint[], x: bigint): number {
  let lo = 0;
  let hi = xs.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (xs[mid]! <= x) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function capPerOwner(offers: Offer[], idxs: number[], max: number, truncate: (why: string) => void): number[] {
  if (max <= 0 || idxs.length <= max) return idxs;
  const count = new Map<string, number>();
  const kept: number[] = [];
  for (const i of idxs) {
    const owner = offers[i]!.owner;
    const n = count.get(owner) ?? 0;
    if (n >= max) {
      truncate('max_per_owner');
      continue;
    }
    count.set(owner, n + 1);
    kept.push(i);
  }
  return kept;
}

/** The first offer of each owner, then the second of each, and so on. */
function roundRobinByOwner(offers: Offer[], idxs: number[]): number[] {
  if (idxs.length <= 1) return idxs;
  const seen = new Map<string, number>();
  const rounds: number[][] = [];
  for (const i of idxs) {
    const owner = offers[i]!.owner;
    const r = seen.get(owner) ?? 0;
    seen.set(owner, r + 1);
    (rounds[r] ??= []).push(i);
  }
  return rounds.flat();
}

function cmpBig(a: bigint, b: bigint): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

// --- Verification -----------------------------------------------------------------

/**
 * Checks a direct ring against the book, independently of the search: 2 to 6
 * offers, all open and unexpired at `height`, no offer, owner or given item
 * twice, every asset well formed, and every hop gives what the next offer
 * wants, at least its minimum. Returns null when the ring holds, otherwise
 * the reason.
 */
export function verifyRing(ring: Ring, offers: Map<number, Offer> | Offer[], height = 0): string | null {
  const hop = ring.bridgedHop ?? -1;
  if (hop !== -1 && (!Number.isInteger(hop) || hop < 0 || hop >= ring.ids.length)) return `bridged hop ${hop} out of range`;
  const byId = offers instanceof Map ? offers : new Map(offers.map((o) => [o.id, o]));
  const n = ring.ids.length;
  if (n < LIMITS.ringMinLegs || n > LIMITS.ringMaxLegs) {
    return `ring length ${n} outside [${LIMITS.ringMinLegs}, ${LIMITS.ringMaxLegs}]`;
  }
  const legs: Offer[] = [];
  for (const [i, id] of ring.ids.entries()) {
    const o = byId.get(id);
    if (!o) return `leg ${i}: offer ${id} not found`;
    if (height > 0 && o.expiry > 0 && height > o.expiry) return `leg ${i} (offer ${id}): expired at ${o.expiry}`;
    if (o.owner === '') return `leg ${i} (offer ${id}): empty owner`;
    if (!validAsset(o.give)) return `leg ${i} (offer ${id}): bad give`;
    if (!validAsset(o.want)) return `leg ${i} (offer ${id}): bad want`;
    if (sameAsset(o.give, o.want)) return `leg ${i} (offer ${id}): gives what it wants`;
    for (const [j, p] of legs.entries()) {
      if (p.id === o.id) return `leg ${i}: duplicate offer ${id}`;
      if (p.owner === o.owner) return `leg ${i} (offer ${id}): same owner as leg ${j}`;
      if (o.give.kind === 'item' && p.give.kind === 'item' && sameAsset(o.give, p.give)) {
        return `leg ${i} (offer ${id}): item given twice`;
      }
    }
    legs.push(o);
  }
  for (let i = 0; i < n; i++) {
    const give = legs[i]!.give;
    const want = legs[(i + 1) % n]!.want;
    if (i === hop) {
      const b = ring.bridge;
      if (give.kind !== 'fungible' || want.kind !== 'fungible') return `hop ${i}: a swapped hop must be token to token`;
      if (give.key === want.key) return `hop ${i}: a swapped hop needs two different tokens`;
      if (!b || b.fromOffer !== legs[i]!.id || b.toOffer !== legs[(i + 1) % n]!.id) return `hop ${i}: no quote for this hop`;
      if (b.tokenIn !== give.key || b.tokenOut !== want.key || b.amountIn !== give.amount || b.wantMin !== want.amount) {
        return `hop ${i}: the quote does not match the offers`;
      }
      if (b.expectedOut < want.amount) return `hop ${i}: quote ${b.expectedOut} below the minimum ${want.amount}`;
      continue;
    }
    if (!satisfies(give, want)) {
      return `hop ${i}->${(i + 1) % n}: offer ${legs[i]!.id} gives ${describe(give)}, offer ${legs[(i + 1) % n]!.id} wants ${describe(want)}`;
    }
  }
  return null;
}

function describe(a: Asset): string {
  return a.kind === 'item' ? `${a.key}#${a.id}` : `${a.amount} ${a.key}`;
}

// --- Selection --------------------------------------------------------------------

/**
 * Picks rings that share no offer: longest first, then direct before
 * bridged, then the ring whose sorted ids are smallest (oldest offers), then
 * ring order.
 */
export function selectRings(candidates: Ring[]): Ring[] {
  const used = new Set<number>();
  const out: Ring[] = [];
  for (const r of rankRings(candidates)) {
    if (r.ids.some((id) => used.has(id))) continue;
    r.ids.forEach((id) => used.add(id));
    out.push(r);
  }
  return out;
}

/** Rings in the order selectRings prefers them, as a new array. */
export function rankRings(candidates: Ring[]): Ring[] {
  const ranked = candidates.map((r) => ({ r, sorted: [...r.ids].sort((a, b) => a - b) }));
  const bridged = (r: Ring) => (r.bridgedHop !== undefined && r.bridgedHop >= 0 ? 1 : 0);
  ranked.sort((a, b) => b.r.ids.length - a.r.ids.length || bridged(a.r) - bridged(b.r) || cmpIds(a.sorted, b.sorted) || cmpIds(a.r.ids, b.r.ids));
  return ranked.map((x) => x.r);
}

function cmpIds(a: number[], b: number[]): number {
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    if (a[i] !== b[i]) return a[i]! - b[i]!;
  }
  return a.length - b.length;
}

/** Rings that include an offer, for an offer page. */
export function ringsWithOffer(rings: Ring[], id: number): Ring[] {
  return rings.filter((r) => r.ids.includes(id));
}
