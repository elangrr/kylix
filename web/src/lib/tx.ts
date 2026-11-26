// Building transactions. Pure functions: no wallet, no network.
//
// Each builder returns a TxPlan: the /vm.m_call messages in the shape Adena's
// DoContract takes ({ type, value }, value in amino JSON field names), the
// gas limit, the fee, and the storage-deposit cap on every message. The
// shapes match the calls scripts/testnet-rehearsal.sh sent on onyx-1.

import { DEPOSIT, GAS, GAS_PER_UGNOT, GNOSWAP_FEE_TIERS, LIMITS, PATHS } from './config.ts';
import type { ApproveRoute, Asset, Offer } from './kylix.ts';
import { assertAddress, assertOfferId } from './parse.ts';

export interface MsgCall {
  /** The signer. Adena fills it in when empty; the wallet layer checks it matches the account. */
  caller: string;
  /** Coins sent with the call, e.g. "1000ugnot". Kylix refuses coins; always "" here. */
  send: string;
  /** Storage-deposit cap for this message, e.g. "500000ugnot". */
  max_deposit: string;
  pkg_path: string;
  func: string;
  args: string[];
}

export interface TxMessage {
  type: '/vm.m_call';
  value: MsgCall;
}

export interface TxPlan {
  messages: TxMessage[];
  gasWanted: number;
  /** In ugnot: the minimum for gasWanted (gasWanted / 1,000, rounded up). */
  gasFee: number;
  /** Sum of the messages' deposit caps, in ugnot: the most storage this transaction can charge. */
  maxDeposit: bigint;
  memo: string;
  /** One line for the confirmation screen. */
  summary: string;
}

/** The minimum fee for a gas limit, in ugnot. */
export function minFee(gasWanted: number): number {
  return Math.ceil(gasWanted / GAS_PER_UGNOT);
}

export function call(
  caller: string,
  pkgPath: string,
  func: string,
  args: Array<string | number | bigint>,
  maxDeposit: bigint,
): TxMessage {
  return {
    type: '/vm.m_call',
    value: {
      caller,
      send: '',
      max_deposit: `${maxDeposit}ugnot`,
      pkg_path: pkgPath,
      func,
      args: args.map(String),
    },
  };
}

function plan(messages: TxMessage[], gasWanted: number, summary: string): TxPlan {
  const maxDeposit = messages.reduce((s, m) => s + BigInt(m.value.max_deposit.replace(/ugnot$/, '') || '0'), 0n);
  return { messages, gasWanted, gasFee: minFee(gasWanted), maxDeposit, memo: '', summary };
}

function checkCaller(caller: string): string {
  return caller === '' ? '' : assertAddress(caller, 'caller');
}

// --- Claim ---------------------------------------------------------------------

/** kylixdemo.Claim: 1,000 OBOL, 1,000 DRACHMA and one relic, once per 720 blocks. */
export function buildClaim(caller: string, demo: string = PATHS.kylixdemo): TxPlan {
  return plan([call(checkCaller(caller), demo, 'Claim', [], DEPOSIT.claim)], GAS.claim, 'Claim demo assets');
}

// --- Approve and post ------------------------------------------------------------

export interface PostInput {
  caller: string;
  give: Asset;
  want: Asset;
  /** From NextSlot(caller): the nonce the offer will get. */
  nonce: number;
  /** From NextSlot(caller): the offer's own address. */
  slot: string;
  /**
   * From ApproveTarget(caller, nonce, give.key). The same as the slot for a
   * token or a native collection; an adapter's sub-address otherwise.
   * Defaults to the slot.
   */
  approveTarget?: string;
  /** How to approve the given asset (KylixClient.approveRoute). */
  route: ApproveRoute;
  /** Last height at which the offer may settle; 0 for the realm's default of 7 days. */
  expiry?: number;
  kylix?: string;
}

/**
 * Approve, then post, in one transaction of two messages. The approval is for
 * exactly the offered amount (or the one item), to the offer's own address,
 * which only this offer can use. PostIntent refuses a token offer whose
 * approval is not exact.
 */
