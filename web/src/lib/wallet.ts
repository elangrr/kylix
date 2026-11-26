// Signing. A small Wallet interface, an implementation over the Adena
// extension's injected window.adena, and a mock for tests.
//
// What this relies on, read in Adena's source (onbloc/adena-wallet 1.22.5,
// packages/adena-extension/src/inject.ts and the approve-transaction page) and
// @adena-wallet/sdk 0.1.3's types:
//   - AddEstablish(siteName) connects; ALREADY_CONNECTED also means connected.
//   - GetAccount / GetNetwork return { status, type, code, message, data }.
//   - SwitchNetwork(chainId) answers UNADDED_NETWORK if the wallet does not
//     know the chain; AddNetwork({ chainId, chainName, rpcUrl }) adds it.
//     onyx-1 ships as a default network in 1.22.5.
//   - DoContract({ messages, gasFee, gasWanted, memo }) signs and broadcasts
//     every message in one transaction. Each /vm.m_call keeps its own send
//     and max_deposit. Adena simulates the transaction and sets the gas limit
//     and fee itself (gas used x 1.1 at its default "average" setting), so
//     our gasWanted and gasFee are a starting point, not what is signed.
//   - By default DoContract broadcasts with broadcast_tx_sync and answers
//     with { hash } only. A request field `commit: true` (read in the
//     approve page, not in the SDK's types) makes it wait for the block and
//     answer with check_tx and deliver_tx.
//   - On("changedAccount" | "changedNetwork", cb) has no way to unsubscribe,
//     and Adena stops the event after the first listener, so register once
//     per page (AdenaWallet does) and fan out from there.

import { CHAIN_ID, CHAIN_NAME, WALLET_RPC_URL } from './config.ts';
import { parseQeval, textFromBase64 } from './parse.ts';
import type { GnoValue } from './parse.ts';
import { withCaller } from './tx.ts';
import type { TxMessage, TxPlan } from './tx.ts';

export interface WalletAccount {
  address: string;
  chainId: string;
  /** e.g. "34668423ugnot" */
  coins: string;
}

export interface WalletNetwork {
  chainId: string;
  rpcUrl: string;
}

export interface SendResult {
  hash: string;
  /** Block height, when the wallet waited for the block. */
  height?: number;
  /** True when the wallet waited for the block and the transaction succeeded there. */
  committed: boolean;
  gasUsed?: number;
  gasWanted?: number;
  /** The values the calls returned, decoded (for PostIntent, the offer id). */
  returned: GnoValue[];
}

export type WalletErrorKind =
  | 'not-installed'
  | 'not-connected'
  | 'locked'
  | 'no-account'
  | 'rejected'
  | 'wrong-network'
  | 'wrong-account'
  | 'busy' // another approval window is open
  | 'invalid' // the wallet refused the request's format
  | 'failed' // the chain refused the transaction, or broadcasting failed
  | 'timeout'
  | 'unsupported'
  | 'unknown';

export class WalletError extends Error {
  readonly kind: WalletErrorKind;
  /** Adena's response type, e.g. "TRANSACTION_REJECTED". */
  readonly type: string;
  readonly code: number;
  /** Extra detail from the wallet: the chain's error text and log, the hash. */
  readonly detail: unknown;
  constructor(kind: WalletErrorKind, message: string, type = '', code = 0, detail?: unknown) {
    super(message);
    this.name = 'WalletError';
    this.kind = kind;
    this.type = type;
    this.code = code;
    this.detail = detail;
  }
}

export interface Wallet {
  readonly name: string;
  isInstalled(): boolean;
  /** Asks the user to connect this site, then returns the account. */
  connect(siteName: string): Promise<WalletAccount>;
  /** The connected account, or null when not connected or locked. */
  account(): Promise<WalletAccount | null>;
  network(): Promise<WalletNetwork | null>;
  /** Makes onyx-1 the wallet's network, adding it if the wallet does not know it. */
  ensureNetwork(): Promise<void>;
  /** Signs and broadcasts the plan's messages as one transaction. */
  signAndSend(plan: TxPlan): Promise<SendResult>;
  onAccountChange(cb: (address: string) => void): () => void;
  onNetworkChange(cb: (chainId: string) => void): () => void;
}

