import { useEffect, useRef, useState } from 'react'
import { X } from '@phosphor-icons/react'
import { useBack } from './use-back.js'
import { useDialog } from './dialog-focus.js'
import { MAX_NAME, renameState } from './rename-chat.js'
import { NAME_LIMIT, presetSummary } from './presets.js'
import './devices.css'
import './panels.css'
import './contextmenu.css'
import './rename-chat.css'
import { errorCopy } from './error-copy.js'

// Saving a chat's setup as a New chat preset. It asks the same kind of
// question the rename dialog asks - a name for something the console already
// holds - so it is the same one-field dialog and the same rules about what
// counts as a name (rename-chat.js), with the setup's own description offered
// as the first answer.
//
// The shell is the shared modal family: focus lands in the field with the
// suggested name selected, Esc / backdrop / X discard, Tab stays inside, the
// app behind goes inert (dialog-focus.js), Enter saves. The dialog closes only
// once the row is written: a refused save (a full shelf of presets, say) stays
// open with its sentence, because closing would pretend a preset now exists.
export default function PresetNameModal({ preset, onSave, onClose }) {
  useBack(true, onClose)
  const panelRef = useRef(null)
  useDialog(panelRef, onClose)
  const inputRef = useRef(null)
  const [text, setText] = useState(preset?.name ?? '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  // A preset is new, so there is no "unchanged" to close on: any non-empty
  // name saves, and an empty one is refused by the same rule the rename uses.
  const verdict = renameState(null, text)
  const description = presetSummary(preset)

  // The suggested name is selected, so the first keystroke replaces it: the
  // dialog asks for a name, and making someone delete "Opus high, this repo"
  // letter by letter to say "Opus" would be busywork.
  useEffect(() => {
    const input = inputRef.current
    if (!input) return
    input.focus()
    input.select()
  }, [])

  const save = async () => {
    if (busy || verdict.state === 'empty') return
    setBusy(true)
    setError(null)
    try {
      const result = await onSave(verdict.value)
      // The save answers with the storage's own refusal when it could not
      // write; that sentence stays on screen with the dialog open.
      if (result?.error) {
        setError(result.error)
        setBusy(false)
        return
      }
      onClose()
    } catch (err) {
      setError(errorCopy(err))
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
        aria-label="Name this setup"
      >
        <div className="dv-modal-head">
          <h2 className="dv-modal-title">Name this setup</h2>
          <button className="dv-modal-close" onClick={onClose} title="Close">
            <X size={14} weight="bold" />
          </button>
        </div>
        <input
          ref={inputRef}
          className="rn-input"
          value={text}
          maxLength={Math.min(NAME_LIMIT, MAX_NAME)}
          aria-label="Setup name"
          aria-invalid={verdict.state === 'empty' ? 'true' : undefined}
          onChange={(e) => {
            setText(e.target.value)
            // A refused name is refused for what is in the field; typing again
            // is the answer to it, so the old sentence goes.
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
          {verdict.state === 'empty' ? 'A setup needs a name.' : description}
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
            {busy ? 'Saving...' : 'Save setup'}
          </button>
        </div>
      </div>
    </div>
  )
}
