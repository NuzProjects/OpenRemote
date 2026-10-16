// The cheat sheet (Ctrl+/): every action that has a key, by group, with
// the key as it is bound on this device right now.

import { useEffect } from 'react'
import { X } from '@phosphor-icons/react'
import { useKeyboard, isMac } from './keyboard.jsx'
import { CATALOG, GROUPS, comboLabel } from './shortcuts.js'
import { hasTauri } from './platform.js'
import './keyboard.css'

export default function ShortcutSheet({ onClose }) {
  const kb = useKeyboard()

  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  // The browser's keys only where there is a browser: the desktop app.
  const groups = GROUPS.filter((g) => g.id !== 'browser' || hasTauri).map((g) => ({
    ...g,
    rows: CATALOG.filter((a) => a.group === g.id && kb.bindings[a.id]),
  })).filter((g) => g.rows.length)

  return (
    <div
      className="kb-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div className="kb-sheet" role="dialog" aria-modal="true" aria-label="Keyboard shortcuts">
        <div className="kb-sheet-head">
          <h2>Keyboard shortcuts</h2>
          <button type="button" className="dv-modal-close" onClick={onClose} title="Close">
            <X size={14} weight="bold" />
          </button>
        </div>
        <div className="kb-sheet-grid">
          {groups.map((g) => (
            <section key={g.id} className="kb-sheet-group">
              <div className="kb-group-label">{g.label}</div>
              {g.rows.map((a) => (
                <div key={a.id} className="kb-sheet-row">
                  <span>{a.label}</span>
                  <kbd className="kb-keys">{comboLabel(kb.bindings[a.id], isMac)}</kbd>
                </div>
              ))}
            </section>
          ))}
        </div>
        <p className="kb-sheet-foot">
          Everything else is in the command palette
          {kb.bindings.palette ? ` (${comboLabel(kb.bindings.palette, isMac)})` : ''}. Change any key in
          Settings, under Keyboard.
        </p>
      </div>
    </div>
  )
}