// --- Adena -------------------------------------------------------------------------

interface AdenaResponse<D = unknown> {
  code: number;
  status: 'success' | 'failure';
  type: string;
  message: string;
  data: D;
}

/** The part of window.adena this file uses. */
export interface AdenaInjected {
  version?: string;
  AddEstablish(name: string, chainIds?: string | string[]): Promise<AdenaResponse>;
  GetAccount(): Promise<AdenaResponse<{ address: string; chainId: string; coins: string } | null>>;
  GetNetwork(): Promise<AdenaResponse<{ chainId: string; rpcUrl: string } | null>>;
  SwitchNetwork(chainId: string): Promise<AdenaResponse>;
  AddNetwork(network: { chainId: string; chainName: string; rpcUrl: string }): Promise<AdenaResponse>;
  DoContract(params: {
    messages: TxMessage[];
    gasFee: number;
    gasWanted: number;
    memo?: string;
    commit?: boolean;
  }): Promise<AdenaResponse<unknown>>;
  On(event: 'changedAccount' | 'changedNetwork', cb: (value: string) => void): unknown;
}

declare global {
  interface Window {
    adena?: AdenaInjected;
  }
}

const KIND_BY_TYPE: Record<string, WalletErrorKind> = {
  NOT_CONNECTED: 'not-connected',
  WALLET_LOCKED: 'locked',
  NO_ACCOUNT: 'no-account',
  ACCOUNT_MISMATCH: 'wrong-account',
  UNRESOLVED_TRANSACTION_EXISTS: 'busy',
  INVALID_FORMAT: 'invalid',
  TRANSACTION_REJECTED: 'rejected',
  SIGN_REJECTED: 'rejected',
  CONNECTION_REJECTED: 'rejected',
  SWITCH_NETWORK_REJECTED: 'rejected',
  ADD_NETWORK_REJECTED: 'rejected',
  TRANSACTION_FAILED: 'failed',
  SIGN_FAILED: 'failed',
  NETWORK_TIMEOUT: 'timeout',
  UNADDED_NETWORK: 'wrong-network',
  NOT_INITIALIZED_NETWORK: 'wrong-network',
  UNSUPPORTED_TYPE: 'unsupported',
};

/** Turns a failed Adena response into a WalletError. */
export function adenaError(r: AdenaResponse<unknown>, what: string): WalletError {
  const kind = KIND_BY_TYPE[r.type] ?? 'unknown';
  const detail = r.data as { error?: string; log?: string } | null;
  let message = r.message || `${what} failed`;
  if (kind === 'failed' && detail && typeof detail.error === 'string') message = cleanChainError(detail.error);
  return new WalletError(kind, message, r.type, r.code, r.data);
}

/** Keeps the realm's panic text, drops the VM's stack trace. */
export function cleanChainError(s: string): string {
  const panic = /panic: ([^\n]+)/.exec(s);
  if (panic) return panic[1]!.trim();
  return s.split('\n')[0]!.trim();
}

/**
 * Reads the result of DoContract: broadcast_tx_commit
 * ({ hash, height, check_tx, deliver_tx }) or broadcast_tx_sync ({ hash, ... }).
 */
