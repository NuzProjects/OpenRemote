// "Screenshot a region": over the page's picture (the page itself steps
// aside while this is open, browser-occlusion.js), the user drags a
// rectangle; letting go sends that part of the page to the chat. Esc
// cancels. The rectangle is reported in this box's own pixels.

import { useEffect, useRef, useState } from 'react'

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v))
}

export default function BrowserRegion({ box, onPick, onCancel }) {
  const ref = useRef(null)
  const start = useRef(null)
  const [rect, setRect] = useState(null)

  useEffect(() => {
    const onKey = (e) => {
      if (e.key !== 'Escape') return
      e.preventDefault()
      e.stopPropagation()
      onCancel()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [onCancel])

  const at = (e) => {
    const r = ref.current.getBoundingClientRect()
    return { x: clamp(e.clientX - r.left, 0, r.width), y: clamp(e.clientY - r.top, 0, r.height) }
  }

  const span = (a, b) => ({
    x: Math.min(a.x, b.x),
    y: Math.min(a.y, b.y),
    width: Math.abs(a.x - b.x),
    height: Math.abs(a.y - b.y),
  })

  return (
    <div
      ref={ref}
      className="bw-region"
      role="dialog"
      aria-label="Select a part of the page"
      style={{ left: box.left, top: box.top, width: box.width, height: box.height }}
      onPointerDown={(e) => {
        if (e.button !== 0) return
        e.currentTarget.setPointerCapture(e.pointerId)
        start.current = at(e)
        setRect(null)
      }}
      onPointerMove={(e) => {
        if (start.current) setRect(span(start.current, at(e)))
      }}
      onPointerUp={(e) => {
        if (!start.current) return
        const picked = span(start.current, at(e))
        start.current = null
        // A click, not a drag: keep waiting for one.
        if (picked.width < 4 || picked.height < 4) {
          setRect(null)
          return
        }
        onPick(picked)
      }}
    >
      {rect ? (
        <div className="bw-region-rect" style={{ left: rect.x, top: rect.y, width: rect.width, height: rect.height }} />
      ) : (
        <div className="bw-region-shade" />
      )}
      <div className="bw-region-hint">Drag over the part of the page to send to the chat. Esc cancels.</div>
    </div>
  )
}
