import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Check, X } from '@phosphor-icons/react'
import { useConsole } from './state/console.jsx'
import { chatStatus } from './state/reducer.js'
import { projectName } from './projects.js'
import { busyReason, setAskBeforeMove } from './move-chat.js'
import { useBack } from './use-back.js'
import './devices.css'
import './panels.css'
import './contextmenu.css'
import './move.css'

/**
 * Moving a chat to another project, asked first: a move changes where the
 * chat's agent works, so a stray drag or click must not do it alone. One
 * sentence says what changes; "Don't show this again" stops the asking on
 * this device (Settings turns it back on). Esc / backdrop / X / Cancel
 * close it like the other modals.
 *
 * move: { chat: { id, title }, to: project | null, from: project | null,
 *         device: the machine's name when the chat runs on another one }
 * failure: why a move made without asking failed - the dialog then says so
 * and offers to try again.
 */
export default function MoveChatModal({ move, failure = null, onClose }) {
  const { moveChat, chats, sessions } = useConsole()
  useBack(true, onClose)
  const [skip, setSkip] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(failure)
  const dialogRef = useRef(null)
  const { chat, to, from, device } = move
  // Live: a turn that ends while the dialog is open frees the move.
  const status =
    chats[chat.id]?.status ?? chatStatus((sessions ?? []).find((s) => s.id === chat.id)?.status)
  const blocked = busyReason(status)

  // The dialog takes the focus, not its Move button: an Enter meant for
  // whatever was focused before never confirms a move.
  useEffect(() => {
    dialogRef.current?.focus()
  }, [])

  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const confirm = async () => {
    if (skip) setAskBeforeMove(false)
    setBusy(true)
    setError(null)
    try {
      await moveChat(chat.id, to?.id ?? null)
      onClose()
    } catch (err) {
      setError(err.message ?? String(err))
      setBusy(false)
    }
  }

  const title = <span className="pv">“{chat.title ?? 'A new task'}”</span>
  const where = device ? (
    <>
      {' '}
      on <span className="pv">{device}</span>
    </>
  ) : null

  // In the body: the dialog is opened from the sidebar, a chat's header and
  // split panes alike, and none of their boxes may clip or shift it.
  return createPortal(
    <div
      className="dv-modal-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
      onContextMenu={(e) => {
        // A right-click here is not one on the pane behind the dialog.
        e.preventDefault()
        e.stopPropagation()
      }}
    >
      <div
        ref={dialogRef}
        className="dv-modal mv-modal"
        role="dialog"
        aria-modal="true"
        aria-label="Move chat"
        tabIndex={-1}
      >
        <div className="dv-modal-head">
          <h2 className="dv-modal-title mv-title">
            {failure ? (
              <>Couldn&apos;t move {title}</>
            ) : to ? (
              <>
                Move {title} to <span className="pv">{projectName(to)}</span>?
              </>
            ) : (
              <>
                Move {title} out of <span className="pv">{from ? projectName(from) : 'its project'}</span>?
              </>
            )}
          </h2>
          <button className="dv-modal-close" onClick={onClose} title="Close">
            <X size={14} weight="bold" />
          </button>
        </div>
        <p className="dv-modal-hint">
          {to ? (
            <>
              From its next message, the agent works in{' '}
              <code className="mv-path pv">{to.folders?.[0]}</code>
              {where}.
            </>
          ) : (
            <>
              From its next message, the agent works in your home folder{where} instead of{' '}
              <span className="pv">{from ? projectName(from) : 'its project'}</span>.
            </>
          )}
        </p>
        {blocked && !error && <p className="dv-error">{blocked}</p>}
        {error && <p className="dv-error">{error}</p>}
        {!failure && (
          <label className="mv-skip">
            <input type="checkbox" checked={skip} onChange={(e) => setSkip(e.target.checked)} />
            <span className="mv-box" aria-hidden="true">
              {skip && <Check size={10} weight="bold" />}
            </span>
            Don&apos;t show this again
          </label>
        )}
        <div className="ctx-modal-actions">
          <button type="button" className="dv-act" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button
            type="button"
            className="dv-act primary"
            onClick={confirm}
            disabled={busy || Boolean(blocked)}
          >
            {busy ? 'Moving…' : failure ? 'Try again' : 'Move'}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  )
}
