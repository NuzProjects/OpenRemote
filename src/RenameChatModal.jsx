import { useEffect, useRef, useState } from 'react'
import { X } from '@phosphor-icons/react'
import { useBack } from './use-back.js'
import { useDialog } from './dialog-focus.js'
import { MAX_NAME, renameState } from './rename-chat.js'
import './devices.css'
import './panels.css'
import './contextmenu.css'
import './rename-chat.css'

// Renaming a chat, in the console, in one field. Every chat starts as "A new
// task" and the only other way to change it is the `/rename` command, which
// nobody discovers; a name is how a chat is found again in a list of thirty.
//
// The shell is the shared modal family: focus lands in the field with the
// current name selected, Esc / backdrop / X discard, Tab stays inside, and
// the app behind goes inert (dialog-focus.js). Enter saves. The rules about
// what counts as a name live in rename-chat.js, tested without a DOM.
//
// The dialog closes only after the daemon accepted the name: a refused rename
// stays open with the daemon's own sentence, because closing would pretend a
// rename had landed and the sidebar would still show the old name.
export default function RenameChatModal({ title, synced = false, onRename, onClose }) {
  useBack(true, onClose)
  const panelRef = useRef(null)
  useDialog(panelRef, onClose)
  const inputRef = useRef(null)
  const [text, setText] = useState(title ?? '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const verdict = renameState(title, text)
  const where = synced
    ? 'Every device that has this chat shows the new name.'
    : 'This name stays on this computer.'

  // The current name is selected, so the first keystroke replaces it: the
  // dialog asks for a new name, and making someone retype the old one to keep
  // it would be busywork.
  useEffect(() => {
    const input = inputRef.current
    if (!input) return
    input.focus()
    input.select()
  }, [])

  const save = async () => {
    if (busy) return
    // Nothing to write: the same name closes the dialog (the name is already
    // the one on screen), and an empty field is refused by the rule below.
    if (verdict.state === 'unchanged') {
      onClose()
      return
    }
    if (verdict.state === 'empty') return
    setBusy(true)
    setError(null)
    try {
      await onRename(verdict.value)
      onClose()
    } catch (err) {
      setError(err?.message ?? String(err))
      setBusy(false)
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
        aria-label="Rename this chat"
      >
        <div className="dv-modal-head">
          <h2 className="dv-modal-title">Rename this chat</h2>
          <button className="dv-modal-close" onClick={onClose} title="Close">
            <X size={14} weight="bold" />
          </button>
        </div>
        <input
          ref={inputRef}
          className="rn-input"
          value={text}
          maxLength={MAX_NAME}
          aria-label="Chat name"
          aria-invalid={verdict.state === 'empty' ? 'true' : undefined}
          onChange={(e) => {
            setText(e.target.value)
            // A refused name is refused for what is in the field; typing
            // again is the answer to it, so the old sentence goes.
            setError(null)
          }}
          onKeyDown={(e) => {
            if (e.key !== 'Enter') return
            e.preventDefault()
            save()
          }}
          spellCheck={false}
          disabled={busy}
        />
        <p className={`rn-note${verdict.state === 'empty' ? ' is-bad' : ''}`}>
          {verdict.state === 'empty' ? 'A chat needs a name.' : where}
        </p>
        {error && <p className="cv-error-line">{error}</p>}
        <div className="ctx-modal-actions">
          <button type="button" className="pn-btn" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button
            type="button"
            className="pn-btn rn-primary"
            onClick={save}
            disabled={busy || verdict.state === 'empty'}
          >
            {busy ? 'Saving...' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  )
}
