// The life of one transaction on the page, as a reducer: reading the chain to
// build it, waiting for the signature, sent, in a block, or failed. Only one
// transaction runs at a time, because Adena opens one approval window at a
// time.

import { RpcError, VmError } from '../lib/rpc.ts'
import { WalletError, cleanChainError } from '../lib/wallet.ts'

export interface TxMeta {
  /** What the transaction does, in a few words: "Settle ring 4, 5, 6". */
  label: string
  /** A page on the testnet's web view to look at afterwards. */
  link?: { href: string; text: string }
}

export type TxState =
  | { phase: 'idle' }
  | { phase: 'preparing'; meta: TxMeta }
  | { phase: 'signing'; meta: TxMeta }
  | { phase: 'sent'; meta: TxMeta; hash: string }
  | { phase: 'landed'; meta: TxMeta; hash: string; height?: number }
  | { phase: 'failed'; meta: TxMeta; message: string; hash?: string }

export type TxEvent =
  | { type: 'start'; meta: TxMeta }
  | { type: 'built' }
  | { type: 'sent'; hash: string }
  | { type: 'landed'; hash: string; height?: number }
  | { type: 'failed'; message: string; hash?: string }
  | { type: 'dismiss' }

export const idleTx: TxState = { phase: 'idle' }

export function isBusy(s: TxState): boolean {
  return s.phase === 'preparing' || s.phase === 'signing' || s.phase === 'sent'
}

export function txReducer(s: TxState, e: TxEvent): TxState {
  switch (e.type) {
    case 'start':
      return isBusy(s) ? s : { phase: 'preparing', meta: e.meta }
    case 'built':
      return s.phase === 'preparing' ? { phase: 'signing', meta: s.meta } : s
    case 'sent':
      return s.phase === 'signing' ? { phase: 'sent', meta: s.meta, hash: e.hash } : s
    case 'landed':
      return s.phase === 'signing' || s.phase === 'sent'
        ? { phase: 'landed', meta: s.meta, hash: e.hash, ...(e.height !== undefined ? { height: e.height } : {}) }
        : s
    case 'failed':
      return s.phase === 'preparing' || s.phase === 'signing' || s.phase === 'sent'
        ? { phase: 'failed', meta: s.meta, message: e.message, ...(e.hash ? { hash: e.hash } : {}) }
        : s
    case 'dismiss':
      return isBusy(s) ? s : idleTx
  }
}

/** One sentence for the status line and the screen reader. */
export function txSentence(s: TxState): string {
  switch (s.phase) {
    case 'idle':
      return ''
    case 'preparing':
      return `${s.meta.label}: reading the chain to build the transaction.`
    case 'signing':
      return `${s.meta.label}: waiting for your signature in the wallet.`
    case 'sent':
      return `${s.meta.label}: sent, waiting for a block.`
    case 'landed':
      return `${s.meta.label}: done${s.height ? `, in block ${s.height.toLocaleString('en-US')}` : ''}.`
    case 'failed':
      return `${s.meta.label} failed: ${s.message}`
  }
}

/** A readable reason for any error a transaction can end with. */
export function errorText(e: unknown): string {
  if (e instanceof WalletError) {
    switch (e.kind) {
      case 'rejected':
        return 'You declined it in the wallet. Nothing was sent.'
      case 'not-installed':
        return 'Adena is not installed in this browser.'
      case 'not-connected':
      case 'no-account':
        return 'Connect your wallet first.'
      case 'locked':
        return 'The wallet is locked. Unlock it and try again.'
      case 'wrong-network':
        return 'The wallet is on another network. Switch it to onyx-1.'
      case 'wrong-account':
        return 'The wallet’s account changed. Reload the page data and try again.'
      case 'busy':
        return 'The wallet already has a request open. Finish or close it first.'
      case 'timeout':
        return 'The wallet timed out waiting for the network.'
      case 'failed':
        return `The chain refused it: ${cleanChainError(e.message)}`
      default:
        return e.message || 'The wallet returned an error.'
    }
  }
  if (e instanceof VmError) return `The chain refused it: ${e.message}`
  if (e instanceof RpcError) {
    return e.status === 429 ? 'The testnet is busy and asked us to slow down. Try again in a minute.' : `Could not reach the testnet: ${e.message}`
  }
  if (e instanceof Error) return e.message
  return String(e)
}
