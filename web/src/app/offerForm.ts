// The post-an-offer form: its fields, and the checks run before anything is
// signed. The checks are the realm's own (checkOfferSides, LIMITS) plus a few
// that only the app can make, such as whether the account holds what it
// offers.

import { LIMITS, PATHS } from '../lib/config.ts'
import type { Asset } from '../lib/kylix.ts'
import { isMnsName } from '../lib/kylix.ts'
import { checkOfferSides } from '../lib/tx.ts'
import { knownToken, parseUnits } from './assets.ts'

export const OTHER_TOKEN = 'other'
/** The giveItem value for "an MNS name I type". */
export const MNS_ITEM = 'mns'

export interface OfferForm {
  giveKind: 'fungible' | 'item'
  /** A known token key, or OTHER_TOKEN. */
  giveToken: string
  giveTokenOther: string
  giveAmount: string
  /** "<collection key>#<item id>" of an item the account holds, or MNS_ITEM. */
  giveItem: string
  /** With MNS_ITEM: the name as <label>*<domain>. */
  giveMnsName: string
  wantKind: 'fungible' | 'item'
  wantToken: string
  wantTokenOther: string
  wantAmount: string
  wantCollection: string
  wantItemId: string
  /** "" for the realm's default of 7 days, otherwise a number of days. */
  expiryDays: string
}

export const EXPIRY_CHOICES = [
  { value: '1', label: '1 day' },
  { value: '3', label: '3 days' },
  { value: '', label: '7 days (the default)' },
  { value: '14', label: '14 days' },
  { value: '30', label: '30 days (the longest allowed)' },
] as const

export function emptyForm(): OfferForm {
  return {
    giveKind: 'fungible',
    giveToken: `${PATHS.kylixdemo}.OBOL`,
    giveTokenOther: '',
    giveAmount: '',
    giveItem: '',
    giveMnsName: '',
    wantKind: 'fungible',
    wantToken: `${PATHS.kylixdemo}.DRACHMA`,
    wantTokenOther: '',
    wantAmount: '',
    wantCollection: PATHS.kylixdemo,
    wantItemId: '',
    expiryDays: '',
  }
}

export type FormField = keyof OfferForm | 'form'
export type FormErrors = Partial<Record<FormField, string>>

export interface FormContext {
  /** Current chain height, for the expiry. */
  height: number
  /** Token balances of the account; a missing key means unknown. */
  balances?: Map<string, bigint | null>
  /** Items the account holds, as "<key>#<id>". */
  items?: string[]
}

export type FormResult =
  | { ok: true; give: Asset; want: Asset; expiry: number }
  | { ok: false; errors: FormErrors }

// A grc20reg key is the token realm's path, a dot and the token's symbol
// (fqname.Construct in r/nt/grc20reg/v0). r/kylix accepts any key grc20reg
// knows. Each path segment follows gno's package path rule (Re_name in
// gnovm/pkg/gnolang/mempackage.go): a lowercase letter, then letters and
// digits, with single - or _ between them, as in nym-kylix000. The symbol is
// what p/nt/grc20/v0 allows: 1 to 11 of A-Z a-z 0-9 _ -.
const PATH_SEGMENT = '[a-z][a-z0-9]*(?:[_-][a-z0-9]+)*'
const TOKEN_KEY = new RegExp(`^gno\\.land/r/${PATH_SEGMENT}(?:/${PATH_SEGMENT})*\\.[A-Za-z0-9_-]{1,11}$`)
const COLLECTION_KEY = /^gno\.land\/r\/[a-z0-9_-]+(?:\/[a-z0-9_.-]+)*$/

export function validTokenKey(key: string): boolean {
  return TOKEN_KEY.test(key)
}

