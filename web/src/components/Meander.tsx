import { useId } from 'react'

// A straight band of the running key, for section edges.
export function MeanderBand({ className = '' }: { className?: string }) {
  const id = `key-band-${useId().replace(/:/g, '')}`
  return (
    <svg className={`meander-band ${className}`} aria-hidden="true">
      <defs>
        <pattern id={id} width="40" height="32" patternUnits="userSpaceOnUse">
          <path d="M0 28 H40 M0 28 V4 H32 V20 H16 V12 H24" fill="none" stroke="currentColor" strokeWidth="3.5" strokeLinecap="square" />
        </pattern>
      </defs>
      <rect width="100%" height="32" fill={`url(#${id})`} />
    </svg>
  )
}
