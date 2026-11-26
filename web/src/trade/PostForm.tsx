import { useState, type FormEvent, type ReactNode } from 'react'
import { PATHS } from '../lib/config.ts'
import type { Collection } from '../lib/kylix.ts'
import type { AccountData } from '../app/account.ts'
import { itemValue } from '../app/account.ts'
import { KNOWN_TOKENS, assetPlain, formatUnits, knownToken } from '../app/assets.ts'
import { links, preparePost } from '../app/actions.ts'
import type { TxRunner } from '../app/hooks.ts'
import { chain } from '../app/market.ts'
import { EXPIRY_CHOICES, MNS_ITEM, OTHER_TOKEN, emptyForm, validateOffer } from '../app/offerForm.ts'
import type { FormErrors, FormField, OfferForm } from '../app/offerForm.ts'

interface Props {
  address: string | undefined
  account: AccountData | undefined
  collections: Collection[]
  height: number
  tx: TxRunner
}

const FIELD_ORDER: FormField[] = [
  'giveToken',
  'giveTokenOther',
  'giveAmount',
  'giveItem',
  'giveMnsName',
  'wantToken',
  'wantTokenOther',
  'wantAmount',
  'wantCollection',
  'wantItemId',
  'expiryDays',
]

function Field({ id, label, error, hint, children }: { id: string; label: string; error?: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <div className={`field ${error ? 'has-error' : ''}`}>
      <label htmlFor={id}>{label}</label>
      {children}
      {hint && (
        <p className="field-hint" id={`${id}-hint`}>
          {hint}
        </p>
      )}
      {error && (
        <p className="field-error" id={`${id}-error`}>
          {error}
        </p>
      )}
    </div>
  )
}

function describedBy(id: string, error?: string, hint?: boolean): string | undefined {
  const ids = [hint ? `${id}-hint` : '', error ? `${id}-error` : ''].filter(Boolean).join(' ')
  return ids || undefined
}

function TokenSelect({ id, value, onChange, error }: { id: string; value: string; onChange: (v: string) => void; error?: string }) {
  return (
    <select id={id} value={value} onChange={(e) => onChange(e.target.value)} aria-invalid={!!error}>
      {KNOWN_TOKENS.map((t) => (
        <option key={t.key} value={t.key}>
          {t.symbol} ({t.note})
        </option>
      ))}
      <option value={OTHER_TOKEN}>Another token (enter its key)</option>
    </select>
  )
}

