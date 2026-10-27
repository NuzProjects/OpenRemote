// One dialog's worth of behaviour, shared by the whole modal family. A modal
// that only paints a backdrop is not modal: focus stays on the button behind
// it, Tab walks the page underneath, a screen reader still reads that page,
// and closing leaves the user at whatever spot the browser picks. This module
// is the piece that makes the word true, and it holds the existing Esc layer
// rather than answering the key itself, so a nested dialog still closes one
// step at a time.
//
// The rest of the app is made `inert` while a dialog is open: Chromium's
// attribute alone removes it from the tab order and the accessibility tree,
// which is both halves of the promise at once. The Tab loop below stays as
// well, because an older WebView without the attribute must not leave a
// keyboard user able to walk out of a dialog.

import { useEffect } from 'react'
import { useEscLayer } from './esc-layer.js'

// What a dialog can focus, in tab order. Spelled out rather than pulled from
// a library: the set of controls in this console's dialogs is small, and one
// selector is a thing to keep right instead of a dependency.
const FOCUSABLE = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',')

/** Everything the browser would focus inside a dialog, in document order. */
export function focusables(root) {
  if (!root || typeof root.querySelectorAll !== 'function') return []
  return [...root.querySelectorAll(FOCUSABLE)].filter(
    (el) => !el.hasAttribute('inert') && el.getClientRects().length > 0,
  )
}

/**
 * Where Tab goes from `active` among `count` stops. `null` means the browser's
 * own move is fine - a stop in the middle, or a dialog with nothing to focus.
 * The two ends wrap, and that wrap is the whole of "focus stays inside".
 */
export function tabTarget(count, active, shift) {
  if (count === 0) return null
  if (active < 0) return shift ? count - 1 : 0
  if (shift) return active === 0 ? count - 1 : null
  return active === count - 1 ? 0 : null
}

/**
 * Hide everything except the dialog's own branch from the rest of the app.
 * Returns the undo, which puts back only the elements it changed: a nested
 * dialog (a confirm over a panel) runs its own pass, sees the outer dialog's
 * marks already there, and restores exactly what it found.
 */
export function inertOthers(panel, doc = document) {
  const root = panel?.ownerDocument ?? doc
  const touched = []
  let node = panel
  while (node && node.parentElement && node !== root.body) {
    for (const sibling of [...node.parentElement.children]) {
      if (sibling === node || sibling.hasAttribute('inert')) continue
      // The titlebar carries the window's own controls. A dialog may own the
      // app, never the window: minimize, maximize and close stay live even
      // while a modal is up.
      if (sibling.matches?.('.titlebar')) continue
      sibling.setAttribute('inert', '')
      touched.push(sibling)
    }
    node = node.parentElement
  }
  return () => {
    for (const el of touched) el.removeAttribute('inert')
  }
}

/**
 * Everything a dialog owes the keyboard: focus in on open, Tab kept inside,
 * the rest of the app out of reach, focus back to the opener on close, and the
 * Esc layer stack joined. `esc` can be false for a dialog a picker sits over
 * (the picker answers its own Escape), while focus and the trap stay.
 */
export function useDialog(panelRef, onClose, { esc = true, open = true } = {}) {
  useEscLayer(open && esc, onClose)

  useEffect(() => {
    if (!open) return undefined
    const panel = panelRef.current
    if (!panel) return undefined
    const opener = document.activeElement
    // A dialog that already holds the focus must not take it away again: a
    // field marked autoFocus (the sign-in code, a confirm's own button) was
    // given the keyboard on purpose, and this hook runs after it.
    if (!panel.contains(document.activeElement)) {
      const first = focusables(panel)[0] ?? panel
      first.focus?.({ preventScroll: true })
    }
    const restore = inertOthers(panel)
    return () => {
      restore()
      // The opener is where the user was before the dialog; the body is not a
      // place to leave a keyboard user.
      if (opener && opener !== document.body && opener.isConnected) {
        opener.focus?.({ preventScroll: true })
      }
    }
  }, [open, panelRef])

  useEffect(() => {
    if (!open) return undefined
    const panel = panelRef.current
    if (!panel) return undefined
    const onKey = (e) => {
      if (e.key !== 'Tab') return
      const nodes = focusables(panel)
      if (nodes.length === 0) {
        // Nothing to tab to: keep the dialog itself focused rather than let
        // the key walk the page behind it.
        e.preventDefault()
        panel.focus()
        return
      }
      const target = tabTarget(nodes.length, nodes.indexOf(document.activeElement), e.shiftKey)
      if (target == null) return
      e.preventDefault()
      nodes[target].focus()
    }
    panel.addEventListener('keydown', onKey)
    return () => panel.removeEventListener('keydown', onKey)
  }, [open, panelRef])
}
