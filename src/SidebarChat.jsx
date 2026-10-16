import { useEffect, useRef, useState } from 'react'
import { Archive, Cloud } from '@phosphor-icons/react'
import { HarnessMark } from './brand-marks.jsx'
import { DOT_WORDS } from './sidebar-groups.js'
import { isMobile } from './platform.js'

// The name's field. Enter saves, Esc cancels, and leaving the field saves
// (the way a file's name does) - but an edit settles once: Enter and Esc
// are each followed by a blur that must not settle it again. The text is
// veiled in privacy mode like every chat title: the name is private
// whether it is read or typed.
function RenameField({ initial, onSave, onCancel }) {
  const [draft, setDraft] = useState(initial)
  const field = useRef(null)
  const settled = useRef(false)

  useEffect(() => {
    field.current?.focus()
    field.current?.select()
  }, [])

  const settle = (save) => {
    if (settled.current) return
    settled.current = true
    if (save) onSave(draft)
    else onCancel()
  }

  return (
    <input
      ref={field}
      className="chat-rename pv"
      value={draft}
      maxLength={200}
      spellCheck={false}
      placeholder="Automatic name"
      aria-label="Chat name"
      onChange={(e) => setDraft(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault()
          settle(true)
        } else if (e.key === 'Escape') {
          // Esc here is this edit's, not the app's (it would interrupt the
          // open chat's turn).
          e.preventDefault()
          e.stopPropagation()
          settle(false)
        }
      }}
      onBlur={() => settle(true)}
    />
  )
}

/**
 * One chat in the sidebar: its harness's mark leads (the at-a-glance
 * signal of which agent owns it, sized to read from afar), then its name
 * and where it runs, with the status dot at the right edge so every
 * status scans in one column. A double click on the name (desktop) turns
 * it into a field to rename the chat in place.
 *
 * `kind` is the dot to wear (see dotKind in sidebar-groups.js).
 */
export default function SidebarChat({
  row,
  kind,
  mode,
  active,
  dragged,
  privacy,
  renaming,
  onOpen,
  onArchive,
  onMenu,
  onPointerDown,
  onRenameStart,
  onRenameSave,
  onRenameCancel,
}) {
  const words = kind === 'offline' ? (privacy ? 'Offline' : `${row.device} is offline`) : DOT_WORDS[kind]
  const dot = (
    <span
      className={`dot dot--${kind}`}
      title={words}
      role={words ? 'img' : undefined}
      aria-label={words}
    />
  )
  const mark = row.harness && <HarnessMark harness={row.harness} size={15} />

  return (
    <div
      className={`chat-item${dragged ? ' sb-dragged' : ''}`}
      // While the name is being edited the field keeps the browser's own
      // menu (copy, paste).
      onContextMenu={
        renaming
          ? undefined
          : (e) => {
              e.preventDefault()
              onMenu(e, row)
            }
      }
    >
      {renaming ? (
        <div className={`chat-row renaming${active ? ' active' : ''}`} data-status={row.status}>
          {mark}
          <RenameField initial={row.named ? row.title : ''} onSave={(text) => onRenameSave(row, text)} onCancel={onRenameCancel} />
          {dot}
        </div>
      ) : (
        <>
          <button
            className={`chat-row${active ? ' active' : ''}`}
            data-status={row.status}
            data-unseen={kind === 'unseen' ? '' : undefined}
            onClick={() => onOpen(row.id)}
            onDoubleClick={isMobile ? undefined : () => onRenameStart(row.id)}
            onPointerDown={onPointerDown}
          >
            {mark}
            <span className="chat-title pv">{row.title}</span>
            {mode === 'cloud' && row.device && <span className="chat-device pv">{row.device}</span>}
            {mode === 'local' && row.synced && (
              <Cloud size={11} className="chat-synced" aria-label="Synced to your devices" />
            )}
            {dot}
          </button>
          {/* Archive hides the chat from this list; Settings keeps it. */}
          <button
            type="button"
            className="chat-archive"
            title="Archive this chat"
            aria-label={`Archive ${row.title}`}
            onClick={() => onArchive(row.id)}
          >
            <Archive size={12} />
          </button>
        </>
      )}
    </div>
  )
}