export function buildApproveAndPost(input: PostInput): TxPlan {
  const caller = checkCaller(input.caller);
  const spender = assertAddress(input.approveTarget ?? input.slot, 'approve target');
  assertAddress(input.slot, 'slot');
  if (!Number.isSafeInteger(input.nonce) || input.nonce <= 0) throw new Error(`bad nonce ${input.nonce}`);
  checkOfferSides(input.give, input.want);
  const expiry = input.expiry ?? 0;
  if (!Number.isSafeInteger(expiry) || expiry < 0) throw new Error(`bad expiry ${expiry}`);

  const approve = approveMessage(caller, input.give, spender, input.route);
  const post = postMessage(caller, input.give, input.want, expiry, input.kylix);
  return plan([approve, post], GAS.approve + GAS.post, `Approve and post: give ${assetText(input.give)}, want ${assetText(input.want)}`);
}

/** Only the PostIntent message, for an asset approved earlier (or an unchecked third-party item). */
export function buildPost(caller: string, give: Asset, want: Asset, expiry = 0, kylix?: string): TxPlan {
  checkOfferSides(give, want);
  return plan([postMessage(checkCaller(caller), give, want, expiry, kylix)], GAS.post, `Post: give ${assetText(give)}, want ${assetText(want)}`);
}

/** The approval message alone. */
export function approveMessage(caller: string, give: Asset, spender: string, route: ApproveRoute): TxMessage {
  assertAddress(spender, 'spender');
  switch (route.kind) {
    case 'kylixdemo':
      requireKind(give, 'fungible');
      if (give.key !== `${route.pkgPath}.${route.symbol}`) throw new Error('route does not match the token');
      return call(caller, route.pkgPath, 'Approve', [route.symbol, spender, give.amount], DEPOSIT.approve);
    case 'spender-amount':
      requireKind(give, 'fungible');
      if (!give.key.startsWith(`${route.pkgPath}.`)) throw new Error('route does not match the token');
      return call(caller, route.pkgPath, 'Approve', [spender, give.amount], DEPOSIT.approve);
    case 'relic':
      requireKind(give, 'item');
      if (give.key !== route.pkgPath) throw new Error('route does not match the collection');
      return call(caller, route.pkgPath, 'ApproveRelic', [spender, give.id], DEPOSIT.approve);
  }
}

function postMessage(caller: string, give: Asset, want: Asset, expiry: number, kylix: string = PATHS.kylix): TxMessage {
  return call(
    caller,
    kylix,
    'PostIntent',
    [give.kind, give.key, give.id, give.amount, want.kind, want.key, want.id, want.amount, expiry],
    DEPOSIT.post,
  );
}

function requireKind(a: Asset, kind: Asset['kind']): void {
  if (a.kind !== kind) throw new Error(`expected a ${kind} asset`);
}

