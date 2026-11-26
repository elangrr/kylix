// How assets are named on screen, and how amounts are written and read.
//
// Token keys, symbols, collection names and item ids all come from the chain,
// where anyone can register a token with any symbol. A token in TOKENS is
// named by its symbol with a note saying which one it is; any other token is
// named by its full key, so a look-alike symbol cannot pass for a known token.

import { PATHS, TOKENS } from '../lib/config.ts'
import type { Asset, Collection } from '../lib/kylix.ts'

export interface KnownToken {
  key: string
  symbol: string
  /** Read from grc20reg on onyx-1. */
  decimals: number
  note: string
}

export const KNOWN_TOKENS: KnownToken[] = [
  { key: TOKENS.OBOL, symbol: 'OBOL', decimals: 0, note: 'demo token' },
  { key: TOKENS.DRACHMA, symbol: 'DRACHMA', decimals: 0, note: 'demo token' },
  { key: TOKENS.WUGNOT, symbol: 'wugnot', decimals: 0, note: 'wrapped GNOT, in ugnot' },
  { key: TOKENS.GNS, symbol: 'GNS', decimals: 6, note: 'GnoSwap token' },
]

export function knownToken(key: string): KnownToken | undefined {
  return KNOWN_TOKENS.find((t) => t.key === key)
}

/** Writes a base-unit amount with the token's decimals: 1500000 with 6 decimals is "1.5". */
export function formatUnits(amount: bigint, decimals: number): string {
  if (decimals <= 0) return amount.toLocaleString('en-US')
  const neg = amount < 0n
  const abs = neg ? -amount : amount
  const scale = 10n ** BigInt(decimals)
  const whole = (abs / scale).toLocaleString('en-US')
  const frac = (abs % scale).toString().padStart(decimals, '0').replace(/0+$/, '')
  return `${neg ? '-' : ''}${whole}${frac ? `.${frac}` : ''}`
}

const INT64_MAX = 9_223_372_036_854_775_807n

/**
 * Reads an amount typed by the user into base units. Accepts digits with an
 * optional decimal point and thousands commas. Returns an error message when
 * the text is not a positive amount the token can hold.
 */
export function parseUnits(text: string, decimals: number): { ok: true; value: bigint } | { ok: false; error: string } {
  const t = text.trim().replace(/,/g, '')
  if (t === '') return { ok: false, error: 'Enter an amount.' }
  const m = /^(\d*)(?:\.(\d*))?$/.exec(t)
  if (!m || (m[1] === '' && (m[2] ?? '') === '')) return { ok: false, error: 'Use digits only, with an optional decimal point.' }
  const whole = m[1] ?? ''
  const frac = m[2] ?? ''
  if (frac.length > decimals) {
    return { ok: false, error: decimals === 0 ? 'This token has no decimals. Enter a whole number.' : `This token has ${decimals} decimals at most.` }
  }
  const value = BigInt(whole || '0') * 10n ** BigInt(decimals) + BigInt(frac.padEnd(decimals, '0') || '0')
  if (value <= 0n) return { ok: false, error: 'The amount must be above 0.' }
  if (value > INT64_MAX) return { ok: false, error: 'The amount is too large.' }
  return { ok: true, value }
}

/** The parts of an asset's name, for display. */
export interface AssetName {
  /** The main text: "100 OBOL", "relic-1", or "100 units". */
  main: string
  /** A short note: "demo token", "Kylix Relics", "unlisted token". */
  note: string
  /** The full key, shown in small type for anything outside the known set. */
  key?: string
  /** True for a token or collection outside the known set. */
  unlisted: boolean
}

export function tokenAmountText(key: string, amount: bigint): string {
  const k = knownToken(key)
  return k ? `${formatUnits(amount, k.decimals)} ${k.symbol}` : `${amount.toLocaleString('en-US')} units of ${key}`
}

export function assetName(a: Asset, collections: Collection[] = []): AssetName {
  if (a.kind === 'fungible') {
    const k = knownToken(a.key)
    if (k) return { main: `${formatUnits(a.amount, k.decimals)} ${k.symbol}`, note: k.note, unlisted: false }
    return { main: `${a.amount.toLocaleString('en-US')} units`, note: 'unlisted token', key: a.key, unlisted: true }
  }
  if (a.key === PATHS.kylixdemo) return { main: a.id, note: 'Kylix Relics, demo relic', unlisted: false }
  const c = collections.find((x) => x.key === a.key)
  if (!c) return { main: a.id, note: 'unregistered collection', key: a.key, unlisted: true }
  return { main: a.id, note: `${c.name}, ${c.label || (c.official ? 'official' : 'third-party')}`, key: a.key, unlisted: !c.official }
}

/** One line of plain text for an asset, for labels and announcements. */
export function assetPlain(a: Asset, collections: Collection[] = []): string {
  const n = assetName(a, collections)
  return [n.main, `(${n.note})`, n.key ?? ''].filter(Boolean).join(' ')
}

/** "g1wpca…vxds" */
export function shortAddress(addr: string): string {
  return addr.length > 14 ? `${addr.slice(0, 6)}…${addr.slice(-4)}` : addr
}

/** Rough time for a number of blocks, at about 5 seconds a block. */
export function blocksToText(blocks: number): string {
  if (blocks <= 0) return 'now'
  const minutes = Math.round((blocks * 5) / 60)
  if (minutes < 2) return 'about a minute'
  if (minutes < 90) return `about ${minutes} minutes`
  const hours = Math.round(minutes / 60)
  if (hours < 36) return `about ${hours} hours`
  return `about ${Math.round(hours / 24)} days`
}
