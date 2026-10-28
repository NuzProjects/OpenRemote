import { useRef } from 'react'
import { X } from '@phosphor-icons/react'
import { useBack } from './use-back.js'
import { useDialog } from './dialog-focus.js'
import './devices.css'
import './panels.css'
import './contextmenu.css'
import './rename-chat.css'

// Restoring a saved shape over panes that are already open replaces them, and
// until this dialog existed it did so without a word: four chats on screen
// became the saved shape and the only way back was reopening them one by one.
//
// The question, its note and the pane count all come from layouts.js
// (restoreConfirm), which answers null when nothing would be lost - an empty
// window, the shape already on screen, or a plan this window cannot open. This
// component only draws the family's modal around that answer.
export default function RestoreLayoutConfirm({ title, note, confirm, cancel, onConfirm, onClose }) {
  useBack(true, onClose)
  const panelRef = useRef(null)
  useDialog(panelRef, onClose)

  return (
    <div className="dv-modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div
        className="dv-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="restore-layout-title"
        tabIndex={-1}
        ref={panelRef}
      >
        <div className="dv-modal-head">
          <h2 className="dv-modal-title" id="restore-layout-title">
            {title}
          </h2>
          <button className="dv-modal-close" onClick={onClose} title="Close">
            <X size={14} />
          </button>
        </div>
        <p className="rn-note">{note}</p>
        <div className="ctx-modal-actions">
          {/* The safe answer first, the way every destructive pair in the
              console reads: keeping what is open costs nothing. */}
          <button type="button" className="pn-btn" onClick={onClose}>
            {cancel}
          </button>
          <button type="button" className="pn-btn rn-primary" onClick={onConfirm} autoFocus>
            {confirm}
          </button>
        </div>
      </div>
    </div>
  )
}