/** The realm's own checks on an offer, so a bad offer fails here and not in the wallet. */
export function checkOfferSides(give: Asset, want: Asset): void {
  for (const [side, a] of [['give', give], ['want', want]] as const) {
    if (a.kind === 'fungible') {
      if (!a.key || a.id !== '' || a.amount <= 0n) throw new Error(`${side}: a token needs a key, no id and an amount above 0`);
      if (a.amount > 9_223_372_036_854_775_807n) throw new Error(`${side}: amount does not fit int64`);
    } else if (a.kind === 'item') {
      if (!a.key || a.amount !== 0n) throw new Error(`${side}: an item needs a collection key and amount 0`);
      if (!/^[A-Za-z0-9._:/*-]+$/.test(a.id) || a.id.length > LIMITS.maxItemIdLength) {
        throw new Error(`${side}: item id must be 1-64 characters of A-Z a-z 0-9 . _ : / - *`);
      }
    } else {
      throw new Error(`${side}: unknown kind`);
    }
  }
  if (give.kind === want.kind && give.key === want.key && give.id === want.id) {
    throw new Error('an offer cannot give the asset it wants');
  }
}

// --- Settle ----------------------------------------------------------------------

/** The solver's gas formula: 25M, plus 5M per token offer and 25M per item offer, plus 150M for a GnoSwap hop. */
export function settleGasWanted(offers: Offer[], bridged = false): number {
  let gas = GAS.settleBase;
  for (const o of offers) gas += o.give.kind === 'item' ? GAS.settlePerItemOffer : GAS.settlePerTokenOffer;
  return bridged ? gas + GAS.settleBridge : gas;
}

/**
 * The solver's deposit cap: 0.25 GNOT per token hop, 0.10 GNOT per item hop
 * (the bridged hop counts as a token hop), 0.25 GNOT more for a GnoSwap hop,
 * and at least 0.10 GNOT.
 */
export function settleMaxDeposit(offers: Offer[], bridgedHop = -1): bigint {
  let cap = 0n;
  offers.forEach((o, i) => {
    cap += i === bridgedHop || o.give.kind !== 'item' ? DEPOSIT.settlePerTokenHop : DEPOSIT.settlePerItemHop;
  });
  if (bridgedHop >= 0) cap += DEPOSIT.settleBridgeExtra;
  return cap < DEPOSIT.settlePerItemHop ? DEPOSIT.settlePerItemHop : cap;
}

export interface SettleInput {
  caller: string;
  /** The ring's offers, in ring order. */
  offers: Offer[];
  /**
   * For a ring with a GnoSwap hop: the hop's index and the pool's fee tier.
   * Then SettleRingVia is called with that pool. Without it, SettleRing.
   */
  bridge?: { hop: number; feeTier: number };
  kylix?: string;
}

/** SettleRing(ids), or SettleRingVia(ids, fee) for a ring with a GnoSwap hop. */
export function buildSettle(input: SettleInput): TxPlan {
  const caller = checkCaller(input.caller);
  const n = input.offers.length;
  if (n < LIMITS.ringMinLegs || n > LIMITS.ringMaxLegs) throw new Error(`a ring has 2 to 6 offers, not ${n}`);
  const ids = input.offers.map((o) => assertOfferId(o.id)).join(',');
  const kylix = input.kylix ?? PATHS.kylix;
  const b = input.bridge;
  if (b) {
    if (!(GNOSWAP_FEE_TIERS as readonly number[]).includes(b.feeTier)) throw new Error(`fee tier must be one of ${GNOSWAP_FEE_TIERS.join(', ')}`);
    if (!Number.isInteger(b.hop) || b.hop < 0 || b.hop >= n) throw new Error('bridged hop out of range');
  }
  const gas = settleGasWanted(input.offers, !!b);
  const cap = settleMaxDeposit(input.offers, b ? b.hop : -1);
  const msg = b
    ? call(caller, kylix, 'SettleRingVia', [ids, b.feeTier], cap)
    : call(caller, kylix, 'SettleRing', [ids], cap);
  return plan([msg], gas, `Settle ring ${ids}`);
}

// --- Cancel and prune --------------------------------------------------------------

/** CancelIntent(id): owner only, and not with a session key. */
export function buildCancel(caller: string, id: number, kylix: string = PATHS.kylix): TxPlan {
  return plan([call(checkCaller(caller), kylix, 'CancelIntent', [assertOfferId(id)], DEPOSIT.cancel)], GAS.cancel, `Cancel offer ${id}`);
}

/** PruneIntent(id): anyone, on an expired offer. The freed deposit goes to the caller. */
export function buildPrune(caller: string, id: number, kylix: string = PATHS.kylix): TxPlan {
  return plan([call(checkCaller(caller), kylix, 'PruneIntent', [assertOfferId(id)], DEPOSIT.prune)], GAS.prune, `Remove expired offer ${id}`);
}

// --- Text ----------------------------------------------------------------------

/** "100 gno.land/r/x.FOO" or "gno.land/r/y #relic-7". Full keys, so a look-alike shows. */
export function assetText(a: Asset): string {
  return a.kind === 'item' ? `${a.key} #${a.id}` : `${a.amount} ${a.key}`;
}

/** Fills an empty caller with the signing account's address. */
export function withCaller(p: TxPlan, address: string): TxPlan {
  return {
    ...p,
    messages: p.messages.map((m) => ({ ...m, value: { ...m.value, caller: m.value.caller || address } })),
  };
}
