import { useEffect, useRef, useState, useSyncExternalStore, type RefObject } from 'react'

// How much the page moves. "full" animates the scenes as you scroll. "reduced"
// keeps the story pinned and cross-fades between scenes. The animation is on
// unless the visitor turns it off with the switch in the header or footer.
export type Motion = 'full' | 'reduced'

const storageKey = 'kylix-motion'
const motionListeners = new Set<() => void>()

function storedMotion(): Motion | null {
  try {
    const value = window.localStorage.getItem(storageKey)
    return value === 'full' || value === 'reduced' ? value : null
  } catch {
    return null
  }
}

function currentMotion(): Motion {
  return storedMotion() ?? 'full'
}

function subscribeMotion(onChange: () => void): () => void {
  motionListeners.add(onChange)
  return () => {
    motionListeners.delete(onChange)
  }
}

export function setMotion(motion: Motion): void {
  try {
    window.localStorage.setItem(storageKey, motion)
  } catch {
    // Storage can be blocked. The choice then lasts until the page reloads.
  }
  document.documentElement.dataset.motion = motion
  motionListeners.forEach((listener) => listener())
}

export function useMotion(): Motion {
  const motion = useSyncExternalStore(subscribeMotion, currentMotion)
  useEffect(() => {
    document.documentElement.dataset.motion = motion
  }, [motion])
  return motion
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
