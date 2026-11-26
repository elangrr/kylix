import { useEffect, useRef, useState, useSyncExternalStore, type RefObject } from 'react'

const reducedQuery = '(prefers-reduced-motion: reduce)'

function subscribeReduced(onChange: () => void): () => void {
  const mq = window.matchMedia(reducedQuery)
  mq.addEventListener('change', onChange)
  return () => mq.removeEventListener('change', onChange)
}

export function usePrefersReducedMotion(): boolean {
  return useSyncExternalStore(subscribeReduced, () => window.matchMedia(reducedQuery).matches)
}

// Which step is active: the last one whose text has passed a line across the
// viewport. Pass the element that holds a step's text, not its tall wrapper, so
// a scene changes when its text comes into view. On a phone the picture is
// pinned at the top, so the line sits lower.
// The page scrolls natively; this only reads positions, once per frame.
export function useActiveStep(count: number): {
  active: number
  refs: RefObject<(HTMLElement | null)[]>
} {
  const refs = useRef<(HTMLElement | null)[]>([])
  const [active, setActive] = useState(0)

  useEffect(() => {
    let frame = 0
    const measure = () => {
      frame = 0
      const narrow = window.matchMedia('(max-width: 899px)').matches
      const line = window.innerHeight * (narrow ? 0.8 : 0.62)
      let next = 0
      for (let i = 0; i < count; i++) {
        const el = refs.current[i]
        if (el && el.getBoundingClientRect().top <= line) next = i
      }
      setActive(next)
    }
    const schedule = () => {
      if (!frame) frame = window.requestAnimationFrame(measure)
    }
    measure()
    window.addEventListener('scroll', schedule, { passive: true })
    window.addEventListener('resize', schedule)
    return () => {
      window.removeEventListener('scroll', schedule)
      window.removeEventListener('resize', schedule)
      if (frame) window.cancelAnimationFrame(frame)
    }
  }, [count])

  return { active, refs }
}
