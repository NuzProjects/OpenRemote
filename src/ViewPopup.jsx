import { useEffect } from 'react'
import { X } from '@phosphor-icons/react'
import { useBack } from './use-back.js'
import './view-popup.css'

// One of the app's views (Settings, Metrics, Mobile) in a window of its
// own over the app, so opening it never loses the chat underneath. The
// view keeps its own title; this adds the frame and a way out: the close
// button, Esc, a click outside, or the phone's back gesture.
export default function ViewPopup({ label, onClose, children }) {
  useBack(true, onClose)
  useEffect(() => {
    const onKey = (e) => {
      // A view's own use of Esc (a shortcut being recorded, a menu
      // closing) comes first.
      if (e.key === 'Escape' && !e.defaultPrevented) onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])
  return (
    <div
      className="vp-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div className="vp-window" role="dialog" aria-modal="true" aria-label={label}>
        <button type="button" className="vp-close" onClick={onClose} title="Close" aria-label="Close">
          <X size={14} weight="bold" />
        </button>
        <div className="vp-body">{children}</div>
      </div>
    </div>
  )
}
