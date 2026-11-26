// Typed reads of the Kylix realm and the assets it trades.

import { FAUCET, LIMITS, PATHS, TOKENS } from './config.ts';
import {
  ParseError,
  assertAddress,
  assertOfferId,
  goString,
  parseQeval,
  qevalAddress,
  qevalInt,
  qevalIsUndefined,
  qevalString,
  ugnotFromCoins,
} from './parse.ts';
import type { GnoValue } from './parse.ts';
import { GnoRpc, VmError } from './rpc.ts';
import { findBridgedRings, findRings, selectRings } from './rings.ts';
import type { FindOptions, Quote, Ring } from './rings.ts';

export type AssetKind = 'fungible' | 'item';

/** One side of an offer. Fungible: key is a grc20reg key, id is "". Item: key is a collection, amount is 0. */
export interface Asset {
  kind: AssetKind;
  key: string;
  id: string;
  /** Exact amount given, or the minimum wanted. 0 for items. */
  amount: bigint;
}

export interface Offer {
  id: number;
  owner: string;
  nonce: number;
  /** The offer's own address. Present in the export; GetOffer does not return it. */
  slot?: string;
  /** The address the owner approved (the slot, or an adapter's sub-address). Export only. */
  approve?: string;
  give: Asset;
  want: Asset;
  /** Last block height at which the offer may settle. */
  expiry: number;
  viaSession: boolean;
}

export interface Collection {
  key: string;
  name: string;
  adapter: boolean;
  target: string;
  official: boolean;
  /** "official collection", "official adapter", "third-party collection" or "third-party adapter". */
  label: string;
  approvalCheck: boolean;
}

/** The open-offer book. */
export interface Graph {
  realm: string;
  /** Height when the first page was read. */
  height: number;
  offers: Offer[];
  collections: Collection[];
  /** Open offers in the book, expired ones included until pruned. */
  total: number;
}

export interface GraphPage {
  realm: string;
  height: number;
  offers: Offer[];
  collections?: Collection[];
  collectionsHasMore?: boolean;
  collectionsNext?: string;
  hasMore: boolean;
  next: number;
  total: number;
}

export interface DeliverableStatus {
  id: number;
  deliverable: boolean;
  /** Why not, in the realm's words: "not open", "expired", "slot g1... may spend 0 of ..." */
  reason: string;
}

export interface FaucetStatus {
  /** Height of the last claim, or null if this address never claimed. */
  lastClaim: number | null;
  /** First height at which the address may claim again. */
  nextClaimHeight: number;
  canClaimNow: boolean;
  height: number;
}

export interface TokenInfo {
  key: string;
  name: string;
  symbol: string;
  decimals: number;
}

/** How to approve a token for an offer: which realm function to call. */
export type ApproveRoute =
  | { kind: 'kylixdemo'; pkgPath: string; symbol: string } // Approve(symbol, spender, amount)
  | { kind: 'spender-amount'; pkgPath: string } // Approve(spender, amount), as wugnot and GNS have
  | { kind: 'relic'; pkgPath: string } // ApproveRelic(spender, id)
  | { kind: 'mns'; pkgPath: string; adapter: string }; // the MNS ledger's Approve(to, name), for the nsnft adapter

/** An MNS name as the nsnft adapter sees it. */
export interface MnsName {
  name: string;
  /** "" when the name has no owner. */
  owner: string;
  /** Why the adapter would refuse to move it now, in its words; "" when it can. */
  unmovable: string;
}

/** An MNS item id: <label>*<domain>, exactly one star, both parts non-empty. */
export function isMnsName(id: string): boolean {
  const i = id.indexOf('*');
  return i > 0 && i < id.length - 1 && id.indexOf('*', i + 1) < 0;
}

// --- Parsing (pure) -------------------------------------------------------------

export function parseGraphPage(json: string): GraphPage {
  const d = JSON.parse(json) as Record<string, unknown>;
  const page: GraphPage = {
    realm: str(d.realm),
    height: num(d.height),
    offers: arr(d.offers).map(parseExportOffer),
    hasMore: d.hasMore === true,
    next: num(d.next ?? 0),
    total: num(d.total ?? 0),
  };
  if (Array.isArray(d.collections)) {
    page.collections = d.collections.map(parseCollection);
    page.collectionsHasMore = d.collectionsHasMore === true;
    page.collectionsNext = str(d.collectionsNext ?? '');
  }
  return page;
}

