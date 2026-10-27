// The browser half of an armed destructive row: the arm ends the moment the
// row stops being the thing the user is looking at. Scrolling it out of view
// disarms it (an IntersectionObserver on the armed button itself), and so does
// losing focus (a tab, or a click somewhere else). The rule is armAfter in
// row-confirm.js; this only supplies the two events, in one place so the three
// panes cannot drift apart.

import { useEffect, useRef } from 'react'
import { armAfter } from './row-confirm.js'

export function useArmedRow(armed, setArmed) {
  const watching = useRef(null)

  // A callback ref on the armed button, so the observer follows the row that
  // is actually armed rather than the list.
  const buttonRef = (el) => {
    watching.current?.disconnect?.()
    watching.current = null
    if (!el || typeof IntersectionObserver === 'undefined') return
    const observer = new IntersectionObserver((entries) => {
      if (!entries.some((entry) => !entry.isIntersecting)) return
      setArmed((current) => armAfter(current, armed, { visible: false }))
    })
    observer.observe(el)
    watching.current = observer
  }

  useEffect(
    () => () => {
      watching.current?.disconnect?.()
      watching.current = null
    },
    [],
  )

  const onBlur = () => setArmed((current) => armAfter(current, armed, { focused: false }))

  return { buttonRef, onBlur }
}
