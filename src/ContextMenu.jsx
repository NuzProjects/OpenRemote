import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { captureOpener, focusOpener } from './dialog-focus.js'
import './pickermenu.css'
import './contextmenu.css'

/**
 * The right-click menu: actions at the cursor. It wears the picker menu's
 * look (nc-* classes) but has no search and no selection - each entry just
 * does its thing and the menu closes.
 *
 * items: [{ label, icon, onSelect, disabled, hint, danger }], a { header: 'Text' }
 * for a group label, or { divider: true }.
 */
export default function ContextMenu({ x, y, items, onClose }) {
  const ref = useRef(null)
  const actions = items.map((item, i) => ({ item, i })).filter(({ item }) => item.onSelect && !item.disabled)
  const [cursor, setCursor] = useState(actions[0]?.i ?? -1)

  useEffect(() => {
    // The menu takes the keyboard while it is open and hands it back when it
    // goes - Escape, a chosen row, a click elsewhere, or the opener
    // unmounting. Captured before the focus below, which is the last moment
    // the opener is the active element; the shared helper finds the control
    // again when the row it was has been re-rendered under the menu.
    const opener = captureOpener(typeof document === 'undefined' ? null : document.activeElement)
    ref.current?.focus()
    const away = (e) => {
      if (!ref.current?.contains(e.target)) onClose()
    }
    // Anything that moves the page under the cursor strands the menu. The
    // listeners wait a tick: the right-click that opened the menu is still
    // bubbling and must not count as a click elsewhere.
    const listeners = [
      ['mousedown', away],
      ['contextmenu', away],
      ['resize', onClose],
      ['blur', onClose],
      ['wheel', onClose, { passive: true }],
    ]
    const arm = setTimeout(() => {
      for (const [type, fn, opts] of listeners) window.addEventListener(type, fn, opts)
    }, 0)
    return () => {
      clearTimeout(arm)
      for (const [type, fn] of listeners) window.removeEventListener(type, fn)
      // A row that opens a dialog focuses it in that dialog's own effect, so
      // this hands the keyboard back before the dialog claims it.
      focusOpener(opener)
    }
  }, [onClose])

  // Open at the cursor, kept inside the viewport.
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    const left = Math.max(8, Math.min(x, window.innerWidth - rect.width - 8))
    const top = Math.max(8, Math.min(y, window.innerHeight - rect.height - 8))
    el.style.left = `${left}px`
    el.style.top = `${top}px`
  }, [x, y])

  const run = (item) => {
    onClose()
    item.onSelect()
  }

  const onKeyDown = (e) => {
    if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      onClose()
      return
    }
    if (actions.length === 0) return
    const at = actions.findIndex(({ i }) => i === cursor)
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setCursor(actions[(at + 1) % actions.length].i)
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setCursor(actions[(at - 1 + actions.length) % actions.length].i)
    } else if (e.key === 'Home') {
      e.preventDefault()
      setCursor(actions[0].i)
    } else if (e.key === 'End') {
      e.preventDefault()
      setCursor(actions[actions.length - 1].i)
    } else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      if (at !== -1) run(items[cursor])
    }
  }

  // In the body, so no ancestor's transform or clipping can displace it.
  return createPortal(
    <div
      ref={ref}
      className="nc-menu ctx-menu"
      role="menu"
      tabIndex={-1}
      style={{ left: x, top: y }}
      onKeyDown={onKeyDown}
      onContextMenu={(e) => e.preventDefault()}
    >
      {items.map((item, i) => {
        if (item.divider) return <div key={i} className="ctx-sep" role="separator" />
        if (item.header) {
          return (
            <div key={i} className="nc-group-label">
              {item.header}
            </div>
          )
        }
        return (
          <button
            key={i}
            type="button"
            role="menuitem"
            className={`nc-item${i === cursor ? ' cursor' : ''}${item.danger ? ' ctx-danger' : ''}`}
            disabled={item.disabled}
            onClick={() => run(item)}
            onMouseEnter={() => !item.disabled && setCursor(i)}
          >
            <span className="nc-item-main">
              {item.icon && <span className="ctx-icon">{item.icon}</span>}
              <span className="nc-item-name">{item.label}</span>
              {item.hint && <span className="ctx-hint">{item.hint}</span>}
            </span>
          </button>
        )
      })}
    </div>,
    document.body,
  )
}