export function parseCollectionsPage(json: string): { collections: Collection[]; hasMore: boolean; next: string } {
  const d = JSON.parse(json) as Record<string, unknown>;
  return {
    collections: arr(d.collections).map(parseCollection),
    hasMore: d.collectionsHasMore === true,
    next: str(d.collectionsNext ?? ''),
  };
}

export function parseDeliverable(json: string): { height: number; offers: DeliverableStatus[] } {
  const d = JSON.parse(json) as Record<string, unknown>;
  return {
    height: num(d.height),
    offers: arr(d.offers).map((o) => {
      const r = o as Record<string, unknown>;
      return { id: num(r.id), deliverable: r.deliverable === true, reason: str(r.reason ?? '') };
    }),
  };
}

/** GetOffer's "(struct{...} kylix.Offer)\n(true bool)", or null when the offer is not open. */
export function parseGetOffer(text: string): Offer | null {
  const vals = parseQeval(text);
  const [s, found] = vals;
  if (!s?.fields || found?.type !== 'bool') throw new ParseError('unexpected GetOffer answer');
  if (found.value !== 'true') return null;
  const f = s.fields;
  return {
    id: Number(field(f, 0)),
    owner: field(f, 1),
    nonce: Number(field(f, 2)),
    give: assetFromStruct(f[3]),
    want: assetFromStruct(f[4]),
    expiry: Number(field(f, 5)),
    viaSession: field(f, 6) === 'true',
  };
}

/** NextSlot's "(1 uint64)\n(\"g1...\" .uverse.address)". */
export function parseNextSlot(text: string): { nonce: number; slot: string } {
  return { nonce: Number(qevalInt(text, 0)), slot: qevalAddress(text, 1) };
}

/** Pulls the ring picture out of the realm's ring page: a data:image/svg+xml;base64 URI, or null. */
export function ringPictureFromRender(markdown: string): string | null {
  const m = /!\[Ring [0-9,]+\]\((data:image\/svg\+xml;base64,[A-Za-z0-9+/]+={0,2})\)/.exec(markdown);
  return m ? m[1]! : null;
}

function parseExportOffer(o: unknown): Offer {
  const r = o as Record<string, unknown>;
  return {
    id: num(r.id),
    owner: str(r.owner),
    nonce: num(r.nonce),
    slot: str(r.slot),
    approve: str(r.approve),
    give: parseAsset(r.give),
    want: parseAsset(r.want),
    expiry: num(r.expiry),
    viaSession: r.viaSession === true,
  };
}

function parseAsset(a: unknown): Asset {
  const r = (a ?? {}) as Record<string, unknown>;
  const kind = r.kind;
  if (kind !== 'fungible' && kind !== 'item') throw new ParseError(`unknown asset kind ${String(kind)}`);
  const amount = r.amount ?? '0';
  if (typeof amount !== 'string' && typeof amount !== 'number') throw new ParseError('bad amount');
  if (!/^-?\d+$/.test(String(amount))) throw new ParseError(`bad amount ${String(amount)}`);
  return { kind, key: str(r.key), id: str(r.id ?? ''), amount: BigInt(amount) };
}

function parseCollection(c: unknown): Collection {
  const r = c as Record<string, unknown>;
  return {
    key: str(r.key),
    name: str(r.name),
    adapter: r.adapter === true,
    target: str(r.target ?? ''),
    official: r.official === true,
    label: str(r.label ?? ''),
    approvalCheck: r.approvalCheck === true,
  };
}

function assetFromStruct(v: GnoValue | undefined): Asset {
  const f = v?.fields;
  if (!f) throw new ParseError('expected an Asset struct');
  const k = field(f, 0);
  const kind: AssetKind = k === '1' ? 'fungible' : k === '2' ? 'item' : bad(`asset kind ${k}`);
  return { kind, key: field(f, 1), id: field(f, 2), amount: BigInt(field(f, 3)) };
}

function field(f: GnoValue[], i: number): string {
  const v = f[i];
  if (!v) throw new ParseError(`missing field ${i}`);
  return v.value;
}

function bad(what: string): never {
  throw new ParseError(`unexpected ${what}`);
}

