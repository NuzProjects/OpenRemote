// Saving the window's shape under a name.
//
// The dialog is the console's own family: one field, Cancel and Save, Esc and
// the backdrop close it, focus goes in and comes back. The rules are layouts.js's
// - this only asks for the name and writes what it hands back. What gets stored
// is the tree, its sizes and each pane's role; never a chat id, because the chat
// in a pane today is not the chat a person wants there a week from now.

import { useRef, useState } from 'react'
import { X } from '@phosphor-icons/react'
import { useConsole } from './state/console.jsx'
import { useBack } from './use-back.js'
import { useDialog } from './dialog-focus.js'
import { NAME_CAP, loadLayouts, saveLayouts, shapeOf, withLayout } from './layouts.js'
import './devices.css'
import './panels.css'
import './contextmenu.css'
import './save-layout.css'
import { errorCopy } from './error-copy.js'

export default function SaveLayoutModal({ layout, currentView, onClose, onSaved }) {
  const { sessions } = useConsole()
  const panelRef = useRef(null)
  const [name, setName] = useState('')
  const [error, setError] = useState(null)
  useBack(true, onClose)
  useDialog(panelRef, onClose)

  // The chat test is the console's own list, so a view that is not one of the
  // static ones and not a chat cannot be saved as either.
  const isChat = (view) => (sessions ?? []).some((session) => session.id === view)
  const shape = shapeOf(layout, { primaryView: currentView, isChat })
  const ready = name.trim().length > 0 && shape.ok

  const save = () => {
    if (!ready) return
    try {
      const saved = withLayout(
        loadLayouts(),
        { name: name.trim(), panes: shape.panes, tree: shape.tree },
        { now: Date.now() },
      )
      saveLayouts(saved)
      onSaved?.(saved)
      onClose()
    } catch (err) {
      setError(errorCopy(err))
    }
  }

  return (
    <div
      className="dv-modal-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div
        className="dv-modal"
        ref={panelRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label="Save this layout"
      >
        <div className="dv-modal-head">
          <h2 className="dv-modal-title">Save this layout</h2>
          <button className="dv-modal-close" onClick={onClose} title="Close">
            <X size={14} weight="bold" />
          </button>
        </div>
        <p className="dv-modal-hint">
          Every pane keeps its place and its size. A chat pane opens whichever chat you are in when you
          restore it, not the one here today.
        </p>
        <label className="sl-field">
          <span className="sl-label">Name</span>
          <input
            className="sl-input"
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                save()
              }
            }}
            placeholder="For example: review"
            maxLength={NAME_CAP}
            autoFocus
            spellCheck={false}
          />
        </label>
        {!shape.ok && (
          <p className="sl-error">
            {shape.reason === 'too-few-panes'
              ? 'A layout of one pane is just the window; open a second pane first.'
              : 'One of these panes is showing something a layout cannot name.'}
          </p>
        )}
        {error && <p className="sl-error">{error}</p>}
        <div className="ctx-modal-actions">
          <button type="button" className="pn-btn" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="pn-btn sl-save" onClick={save} disabled={!ready}>
            Save layout
          </button>
        </div>
      </div>
    </div>
  )
}
