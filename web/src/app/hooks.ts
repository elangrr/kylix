import { useCallback, useEffect, useReducer, useRef, useState } from 'react'
import { CHAIN_ID } from '../lib/config.ts'
import { indexedTx } from '../lib/rpc.ts'
import type { TxPlan } from '../lib/tx.ts'
import type { Wallet } from '../lib/wallet.ts'
import { errorText, idleTx, isBusy, txReducer } from './txState.ts'
import type { TxMeta, TxState } from './txState.ts'
import { walletInstalled } from './walletSession.ts'

// --- Reading on a timer -------------------------------------------------------------

export interface Loaded<T> {
  data: T | undefined
  error: string | undefined
  loading: boolean
  /** When the data was last read, in ms since the epoch. */
  at: number
  refresh: () => void
}

/**
 * Runs `load` now, then every `everyMs` while the tab is visible, and again
 * when the tab comes back after the data went stale. `key` restarts it (and
 * clears the data) when it changes; a null key loads nothing.
 */
export function usePolling<T>(key: string | null, load: () => Promise<T>, everyMs: number): Loaded<T> {
  const [state, setState] = useState<{ key: string | null; data?: T; error?: string; loading: boolean; at: number }>({
    key,
    loading: key !== null,
    at: 0,
  })
  const loadRef = useRef(load)
  const seq = useRef(0)
  const lastAt = useRef(0)
  useEffect(() => {
    loadRef.current = load
  })

  // A new key drops the old key's data before the first read of the new one.
  if (state.key !== key) setState({ key, loading: key !== null, at: 0 })

  const run = useCallback(() => {
    if (key === null) return
    const mine = ++seq.current
    loadRef.current().then(
      (data) => {
        if (mine !== seq.current) return
        lastAt.current = Date.now()
        setState({ key, data, loading: false, at: lastAt.current })
      },
      (e: unknown) => {
        if (mine !== seq.current) return
        setState((s) => ({ ...s, error: errorText(e), loading: false }))
      },
    )
  }, [key])

  useEffect(() => {
    if (key === null) return
    lastAt.current = 0
    run()
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') run()
    }, everyMs)
    const onVisible = () => {
      if (document.visibilityState === 'visible' && Date.now() - lastAt.current > everyMs) run()
    }
    document.addEventListener('visibilitychange', onVisible)
    const seqRef = seq
    return () => {
      window.clearInterval(timer)
      document.removeEventListener('visibilitychange', onVisible)
      // Answers to reads started before this point are dropped.
      seqRef.current++
    }
  }, [key, run, everyMs])

  const current = state.key === key
  return {
    data: current ? state.data : undefined,
    error: current ? state.error : undefined,
    loading: current ? state.loading : key !== null,
    at: current ? state.at : 0,
    refresh: run,
  }
}

// --- The wallet ----------------------------------------------------------------------

export type WalletStatus =
  | 'checking'
  | 'not-installed'
  | 'disconnected'
  | 'connecting'
  | 'wrong-network'
  | 'switching'
  | 'connected'

export interface WalletView {
  status: WalletStatus
  address?: string
  chainId?: string
  /** Why the last wallet request failed, in plain words. */
  error?: string
}

export interface WalletControls {
  view: WalletView
  /** The address to sign with, when connected to onyx-1. */
  address: string | undefined
  connect: () => void
  switchNetwork: () => void
  disconnect: () => void
}

const SITE_NAME = 'Kylix'