export function PostForm({ address, account, collections, height, tx }: Props) {
  const [form, setForm] = useState<OfferForm>(emptyForm)
  const [errors, setErrors] = useState<FormErrors>({})
  const set = <K extends keyof OfferForm>(k: K, v: OfferForm[K]) => {
    setForm((f) => ({ ...f, [k]: v }))
    setErrors((e) => (e[k] || e.form ? { ...e, [k]: undefined, form: undefined } : e))
  }

  const items = account?.items ?? []
  const ctx = {
    height,
    ...(account ? { balances: account.tokens, items: items.map(itemValue) } : {}),
  }
  const check = validateOffer(form, ctx)
  const canSign = !!address && !tx.busy

  function submit(e: FormEvent) {
    e.preventDefault()
    const r = validateOffer(form, ctx)
    if (!r.ok) {
      setErrors(r.errors)
      const first = FIELD_ORDER.find((f) => r.errors[f])
      if (first) document.getElementById(`post-${first}`)?.focus()
      return
    }
    if (!address) return
    setErrors({})
    tx.run(
      { label: 'Post an offer', link: { href: links.realm(), text: 'The realm’s page on the testnet' } },
      () => preparePost(chain(), { caller: address, give: r.give, want: r.want, expiry: r.expiry }),
      () => setForm((f) => ({ ...f, giveAmount: '', giveItem: '', wantAmount: '', wantItemId: '' })),
    )
  }

  const giveTokenKey = form.giveToken === OTHER_TOKEN ? form.giveTokenOther.trim() : form.giveToken
  const giveKnown = knownToken(giveTokenKey)
  const giveBal = account?.tokens.get(giveTokenKey)
  const wantKnown = knownToken(form.wantToken === OTHER_TOKEN ? form.wantTokenOther.trim() : form.wantToken)
  const itemCollections = collections.length > 0 ? collections : [{ key: PATHS.kylixdemo, name: 'Kylix Relics', label: 'official collection' } as Collection]

  return (
    <section className="panel" aria-labelledby="post-title">
      <h2 id="post-title" className="panel-title">Post an offer</h2>
      <p className="panel-note">
        Say what you give and the least you will take for it. Your wallet signs one transaction with two steps: it approves
        exactly what you give to the offer’s own address, then posts the offer. Your assets stay in your wallet until a ring
        settles.
      </p>
      <form onSubmit={submit} noValidate>
        <fieldset>
          <legend>You give</legend>
          <div className="choice" role="radiogroup" aria-label="What you give">
            <label>
              <input type="radio" name="giveKind" checked={form.giveKind === 'fungible'} onChange={() => set('giveKind', 'fungible')} /> A token
            </label>
            <label>
              <input type="radio" name="giveKind" checked={form.giveKind === 'item'} onChange={() => set('giveKind', 'item')} /> An item
            </label>
          </div>
          {form.giveKind === 'fungible' ? (
            <>
              <Field id="post-giveToken" label="Token" error={errors.giveToken}>
                <TokenSelect id="post-giveToken" value={form.giveToken} onChange={(v) => set('giveToken', v)} error={errors.giveToken} />
              </Field>
              {form.giveToken === OTHER_TOKEN && (
                <Field id="post-giveTokenOther" label="Token key" error={errors.giveTokenOther} hint="Its realm path, a dot and its symbol. Amounts are in its base units.">
                  <input
                    id="post-giveTokenOther"
                    className="mono"
                    value={form.giveTokenOther}
                    onChange={(e) => set('giveTokenOther', e.target.value)}
                    spellCheck={false}
                    autoComplete="off"
                    aria-invalid={!!errors.giveTokenOther}
                    aria-describedby={describedBy('post-giveTokenOther', errors.giveTokenOther, true)}
                  />
                </Field>
              )}
              <Field
                id="post-giveAmount"
                label="Amount"
                error={errors.giveAmount}
                hint={giveBal != null ? `You hold ${formatUnits(giveBal, giveKnown?.decimals ?? 0)}.` : undefined}
              >
                <input
                  id="post-giveAmount"
                  inputMode="decimal"
                  value={form.giveAmount}
                  onChange={(e) => set('giveAmount', e.target.value)}
                  autoComplete="off"
                  aria-invalid={!!errors.giveAmount}
                  aria-describedby={describedBy('post-giveAmount', errors.giveAmount, giveBal != null)}
                />
              </Field>
            </>
          ) : (
            <Field
              id="post-giveItem"
              label="Item"
              error={errors.giveItem}
              hint={items.length === 0 ? (address ? 'You hold no demo relics. Claim demo assets to get one, or offer an MNS name.' : 'Connect a wallet to see your relics.') : undefined}
            >
              <select
                id="post-giveItem"
                value={form.giveItem}
                onChange={(e) => set('giveItem', e.target.value)}
                aria-invalid={!!errors.giveItem}
                aria-describedby={describedBy('post-giveItem', errors.giveItem, items.length === 0)}
              >
                <option value="">Choose an item</option>
                {items.map((i) => (
                  <option key={itemValue(i)} value={itemValue(i)}>
                    {i.id} ({i.key === PATHS.kylixdemo ? 'Kylix Relics' : i.key})
                  </option>
                ))}
                <option value={MNS_ITEM}>An MNS name (type it)</option>
              </select>
            </Field>
          )}
          {form.giveKind === 'item' && form.giveItem === MNS_ITEM && (
            <Field
              id="post-giveMnsName"
              label="MNS name"
              error={errors.giveMnsName}
              hint="As label*domain. Before your wallet opens, the app checks that you hold the name and that its lease lasts past the longest offer."
            >
              <input
                id="post-giveMnsName"
                className="mono"
                value={form.giveMnsName}
                onChange={(e) => set('giveMnsName', e.target.value)}
                spellCheck={false}
                autoComplete="off"
                aria-invalid={!!errors.giveMnsName}
                aria-describedby={describedBy('post-giveMnsName', errors.giveMnsName, true)}
              />
            </Field>
          )}
        </fieldset>

        <fieldset>
          <legend>You want at least</legend>
          <div className="choice" role="radiogroup" aria-label="What you want">
            <label>
              <input type="radio" name="wantKind" checked={form.wantKind === 'fungible'} onChange={() => set('wantKind', 'fungible')} /> A token
            </label>
            <label>
              <input type="radio" name="wantKind" checked={form.wantKind === 'item'} onChange={() => set('wantKind', 'item')} /> An item
            </label>
          </div>
          {form.wantKind === 'fungible' ? (
            <>
              <Field id="post-wantToken" label="Token" error={errors.wantToken}>
                <TokenSelect id="post-wantToken" value={form.wantToken} onChange={(v) => set('wantToken', v)} error={errors.wantToken} />
              </Field>
              {form.wantToken === OTHER_TOKEN && (
                <Field id="post-wantTokenOther" label="Token key" error={errors.wantTokenOther} hint="Its realm path, a dot and its symbol. Amounts are in its base units.">
                  <input
                    id="post-wantTokenOther"
                    className="mono"
                    value={form.wantTokenOther}
                    onChange={(e) => set('wantTokenOther', e.target.value)}
                    spellCheck={false}
                    autoComplete="off"
                    aria-invalid={!!errors.wantTokenOther}
                    aria-describedby={describedBy('post-wantTokenOther', errors.wantTokenOther, true)}
                  />
                </Field>
              )}
              <Field
                id="post-wantAmount"
                label="Least amount"
                error={errors.wantAmount}
                hint={wantKnown && wantKnown.decimals > 0 ? `Up to ${wantKnown.decimals} decimals.` : undefined}
              >
                <input
                  id="post-wantAmount"
                  inputMode="decimal"
                  value={form.wantAmount}
                  onChange={(e) => set('wantAmount', e.target.value)}
                  autoComplete="off"
                  aria-invalid={!!errors.wantAmount}
                  aria-describedby={describedBy('post-wantAmount', errors.wantAmount, !!wantKnown && wantKnown.decimals > 0)}
                />
              </Field>
            </>
          ) : (
            <>
              <Field id="post-wantCollection" label="Collection" error={errors.wantCollection}>
                <select
                  id="post-wantCollection"
                  value={form.wantCollection}
                  onChange={(e) => set('wantCollection', e.target.value)}
                  aria-invalid={!!errors.wantCollection}
                  aria-describedby={describedBy('post-wantCollection', errors.wantCollection)}
                >
                  {itemCollections.map((c) => (
                    <option key={c.key} value={c.key}>
                      {c.name} ({c.label}) {c.key}
                    </option>
                  ))}
                </select>
              </Field>
              <Field
                id="post-wantItemId"
                label="Item id"
                error={errors.wantItemId}
                hint={form.wantCollection === PATHS.kylixdemo ? 'Demo relics are named relic-1, relic-2 and so on.' : undefined}
              >
                <input
                  id="post-wantItemId"
                  className="mono"
                  value={form.wantItemId}
                  onChange={(e) => set('wantItemId', e.target.value)}
                  spellCheck={false}
                  autoComplete="off"
                  aria-invalid={!!errors.wantItemId}
                  aria-describedby={describedBy('post-wantItemId', errors.wantItemId, form.wantCollection === PATHS.kylixdemo)}
                />
              </Field>
            </>
          )}
        </fieldset>

        <Field id="post-expiryDays" label="Expires after" error={errors.expiryDays}>
          <select
            id="post-expiryDays"
            value={form.expiryDays}
            onChange={(e) => set('expiryDays', e.target.value)}
            aria-invalid={!!errors.expiryDays}
            aria-describedby={describedBy('post-expiryDays', errors.expiryDays)}
          >
            {EXPIRY_CHOICES.map((c) => (
              <option key={c.value} value={c.value}>
                {c.label}
              </option>
            ))}
          </select>
        </Field>

        {check.ok && (
          <p className="post-summary">
            You give {assetPlain(check.give, collections)} and want at least {assetPlain(check.want, collections)}.
          </p>
        )}
        {errors.form && (
          <p className="form-error" role="alert">
            {errors.form}
          </p>
        )}
        <button type="submit" className="btn" disabled={!canSign}>
          {address ? 'Approve and post' : 'Connect a wallet to post'}
        </button>
      </form>
    </section>
  )
}
