// Finding rings among open offers, in the browser. A port of the direct-ring
// part of the Go solver (solver/ring: finder.go, verify.go, select.go): the
// same eligibility filter, neighbour lists, depth-first search, bounds,
// verifier and selection order. Rings with a GnoSwap hop are not searched
// here.
//
// A ring lists offer ids in ring order, smallest id first: offer ids[i] gives
// its asset to the owner of ids[(i+1) % n].

import { LIMITS } from './config.ts';
import type { Asset, Collection, Offer } from './kylix.ts';

export interface Ring {
  ids: number[];
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

export function findRings(input: Offer[], opts: FindOptions = {}): FindResult {
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
  const truncate = (why: string) => {
    if (!stats.truncated) {
      stats.truncated = true;
      stats.truncatedReason = why;
    }
  };

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
  const rings: Ring[] = [];
  if (offers.length < LIMITS.ringMinLegs) return { rings, stats };

  const adj = buildAdjacency(offers, cfg.maxFanout, cfg.maxPerOwner, truncate);
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
  for (const [k, list] of wantItems) wantItems.set(k, capPerOwner(offers, list, maxPerOwner, truncate));
  for (const [k, list] of wantTokens) {
    list.sort((a, b) => cmpBig(offers[a]!.want.amount, offers[b]!.want.amount) || a - b);
    wantTokens.set(k, capPerOwner(offers, list, maxPerOwner, truncate));
  }

  return offers.map((o, u) => {
    let candidates: number[];
    if (o.give.kind === 'item') {
      candidates = wantItems.get(itemKey(o.give)) ?? [];
    } else {
      const list = wantTokens.get(o.give.key) ?? [];
      let cut = 0;
      while (cut < list.length && offers[list[cut]!]!.want.amount <= o.give.amount) cut++;
      candidates = list.slice(0, cut);
    }
    let nb = candidates.filter((v) => {
      if (v === u || offers[v]!.owner === o.owner) return false;
      return !(o.give.kind === 'item' && offers[v]!.give.kind === 'item' && sameAsset(offers[v]!.give, o.give));
    });
    if (o.give.kind === 'fungible') nb.sort((a, b) => a - b);
    nb = roundRobinByOwner(offers, nb);
    if (maxFanout > 0 && nb.length > maxFanout) {
      nb = nb.slice(0, maxFanout);
      truncate('max_fanout');
    }
    return nb;
  });
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
 * Picks rings that share no offer: longest first, then the ring whose sorted
 * ids are smallest (oldest offers), then ring order.
 */
export function selectRings(candidates: Ring[]): Ring[] {
  const ranked = candidates.map((r) => ({ r, sorted: [...r.ids].sort((a, b) => a - b) }));
  ranked.sort((a, b) => b.r.ids.length - a.r.ids.length || cmpIds(a.sorted, b.sorted) || cmpIds(a.r.ids, b.r.ids));
  const used = new Set<number>();
  const out: Ring[] = [];
  for (const { r } of ranked) {
    if (r.ids.some((id) => used.has(id))) continue;
    r.ids.forEach((id) => used.add(id));
    out.push(r);
  }
  return out;
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