function tokenSide(
  side: 'give' | 'want',
  choice: string,
  other: string,
  amountText: string,
  errors: FormErrors,
): Asset | null {
  const key = choice === OTHER_TOKEN ? other.trim() : choice
  const otherField = side === 'give' ? 'giveTokenOther' : 'wantTokenOther'
  const amountField = side === 'give' ? 'giveAmount' : 'wantAmount'
  if (choice === OTHER_TOKEN) {
    if (!validTokenKey(key)) {
      errors[otherField] = 'Enter the token’s full key: its realm path, a dot and its symbol, as gno.land/r/demo/tokens.FOO.'
      return null
    }
    // A known token typed here would be read in base units while the rest of
    // the page writes it with decimals. Send the user to the list instead.
    const known = knownToken(key)
    if (known) {
      errors[otherField] = `This is ${known.symbol}. Choose ${known.symbol} from the token list instead.`
      return null
    }
  }
  // "Another token" is always entered in base units.
  const decimals = choice === OTHER_TOKEN ? 0 : (knownToken(key)?.decimals ?? 0)
  const amount = parseUnits(amountText, decimals)
  if (!amount.ok) {
    errors[amountField] = amount.error
    return null
  }
  return { kind: 'fungible', key, id: '', amount: amount.value }
}

export function validateOffer(f: OfferForm, ctx: FormContext): FormResult {
  const errors: FormErrors = {}

  let give: Asset | null = null
  if (f.giveKind === 'fungible') {
    give = tokenSide('give', f.giveToken, f.giveTokenOther, f.giveAmount, errors)
    const bal = give ? ctx.balances?.get(give.key) : undefined
    if (give && bal != null && bal < give.amount) errors.giveAmount = 'You hold less than this amount.'
    if (give && bal === null) errors.giveTokenOther = 'No token is registered under this key.'
  } else if (f.giveItem === MNS_ITEM) {
    // Who holds the name, and whether its lease allows a move, is asked on chain before signing.
    const name = f.giveMnsName.trim()
    if (!isMnsName(name) || name.length > LIMITS.maxItemIdLength || !/^[A-Za-z0-9._:/*-]+$/.test(name)) {
      errors.giveMnsName = 'Enter the name as label*domain, for example alice*gno.'
    } else {
      give = { kind: 'item', key: PATHS.adapterMns, id: name, amount: 0n }
    }
  } else {
    const hash = f.giveItem.indexOf('#')
    if (!f.giveItem || hash <= 0) {
      errors.giveItem = 'Choose an item you hold.'
    } else {
      give = { kind: 'item', key: f.giveItem.slice(0, hash), id: f.giveItem.slice(hash + 1), amount: 0n }
      if (ctx.items && !ctx.items.includes(f.giveItem)) errors.giveItem = 'You do not hold this item.'
    }
  }

  let want: Asset | null = null
  if (f.wantKind === 'fungible') {
    want = tokenSide('want', f.wantToken, f.wantTokenOther, f.wantAmount, errors)
  } else {
    const key = f.wantCollection.trim()
    const id = f.wantItemId.trim()
    if (!COLLECTION_KEY.test(key)) errors.wantCollection = 'Choose a collection.'
    if (!id) errors.wantItemId = 'Enter the item’s id.'
    else if (id.length > LIMITS.maxItemIdLength || !/^[A-Za-z0-9._:/*-]+$/.test(id)) {
      errors.wantItemId = `Use up to ${LIMITS.maxItemIdLength} characters: letters, digits and . _ : / - *`
    }
    if (!errors.wantCollection && !errors.wantItemId) want = { kind: 'item', key, id, amount: 0n }
  }

  let expiry = 0
  if (f.expiryDays !== '') {
    const days = Number(f.expiryDays)
    const blocks = days * LIMITS.blocksPerDay
    if (!Number.isInteger(days) || days <= 0 || blocks > LIMITS.maxExpiryBlocks) {
      errors.expiryDays = 'Choose between 1 and 30 days.'
    } else if (ctx.height <= 0) {
      errors.expiryDays = 'The chain height is not known yet. Try again in a moment.'
    } else {
      expiry = ctx.height + blocks
    }
  }

  if (give && want && Object.keys(errors).length === 0) {
    try {
      checkOfferSides(give, want)
    } catch (e) {
      errors.form = e instanceof Error ? e.message : String(e)
    }
  }
  if (!give || !want || Object.keys(errors).length > 0) return { ok: false, errors }
  return { ok: true, give, want, expiry }
}
