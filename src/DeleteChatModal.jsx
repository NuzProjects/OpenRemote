import { useEffect, useState } from 'react'
import { X } from '@phosphor-icons/react'
import { useBack } from './use-back.js'
import './devices.css'
import './panels.css'
import './contextmenu.css'

// Deleting a synced chat is not undoable and reaches every device, so it is
// asked once, in place. Esc / backdrop / X close it like the other modals.
export default function DeleteChatModal({ title, onDelete, onClose }) {
  useBack(true, onClose)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)

  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const confirm = async () => {
    setBusy(true)
    setError(null)
    try {
      await onDelete()
      onClose()
    } catch (err) {
      setError(err.message ?? String(err))
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
      <div className="dv-modal" role="dialog" aria-modal="true" aria-label="Delete chat">
        <div className="dv-modal-head">
          <h2 className="dv-modal-title">Delete this chat?</h2>
          <button className="dv-modal-close" onClick={onClose} title="Close">
            <X size={14} weight="bold" />
          </button>
        </div>
        <p className="dv-modal-hint">
          <strong className="pv">{title}</strong> is deleted from every device it is synced to. This can't be undone.
        </p>
        {error && <p className="cv-error-line">{error}</p>}
        <div className="ctx-modal-actions">
          <button type="button" className="pn-btn" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button type="button" className="pn-btn pn-btn--danger" onClick={confirm} disabled={busy}>
            {busy ? 'Deleting...' : 'Delete everywhere'}
          </button>
        </div>
      </div>
    </div>
  )
}