export function parseSendResult(data: unknown): SendResult {
  const d = (data ?? {}) as Record<string, unknown>;
  const hash = typeof d.hash === 'string' ? d.hash : '';
  const check = d.check_tx as TxResponse | undefined;
  const deliver = d.deliver_tx as TxResponse | undefined;
  if (!deliver && !check) {
    const syncErr = d.error;
    if (syncErr) throw new WalletError('failed', cleanChainError(errorValue(syncErr, String(d.Log || ''), 'broadcast failed')), 'TRANSACTION_FAILED', 4001, data);
    return { hash, committed: false, returned: [] };
  }
  // CheckTx refused it (bad sequence, fee, gas or signature): it never reached a block.
  const checkBase = check?.ResponseBase ?? {};
  if (checkBase.Error) {
    throw new WalletError('failed', cleanChainError(errorValue(checkBase.Error, checkBase.Log, 'the chain refused the transaction')), 'TRANSACTION_FAILED', 4001, data);
  }
  const base = deliver?.ResponseBase ?? {};
  if (base.Error) {
    throw new WalletError('failed', cleanChainError(errorValue(base.Error, base.Log, 'transaction failed')), 'TRANSACTION_FAILED', 4001, data);
  }
  // A committed transaction is in a block. Without a height, nothing says it
  // is, and nothing says it failed either: report it as sent, so the caller
  // confirms it through the indexer. Calling it failed could lead the user to
  // send it twice.
  const height = Number(d.height);
  if (!deliver || !Number.isSafeInteger(height) || height <= 0) {
    if (hash === '') {
      throw new WalletError('failed', 'The wallet answered without a block height or a transaction hash.', 'TRANSACTION_FAILED', 4001, data);
    }
    return { hash, committed: false, returned: [] };
  }
  let returned: GnoValue[] = [];
  if (base.Data) {
    try {
      returned = parseQeval(textFromBase64(base.Data));
    } catch {
      returned = [];
    }
  }
  return {
    hash,
    committed: true,
    height,
    ...(deliver.GasUsed ? { gasUsed: Number(deliver.GasUsed) } : {}),
    ...(deliver.GasWanted ? { gasWanted: Number(deliver.GasWanted) } : {}),
    returned,
  };
}

interface TxResponse {
  ResponseBase?: { Error?: unknown; Data?: string | null; Log?: string };
  GasUsed?: string;
  GasWanted?: string;
}

/**
 * The text of a TM2 error ({ "@type", value }): its value, else the log, else
 * its type name ("InvalidSequenceError"), else the fallback. Empty strings
 * count as missing.
 */
function errorValue(e: unknown, log: string | undefined, fallback: string): string {
  if (typeof e === 'string' && e) return e;
  const o = (e ?? {}) as { value?: unknown; '@type'?: unknown };
  if (typeof o.value === 'string' && o.value) return o.value;
  if (log) return log;
  if (typeof o['@type'] === 'string' && o['@type']) return o['@type'].replace(/^.*[./]/, '');
  return fallback;
}

/** The offer id a PostIntent returned, from a committed result. */
export function postedOfferId(r: SendResult): number | null {
  const v = r.returned.find((x) => x.type === 'uint64');
  return v ? Number(v.value) : null;
}

export interface AdenaOptions {
  /** Wait for the block (broadcast_tx_commit). Default true. */
  commit?: boolean;
  /** Where to find window.adena; for tests. */
  getAdena?: () => AdenaInjected | undefined;
}

export class AdenaWallet implements Wallet {
  readonly name = 'Adena';
  private readonly commit: boolean;
  private readonly getAdena: () => AdenaInjected | undefined;
  private readonly accountSubs = new Set<(a: string) => void>();
  private readonly networkSubs = new Set<(c: string) => void>();
  private listening = false;

  constructor(opts: AdenaOptions = {}) {
    this.commit = opts.commit ?? true;
    this.getAdena = opts.getAdena ?? (() => (typeof window === 'undefined' ? undefined : window.adena));
  }

  isInstalled(): boolean {
    const a = this.getAdena();
    // window.adena can appear after subscribers asked for events; register
    // with it the first time it is seen.
    if (a) this.listen(a);
    return !!a;
  }

