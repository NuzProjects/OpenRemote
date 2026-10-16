import { useEffect, useRef, useState } from 'react'
import { DRAG_DISTANCE } from './move-chat.js'

// Near the list's top or bottom edge, within this many pixels, the list
// scrolls under a dragged chat so every project can be reached.
const EDGE = 28

/**
 * Dragging a sidebar chat onto a drop target - an element carrying
 * `data-drop` (a project's id, or empty for Chats). A press becomes a drag
 * only past DRAG_DISTANCE and only with a mouse or pen (a finger scrolls
 * the list); Esc, or the window losing focus, cancels; and the click that
 * ends a drag never opens the chat. `accepts(item, target)` says where a
 * drop would really change something: only there is a target lit, and only
 * there does a release call `onDrop(item, target)`.
 */
export function useChatDrag({ scroller, accepts, onDrop }) {
  // { item, over, x, y }: what is dragged and where it would land. The
  // label follows the pointer through `label` without a render per move;
  // the sidebar renders again only when the target under it changes.
  const [drag, setDrag] = useState(null)
  const label = useRef(null)
  const live = useRef({ accepts, onDrop })
  live.current = { accepts, onDrop }
  const cleanup = useRef(null)
  useEffect(() => () => cleanup.current?.(), [])

  const start = (item) => (e) => {
    if (e.button !== 0 || e.pointerType === 'touch') return
    const row = e.currentTarget
    const pointer = e.pointerId
    const from = { x: e.clientX, y: e.clientY }
    let at = from
    let dragging = false
    let shown = false
    let over = null
    let frame = 0

    const targetAt = ({ x, y }) => {
      const el = document.elementFromPoint(x, y)?.closest?.('[data-drop]')
      if (!el) return null
      const target = el.getAttribute('data-drop')
      return live.current.accepts(item, target) ? target : null
    }
    const show = () => {
      const next = targetAt(at)
      if (label.current) {
        label.current.style.left = `${at.x + 14}px`
        label.current.style.top = `${at.y + 10}px`
      }
      if (shown && next === over) return
      shown = true
      over = next
      setDrag({ item, over, x: at.x + 14, y: at.y + 10 })
    }
    const scroll = () => {
      frame = 0
      const list = scroller.current
      const box = list?.getBoundingClientRect()
      if (!box || !dragging) return
      const speed =
        at.y < box.top + EDGE
          ? -Math.ceil((box.top + EDGE - at.y) / 3)
          : at.y > box.bottom - EDGE
            ? Math.ceil((at.y - box.bottom + EDGE) / 3)
            : 0
      if (!speed) return
      list.scrollTop += speed
      show()
      frame = requestAnimationFrame(scroll)
    }
    const move = (ev) => {
      if (ev.pointerId !== pointer) return
      at = { x: ev.clientX, y: ev.clientY }
      if (!dragging) {
        if (Math.hypot(at.x - from.x, at.y - from.y) < DRAG_DISTANCE) return
        dragging = true
        // From here every move is the drag's, even past the window's edge.
        row.setPointerCapture?.(pointer)
        window.getSelection?.()?.removeAllRanges()
        document.documentElement.classList.add('sb-dragging')
      }
      show()
      if (!frame) frame = requestAnimationFrame(scroll)
    }
    const finish = (drop) => {
      cleanup.current?.()
      if (!dragging) return
      // The release also arrives as a click on the row: it ends the drag,
      // it doesn't open the chat.
      const swallow = (ce) => {
        ce.preventDefault()
        ce.stopPropagation()
      }
      window.addEventListener('click', swallow, { capture: true, once: true })
      setTimeout(() => window.removeEventListener('click', swallow, { capture: true }), 0)
      if (drop && over !== null) live.current.onDrop(item, over)
    }
    const up = (ev) => {
      if (ev.pointerId === pointer) finish(true)
    }
    const cancel = () => finish(false)
    const key = (ev) => {
      if (ev.key !== 'Escape' || !dragging) return
      ev.preventDefault()
      ev.stopPropagation()
      finish(false)
    }

    cleanup.current?.()
    cleanup.current = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      window.removeEventListener('pointercancel', cancel)
      window.removeEventListener('blur', cancel)
      window.removeEventListener('keydown', key, true)
      cancelAnimationFrame(frame)
      if (row.hasPointerCapture?.(pointer)) row.releasePointerCapture(pointer)
      document.documentElement.classList.remove('sb-dragging')
      setDrag(null)
      cleanup.current = null
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    window.addEventListener('pointercancel', cancel)
    window.addEventListener('blur', cancel)
    window.addEventListener('keydown', key, true)
  }

  return { drag, label, start }
}