export function useWallet(wallet: Wallet): WalletControls {
  const [view, setView] = useState<WalletView>({ status: 'checking' })
  // After "Disconnect", the page stops reading the account until the user connects again.
  const forgotten = useRef(false)

  const readAccount = useCallback(async (): Promise<void> => {
    if (forgotten.current) return
    try {
      const acc = await wallet.account()
      if (!acc) {
        setView({ status: 'disconnected' })
        return
      }
      setView(
        acc.chainId === CHAIN_ID
          ? { status: 'connected', address: acc.address, chainId: acc.chainId }
          : { status: 'wrong-network', address: acc.address, chainId: acc.chainId },
      )
    } catch (e) {
      setView({ status: 'disconnected', error: errorText(e) })
    }
  }, [wallet])

  useEffect(() => {
    let live = true
    void (async () => {
      const installed = await walletInstalled(wallet)
      if (!live) return
      if (!installed) {
        setView({ status: 'not-installed' })
        return
      }
      // Restores a site Adena already trusts; does not open a window.
      await readAccount()
    })()
    const offAccount = wallet.onAccountChange(() => void readAccount())
    const offNetwork = wallet.onNetworkChange(() => void readAccount())
    return () => {
      live = false
      offAccount()
      offNetwork()
    }
  }, [wallet, readAccount])

  const connect = useCallback(() => {
    forgotten.current = false
    setView((v) => ({ ...v, status: 'connecting', error: undefined }))
    wallet.connect(SITE_NAME).then(
      (acc) =>
        setView(
          acc.chainId === CHAIN_ID
            ? { status: 'connected', address: acc.address, chainId: acc.chainId }
            : { status: 'wrong-network', address: acc.address, chainId: acc.chainId },
        ),
      (e: unknown) =>
        setView({ status: wallet.isInstalled() ? 'disconnected' : 'not-installed', error: connectError(e) }),
    )
  }, [wallet])

  const switchNetwork = useCallback(() => {
    setView((v) => ({ ...v, status: 'switching', error: undefined }))
    wallet.ensureNetwork().then(
      () => void readAccount(),
      (e: unknown) => setView((v) => ({ ...v, status: 'wrong-network', error: errorText(e) })),
    )
  }, [wallet, readAccount])

  const disconnect = useCallback(() => {
    forgotten.current = true
    setView({ status: 'disconnected' })
  }, [])

  return { view, address: view.status === 'connected' ? view.address : undefined, connect, switchNetwork, disconnect }
}

function connectError(e: unknown): string {
  const t = errorText(e)
  return t.startsWith('You declined') ? 'You declined the connection in the wallet.' : t
}

// --- Transactions --------------------------------------------------------------------

export interface TxRunner {
  state: TxState
  busy: boolean
  /** Builds the transaction with `build`, has the wallet sign and send it, and follows it to a block. */
  run: (meta: TxMeta, build: () => Promise<TxPlan> | TxPlan, after?: () => void) => void
  dismiss: () => void
}

/**
 * One transaction at a time. `onLanded` runs after a transaction is in a
 * block, to read the affected data again.
 */
export function useTxRunner(wallet: Wallet, onLanded: () => void): TxRunner {
  const [state, dispatch] = useReducer(txReducer, idleTx)
  const busyRef = useRef(false)
  const landedRef = useRef(onLanded)
  useEffect(() => {
    landedRef.current = onLanded
  })

  const run = useCallback(
    (meta: TxMeta, build: () => Promise<TxPlan> | TxPlan, after?: () => void) => {
      if (busyRef.current) return
      busyRef.current = true
      dispatch({ type: 'start', meta })
      void (async () => {
        let hash: string | undefined
        try {
          const plan = await build()
          dispatch({ type: 'built' })
          const res = await wallet.signAndSend(plan)
          hash = res.hash
          if (res.committed) {
            dispatch({ type: 'landed', hash: res.hash, ...(res.height !== undefined ? { height: res.height } : {}) })
          } else {
            dispatch({ type: 'sent', hash: res.hash })
            const found = await waitIndexed(res.hash)
            if (!found) throw new Error('The transaction was sent, but no block has it after two minutes. Check the realm page.')
            if (!found.success) throw new Error(`The chain refused it: ${found.error.split('\n')[0] ?? 'failed'}`)
            dispatch({ type: 'landed', hash: res.hash, height: found.height })
          }
          after?.()
          landedRef.current()
        } catch (e) {
          dispatch({ type: 'failed', message: errorText(e), ...(hash ? { hash } : {}) })
        } finally {
          busyRef.current = false
        }
      })()
    },
    [wallet],
  )

  const dismiss = useCallback(() => dispatch({ type: 'dismiss' }), [])
  return { state, busy: isBusy(state), run, dismiss }
}

async function waitIndexed(hash: string) {
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 3_000))
    try {
      const t = await indexedTx(hash)
      if (t) return t
    } catch {
      // The indexer can lag or refuse for a moment; keep asking.
    }
  }
  return null
}
