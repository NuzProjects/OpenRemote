// Add a machine: a one-time install command for a Linux computer. Run on
// the machine, it installs OpenRemote as a background service and joins
// this Cloud; the modal notices when it arrives. The command works once,
// for an hour.

import { useEffect, useRef, useState } from 'react'
import { Check, Copy, X } from '@phosphor-icons/react'
import { useConsole } from './state/console.jsx'
import { useBack } from './use-back.js'
import { useDialog } from './dialog-focus.js'

export default function AddMachineModal({ onClose }) {
  useBack(true, onClose)
  const panelRef = useRef(null)
  useDialog(panelRef, onClose)
  const { createEnrollment, devices, refreshCloud } = useConsole()
  const [enrollment, setEnrollment] = useState(null)
  const [error, setError] = useState(null)
  const [copied, setCopied] = useState(false)
  const [now, setNow] = useState(() => Date.now())
  // The devices there before the command existed: a new one is the arrival.
  const known = useRef(new Set((devices ?? []).map((d) => d.id)))
  // One mint per mount: React 19 StrictMode double-invokes mount
  // effects in dev, and two enrollments means two working install
  // commands where the user only ever saw one. A new command is a
  // deliberate press of the button, never a remount.
  const minted = useRef(false)

  const mint = async () => {
    setError(null)
    setCopied(false)
    try {
      setEnrollment(await createEnrollment())
    } catch (err) {
      setError(err.message ?? String(err))
    }
  }

  useEffect(() => {
    if (minted.current) return
    minted.current = true
    mint()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Look for the machine while the modal is open (the poll is slower).
  useEffect(() => {
    const tick = setInterval(() => {
      setNow(Date.now())
      refreshCloud()
    }, 2000)
    return () => clearInterval(tick)
  }, [refreshCloud])

  const joined = (devices ?? []).find((d) => !known.current.has(d.id) && d.created_via === 'enrollment')
  const expired = enrollment && enrollment.expires_at > 0 && now / 1000 > enrollment.expires_at

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(enrollment.install_command)
      setCopied(true)
    } catch {
      /* the command stays selectable */
    }
  }

  return (
    <div
      className="dv-modal-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div className="dv-modal" ref={panelRef} tabIndex={-1} role="dialog" aria-modal="true" aria-label="Add a machine">
        <div className="dv-modal-head">
          <h2 className="dv-modal-title">Add a machine</h2>
          <button className="dv-modal-close" onClick={onClose} title="Close">
            <X size={14} weight="bold" />
          </button>
        </div>
        {joined ? (
          <p className="dv-modal-hint">
            <span className="pv">{joined.name}</span> joined your Cloud. Your devices can run chats on it now.
          </p>
        ) : (
          <>
            <p className="dv-modal-hint">
              Run this on a Linux computer. It installs OpenRemote as a background service and joins your Cloud as a
              machine. The command works once, for an hour.
            </p>
            {enrollment && !expired && (
              <div className="dv-modal-cmd">
                <code>{enrollment.install_command}</code>
                <button className="dv-modal-copy" onClick={copy} title="Copy command">
                  {copied ? <Check size={13} weight="bold" /> : <Copy size={13} />}
                </button>
              </div>
            )}
            {enrollment && !expired && <p className="dv-modal-hint">Waiting for it to join…</p>}
          </>
        )}
        {error && <p className="dv-error">{error}</p>}
        {(expired || error) && !joined && (
          <button type="button" className="dv-act dv-connect" onClick={mint}>
            Get a new command
          </button>
        )}
        {joined && (
          <button type="button" className="dv-act dv-connect" onClick={onClose}>
            Done
          </button>
        )}
      </div>
    </div>
  )
}
