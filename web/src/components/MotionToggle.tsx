import { setMotion, useMotion } from '../story/hooks.ts'

// Switches the scroll animation on or off. The default follows the system's
// reduced-motion setting.
export function MotionToggle({ className }: { className: string }) {
  const motion = useMotion()
  return (
    <button
      type="button"
      className={className}
      aria-pressed={motion === 'full'}
      onClick={() => setMotion(motion === 'full' ? 'reduced' : 'full')}
    >
      Animation {motion === 'full' ? 'on' : 'off'}
    </button>
  )
}