  /** The extension injects window.adena after the page starts; wait for it a little. */
  async waitInstalled(timeoutMs = 3_000): Promise<boolean> {
    const until = Date.now() + timeoutMs;
    while (!this.isInstalled() && Date.now() < until) await new Promise((r) => setTimeout(r, 100));
    return this.isInstalled();
  }

  private adena(): AdenaInjected {
    const a = this.getAdena();
    if (!a) throw new WalletError('not-installed', 'Adena is not installed in this browser');
    this.listen(a);
    return a;
  }

  async connect(siteName: string): Promise<WalletAccount> {
    const r = await this.adena().AddEstablish(siteName);
    if (r.status !== 'success' && r.type !== 'ALREADY_CONNECTED') throw adenaError(r, 'connect');
    const acc = await this.account();
    if (!acc) throw new WalletError('no-account', 'Connected, but Adena returned no account');
    return acc;
  }

  async account(): Promise<WalletAccount | null> {
    const r = await this.adena().GetAccount();
    if (r.status !== 'success' || !r.data) {
      if (r.type === 'NOT_CONNECTED' || r.type === 'WALLET_LOCKED' || r.type === 'NO_ACCOUNT') return null;
      throw adenaError(r, 'get account');
    }
    return { address: r.data.address, chainId: r.data.chainId, coins: r.data.coins ?? '' };
  }

  async network(): Promise<WalletNetwork | null> {
    const r = await this.adena().GetNetwork();
    if (r.status !== 'success' || !r.data) {
      if (r.type === 'NOT_CONNECTED' || r.type === 'WALLET_LOCKED' || r.type === 'NO_ACCOUNT') return null;
      throw adenaError(r, 'get network');
    }
    return { chainId: r.data.chainId, rpcUrl: r.data.rpcUrl };
  }

  async ensureNetwork(): Promise<void> {
    const net = await this.network();
    if (net?.chainId === CHAIN_ID) return;
    const a = this.adena();
    let r = await a.SwitchNetwork(CHAIN_ID);
    if (r.type === 'UNADDED_NETWORK') {
      const added = await a.AddNetwork({ chainId: CHAIN_ID, chainName: CHAIN_NAME, rpcUrl: WALLET_RPC_URL });
      if (added.status !== 'success') throw adenaError(added, 'add network');
      r = await a.SwitchNetwork(CHAIN_ID);
    }
    if (r.status !== 'success' && r.type !== 'REDUNDANT_CHANGE_REQUEST') throw adenaError(r, 'switch network');
    const after = await this.network();
    if (after?.chainId !== CHAIN_ID) {
      throw new WalletError('wrong-network', `Adena is on ${after?.chainId ?? 'no network'}, not ${CHAIN_ID}`);
    }
  }

  async signAndSend(p: TxPlan): Promise<SendResult> {
    const acc = await this.account();
    if (!acc) throw new WalletError('not-connected', 'Connect Adena first');
    if (acc.chainId !== CHAIN_ID) {
      throw new WalletError('wrong-network', `Adena is on ${acc.chainId}, not ${CHAIN_ID}`);
    }
    const filled = withCaller(p, acc.address);
    for (const m of filled.messages) {
      if (m.value.caller !== acc.address) {
        throw new WalletError('wrong-account', `This transaction is for ${m.value.caller}, but Adena's account is ${acc.address}`);
      }
    }
    const r = await this.adena().DoContract({
      messages: filled.messages,
      gasFee: filled.gasFee,
      gasWanted: filled.gasWanted,
      memo: filled.memo,
      ...(this.commit ? { commit: true } : {}),
    });
    if (r.status !== 'success') throw adenaError(r, 'transaction');
    return parseSendResult(r.data);
  }

  onAccountChange(cb: (address: string) => void): () => void {
    this.listen();
    this.accountSubs.add(cb);
    return () => this.accountSubs.delete(cb);
  }

  onNetworkChange(cb: (chainId: string) => void): () => void {
    this.listen();
    this.networkSubs.add(cb);
    return () => this.networkSubs.delete(cb);
  }