function str(v: unknown): string {
  if (typeof v !== 'string') throw new ParseError(`expected a string, got ${typeof v}`);
  return v;
}

function num(v: unknown): number {
  const n = typeof v === 'string' ? Number(v) : v;
  if (typeof n !== 'number' || !Number.isSafeInteger(n)) throw new ParseError(`expected an integer, got ${String(v)}`);
  return n;
}

function arr(v: unknown): unknown[] {
  if (v == null) return [];
  if (!Array.isArray(v)) throw new ParseError('expected an array');
  return v;
}

// --- Reads ----------------------------------------------------------------------

export class KylixClient {
  readonly rpc: GnoRpc;
  readonly kylix: string;
  readonly demo: string;

  constructor(rpc: GnoRpc = new GnoRpc(), paths: { kylix?: string; kylixdemo?: string } = {}) {
    this.rpc = rpc;
    this.kylix = paths.kylix ?? PATHS.kylix;
    this.demo = paths.kylixdemo ?? PATHS.kylixdemo;
  }

  /** Every open, unexpired offer (all pages) and every registered collection. */
  async graph(opts: { pageSize?: number; maxPages?: number } = {}): Promise<Graph> {
    const limit = Math.min(opts.pageSize ?? LIMITS.exportPageMax, LIMITS.exportPageMax);
    const maxPages = opts.maxPages ?? 40;
    let after = 0;
    let first: GraphPage | undefined;
    const offers: Offer[] = [];
    for (let i = 0; i < maxPages; i++) {
      const text = await this.rpc.qeval(this.kylix, `ExportGraphJSONPage(${after}, ${limit})`);
      const page = parseGraphPage(qevalString(text));
      first ??= page;
      offers.push(...page.offers);
      if (!page.hasMore || page.next <= after) break;
      after = page.next;
    }
    if (!first) throw new ParseError('no export page');
    let collections = first.collections ?? [];
    if (first.collectionsHasMore && first.collectionsNext) {
      collections = collections.concat(await this.collections(first.collectionsNext));
    }
    return { realm: first.realm, height: first.height, offers, collections, total: first.total };
  }

  /** Registered collections, official first, from the key after `after` ("" for all). */
  async collections(after = ''): Promise<Collection[]> {
    const out: Collection[] = [];
    for (let i = 0; i < 50; i++) {
      const text = await this.rpc.qeval(this.kylix, `ExportCollectionsJSON(${goString(after)}, 0)`);
      const page = parseCollectionsPage(qevalString(text));
      out.push(...page.collections);
      if (!page.hasMore || !page.next || page.next === after) break;
      after = page.next;
    }
    return out;
  }

  /** One open offer (expired ones included until pruned), or null. */
  async offer(id: number): Promise<Offer | null> {
    return parseGetOffer(await this.rpc.qeval(this.kylix, `GetOffer(${assertOfferId(id)})`));
  }

  /** Whether each offer's owner could deliver now, in batches of 50. */
  async deliverable(ids: number[]): Promise<Map<number, DeliverableStatus>> {
    const out = new Map<number, DeliverableStatus>();
    const unique = [...new Set(ids.map(assertOfferId))];
    for (let i = 0; i < unique.length; i += LIMITS.deliverableBatch) {
      const batch = unique.slice(i, i + LIMITS.deliverableBatch);
      const text = await this.rpc.qeval(this.kylix, `Deliverable(${goString(batch.join(','))})`, { cacheMs: 2_000 });
      for (const s of parseDeliverable(qevalString(text)).offers) out.set(s.id, s);
    }
    return out;
  }

  /** The nonce and address the owner's next offer will use. Approve this address, then post. */
  async nextSlot(owner: string): Promise<{ nonce: number; slot: string }> {
    const text = await this.rpc.qeval(this.kylix, `NextSlot(${goString(assertAddress(owner))})`, { cacheMs: 0 });
    return parseNextSlot(text);
  }

  /** The address to approve for an offer giving an asset under `key` (the slot, or an adapter's sub-address). */
  async approveTarget(owner: string, nonce: number, key: string): Promise<string> {
    if (!Number.isSafeInteger(nonce) || nonce <= 0) throw new ParseError(`bad nonce ${nonce}`);
    const text = await this.rpc.qeval(
      this.kylix,
      `ApproveTarget(${goString(assertAddress(owner))}, ${nonce}, ${goString(key)})`,
    );
    return qevalAddress(text);
  }

