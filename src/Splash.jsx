import { useEffect, useState } from 'react'
import './splash.css'

// The locked mark: five static arcs, three dots. The dots are the only
// thing that moves — they grow into place, clockwise, then the splash
// leaves. Plays once per launch.
const ARCS = [
  ['#FF5A2C', 'M117.8 26.11A76 76 0 0 1 139.66 35.17'],
  ['#FFC324', 'M164.83 60.34A76 76 0 0 1 173.89 82.2'],
  ['#4AD295', 'M173.89 117.8A76 76 0 0 1 117.8 173.89'],
  ['#42C6FF', 'M82.2 173.89A76 76 0 0 1 60.34 164.83'],
  ['#5983FC', 'M35.17 139.66A76 76 0 0 1 26.11 117.8'],
]

const DOTS = [
  ['#C65CE0', 26.85, 79.37],
  ['#5983FC', 46.26, 46.26],
  ['#42C6FF', 79.37, 26.85],
]

// The whole splash is 239ms: held fully opaque, then a quick fade. The
// dots pop in inside the hold so the mark reads before it leaves.
const TOTAL_MS = 239
const LEAVE_MS = 80
const HOLD_MS = TOTAL_MS - LEAVE_MS

export function SplashMark({ className = 'splash-mark', animate = false }) {
  return (
    <svg viewBox="0 0 200 200" className={className} aria-hidden="true">
      {ARCS.map(([color, d]) => (
        <path key={color} d={d} stroke={color} strokeWidth="24" strokeLinecap="round" fill="none" />
      ))}
      {DOTS.map(([fill, cx, cy], i) => (
        <circle
          key={fill}
          className={animate ? 'splash-dot' : undefined}
          style={animate ? { animationDelay: `${20 + i * 30}ms` } : undefined}
          cx={cx}
          cy={cy}
          r="12"
          fill={fill}
        />
      ))}
    </svg>
  )
}

export default function Splash() {
  const [leaving, setLeaving] = useState(false)
  const [gone, setGone] = useState(false)

  useEffect(() => {
    const start = setTimeout(() => setLeaving(true), HOLD_MS)
    const end = setTimeout(() => setGone(true), TOTAL_MS)
    return () => {
      clearTimeout(start)
      clearTimeout(end)
    }
  }, [])

  if (gone) return null

  return (
    <div className={`splash${leaving ? ' splash-leaving' : ''}`} aria-hidden="true">
      <SplashMark animate />
    </div>
  )
}