  /**
   * Registers with Adena once, as soon as window.adena exists. Called from
   * every path that touches the extension, so a late injection still gets
   * the listeners of whoever subscribed before it.
   */
  private listen(a: AdenaInjected | undefined = this.getAdena()): void {
    if (this.listening) return;
    if (!a) return;
    this.listening = true;
    a.On('changedAccount', (v) => this.accountSubs.forEach((cb) => cb(v)));
    a.On('changedNetwork', (v) => this.networkSubs.forEach((cb) => cb(v)));
  }
}

// --- Mock ----------------------------------------------------------------------------

export interface MockWalletOptions {
  address?: string;
  chainId?: string;
  coins?: string;
  /** What signAndSend answers; a function gets the plan. Default: committed, no return values. */
  result?: SendResult | WalletError | ((p: TxPlan) => SendResult | WalletError);
  installed?: boolean;
}

/** Records what it was asked to sign. Never touches a network. */
export class MockWallet implements Wallet {
  readonly name = 'Mock';
  readonly sent: TxPlan[] = [];
  connected = false;
  address: string;
  chainId: string;
  coins: string;
  result: MockWalletOptions['result'];
  private readonly installed: boolean;
  private readonly accountSubs = new Set<(a: string) => void>();
  private readonly networkSubs = new Set<(c: string) => void>();

  constructor(opts: MockWalletOptions = {}) {
    this.address = opts.address ?? 'g1jg8mtutu9khhfwc4nxmuhcpftf0pajdhfvsqf5';
    this.chainId = opts.chainId ?? CHAIN_ID;
    this.coins = opts.coins ?? '10000000ugnot';
    this.result = opts.result;
    this.installed = opts.installed ?? true;
  }

  isInstalled(): boolean {
    return this.installed;
  }

  async connect(): Promise<WalletAccount> {
    if (!this.installed) throw new WalletError('not-installed', 'not installed');
    this.connected = true;
    return { address: this.address, chainId: this.chainId, coins: this.coins };
  }

  async account(): Promise<WalletAccount | null> {
    return this.connected ? { address: this.address, chainId: this.chainId, coins: this.coins } : null;
  }

  async network(): Promise<WalletNetwork | null> {
    return this.connected ? { chainId: this.chainId, rpcUrl: WALLET_RPC_URL } : null;
  }

  async ensureNetwork(): Promise<void> {
    if (this.chainId !== CHAIN_ID) this.switchTo(CHAIN_ID);
  }

  async signAndSend(p: TxPlan): Promise<SendResult> {
    if (!this.connected) throw new WalletError('not-connected', 'Connect first');
    if (this.chainId !== CHAIN_ID) throw new WalletError('wrong-network', `on ${this.chainId}`);
    const filled = withCaller(p, this.address);
    for (const m of filled.messages) {
      if (m.value.caller !== this.address) throw new WalletError('wrong-account', 'caller is not the account');
    }
    this.sent.push(filled);
    const r = typeof this.result === 'function' ? this.result(filled) : this.result;
    if (r instanceof WalletError) throw r;
    return r ?? { hash: `mock-${this.sent.length}`, committed: true, returned: [] };
  }

  /** Simulates the user switching accounts in the wallet. */
  switchAccount(address: string): void {
    this.address = address;
    this.accountSubs.forEach((cb) => cb(address));
  }

  /** Simulates the user switching networks in the wallet. */
  switchTo(chainId: string): void {
    this.chainId = chainId;
    this.networkSubs.forEach((cb) => cb(chainId));
  }

  onAccountChange(cb: (address: string) => void): () => void {
    this.accountSubs.add(cb);
    return () => this.accountSubs.delete(cb);
  }

  onNetworkChange(cb: (chainId: string) => void): () => void {
    this.networkSubs.add(cb);
    return () => this.networkSubs.delete(cb);
  }
}