  /**
   * The ring picture the realm's ring page shows, as a data:image/svg+xml URI
   * (put it in an <img>, where SVG cannot run scripts). Null when the page
   * shows none: an offer is closed or expired, or the ids are not a ring.
   * The page runs the readiness check, so for an item of a third-party
   * collection it runs that collection's code (free for a query).
   */
  async ringPicture(ids: number[]): Promise<string | null> {
    const path = `ring/${ids.map(assertOfferId).join(',')}`;
    return ringPictureFromRender(await this.rpc.qrender(this.kylix, path));
  }

  /** Balance of any grc20reg token, or null if no token is registered under that key. */
  async tokenBalance(key: string, owner: string): Promise<bigint | null> {
    try {
      const text = await this.rpc.qeval(
        PATHS.grc20reg,
        `Get(${goString(key)}).BalanceOf(${goString(assertAddress(owner))})`,
      );
      return qevalInt(text);
    } catch (e) {
      if (e instanceof VmError && /nil \*Token pointer/.test(e.message)) return null;
      throw e;
    }
  }

  /** Balances of several tokens; one query each (cached, de-duplicated). */
  async tokenBalances(keys: string[], owner: string): Promise<Map<string, bigint | null>> {
    const entries = await Promise.all(keys.map(async (k) => [k, await this.tokenBalance(k, owner)] as const));
    return new Map(entries);
  }

  /** Balances of the tokens the demo uses: OBOL, DRACHMA, wugnot and GNS. */
  demoBalances(owner: string): Promise<Map<string, bigint | null>> {
    return this.tokenBalances([TOKENS.OBOL, TOKENS.DRACHMA, TOKENS.WUGNOT, TOKENS.GNS], owner);
  }

  /** Name, symbol and decimals of a grc20reg token, or null if none is registered under the key. */
  async tokenInfo(key: string): Promise<TokenInfo | null> {
    const k = goString(key);
    try {
      const names = qevalString(await this.rpc.qeval(PATHS.grc20reg, `Get(${k}).GetName()+"\\n"+Get(${k}).GetSymbol()`, { cacheMs: 600_000 }));
      const decimals = qevalInt(await this.rpc.qeval(PATHS.grc20reg, `Get(${k}).GetDecimals()`, { cacheMs: 600_000 }));
      const nl = names.lastIndexOf('\n');
      return { key, name: names.slice(0, nl), symbol: names.slice(nl + 1), decimals: Number(decimals) };
    } catch (e) {
      if (e instanceof VmError && /nil \*Token pointer/.test(e.message)) return null;
      throw e;
    }
  }

  /** GNOT balance in ugnot. */
  async gnotBalance(address: string): Promise<bigint> {
    return ugnotFromCoins(await this.rpc.bankBalances(assertAddress(address)));
  }

  /** Owner of a demo relic, or "" if it does not exist. */
  async relicOwner(id: string): Promise<string> {
    return qevalAddress(await this.rpc.qeval(this.demo, `OwnerOfRelic(${goString(id)})`));
  }

  /**
   * Every relic id with its owner. Reads the relics' total supply (an
   * unexported variable, which qeval can read) and asks 25 owners per query.
   */
  async relicOwners(): Promise<Array<{ id: string; owner: string }>> {
    const supply = Number(qevalInt(await this.rpc.qeval(this.demo, 'relics.TotalSupply()')));
    const out: Array<{ id: string; owner: string }> = [];
    for (let start = 1; start <= supply; start += 25) {
      const ids: string[] = [];
      for (let n = start; n <= Math.min(supply, start + 24); n++) ids.push(`relic-${n}`);
      const expr = ids.map((id) => `string(OwnerOfRelic(${goString(id)}))`).join('+","+');
      const owners = qevalString(await this.rpc.qeval(this.demo, expr)).split(',');
      ids.forEach((id, i) => out.push({ id, owner: owners[i] ?? '' }));
    }
    return out;
  }

  /** The relic ids an address holds. */
  async relicsOf(address: string): Promise<string[]> {
    assertAddress(address);
    return (await this.relicOwners()).filter((r) => r.owner === address).map((r) => r.id);
  }

