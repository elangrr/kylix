import { useEffect, useSyncExternalStore } from 'react'

// A small router for a static site served under a base path. Paths inside the
// app are written without the base: "/" and "/app".
const base = import.meta.env.BASE_URL.replace(/\/$/, '')

function currentPath(): string {
  const path = window.location.pathname
  const inside = path.startsWith(base) ? path.slice(base.length) : path
  const trimmed = inside.replace(/\/+$/, '')
  return trimmed === '' ? '/' : trimmed
}

function subscribe(onChange: () => void): () => void {
  window.addEventListener('popstate', onChange)
  return () => window.removeEventListener('popstate', onChange)
}

export function usePath(): string {
  return useSyncExternalStore(subscribe, currentPath)
}

export function href(to: string): string {
  return to === '/' ? `${base}/` : `${base}${to}`
}

export function navigate(to: string): void {
  window.history.pushState(null, '', href(to))
  window.dispatchEvent(new PopStateEvent('popstate'))
}

// After a route change, start at the top and move focus to the page's heading
// so keyboard and screen-reader users land on the new content.
let firstEntry = true

export function usePageEntry(path: string): void {
  useEffect(() => {
    if (firstEntry) {
      firstEntry = false
      return
    }
    window.scrollTo(0, 0)
    const heading = document.querySelector<HTMLElement>('main h1')
    heading?.focus({ preventScroll: true })
  }, [path])
}