  /**
   * Who holds an MNS name and whether the nsnft adapter could move it now
   * (lease long enough, not frozen or locked). Asks the adapter, which reads
   * the MNS ledger and registry.
   */
  async mnsName(name: string): Promise<MnsName> {
    if (!isMnsName(name)) throw new ParseError('an MNS name is <label>*<domain>');
    const q = goString(name);
    const [owner, why] = await Promise.all([
      this.rpc.qeval(PATHS.adapterMns, `OwnerOf(${q})`, { cacheMs: 2_000 }),
      this.rpc.qeval(PATHS.adapterMns, `Unmovable(${q})`, { cacheMs: 2_000 }),
    ]);
    return { name, owner: qevalAddress(owner), unmovable: qevalString(why) };
  }

  /**
   * When the address may claim from the demo faucet again. Reads kylixdemo's
   * unexported lastClaim tree; the realm has no exported getter for it.
   */
  async faucetStatus(address: string): Promise<FaucetStatus> {
    const [text, st] = await Promise.all([
      this.rpc.qeval(this.demo, `lastClaim.Get(${goString(assertAddress(address))})`, { cacheMs: 2_000 }),
      this.rpc.status(),
    ]);
    const lastClaim = qevalIsUndefined(text) ? null : Number(qevalInt(text));
    const nextClaimHeight = lastClaim === null ? 0 : lastClaim + FAUCET.cooldownBlocks;
    return { lastClaim, nextClaimHeight, canClaimNow: st.height >= nextClaimHeight, height: st.height };
  }

  /**
   * How to approve a token for an offer. The demo tokens share one realm and
   * take a symbol; other tokens are approved at their own realm, which must
   * export Approve(spender, amount) (checked with vm/qfuncs). Null when there
   * is no known way.
   */
  async approveRoute(asset: Asset): Promise<ApproveRoute | null> {
    if (asset.kind === 'item') {
      if (asset.key === this.demo) return { kind: 'relic', pkgPath: this.demo };
      if (asset.key === PATHS.adapterMns) return { kind: 'mns', pkgPath: PATHS.mnsLedger, adapter: PATHS.adapterMns };
      return null;
    }
    const dot = asset.key.lastIndexOf('.');
    if (dot <= 0) return null;
    const pkgPath = asset.key.slice(0, dot);
    const symbol = asset.key.slice(dot + 1);
    if (pkgPath === this.demo) return { kind: 'kylixdemo', pkgPath, symbol };
    let funcs;
    try {
      funcs = await this.rpc.qfuncs(pkgPath);
    } catch (e) {
      if (e instanceof VmError) return null;
      throw e;
    }
    const approve = funcs.find((f) => f.FuncName === 'Approve');
    const params = approve?.Params ?? [];
    const ok =
      params.length === 3 &&
      params[0]!.Type.startsWith('interface {') && // cur realm
      (params[1]!.Type === 'string' || params[1]!.Type === '.uverse.address') &&
      params[2]!.Type === 'int64';
    return ok ? { kind: 'spender-amount', pkgPath } : null;
  }

  /**
   * Rings ready to settle now: finds direct rings of 2 to 6 offers in the
   * book and, when `quote` is given (GnoSwapQuoter.quote), rings with one
   * GnoSwap hop; keeps those whose every offer is deliverable now; and picks
   * a non-overlapping set (longest first, direct before bridged, then oldest
   * offers).
   */
  async readyRings(
    graph?: Graph,
    opts: FindOptions & { quote?: Quote } = {},
  ): Promise<{ graph: Graph; rings: Ring[]; status: Map<number, DeliverableStatus> }> {
    const g = graph ?? (await this.graph());
    const { quote, ...findOpts } = opts;
    const found = findRings(g.offers, { height: g.height, collections: g.collections, ...findOpts });
    if (quote) {
      const bridged = await findBridgedRings(g.offers, quote, { height: g.height, collections: g.collections, ...findOpts, direct: found.rings });
      found.rings.push(...bridged.rings);
    }
    const ids = [...new Set(found.rings.flatMap((r) => r.ids))];
    const status = ids.length ? await this.deliverable(ids) : new Map<number, DeliverableStatus>();
    const ready = found.rings.filter((r) => r.ids.every((id) => status.get(id)?.deliverable === true));
    return { graph: g, rings: selectRings(ready), status };
  }
}
