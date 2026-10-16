import { useCallback, useEffect, useRef, useState } from 'react'

// How long a note stays: long enough to read it and reach Undo.
const NOTE_MS = 6000

/**
 * The sidebar's one quiet note: what just happened to the list, with the
 * way back when there is one ("Archived. Undo"), or why something did not
 * work. It sits at the foot of the list for a few seconds; a newer note
 * replaces an older one and starts the clock again.
 *
 * say(text, { label, run }?, { veiled }?) shows it; dismiss() takes it away.
 * A note that may carry a name (a device, a chat) is veiled in privacy mode.
 */
export function useNote() {
  const [note, setNote] = useState(null)
  const timer = useRef(null)

  const dismiss = useCallback(() => {
    clearTimeout(timer.current)
    setNote(null)
  }, [])

  const say = useCallback(
    (text, action = null, { veiled = false } = {}) => {
      clearTimeout(timer.current)
      setNote({ text, action, veiled })
      timer.current = setTimeout(() => setNote(null), NOTE_MS)
    },
    [],
  )

  useEffect(() => () => clearTimeout(timer.current), [])
  return { note, say, dismiss }
}

export default function SidebarNote({ note, onDismiss }) {
  if (!note) return null
  const { text, action, veiled } = note
  return (
    <div className="sb-note" role="status">
      <span className={veiled ? 'sb-note-text pv' : 'sb-note-text'}>{text}</span>
      {action && (
        <button
          type="button"
          className="sb-note-action"
          onClick={() => {
            action.run()
            onDismiss()
          }}
        >
          {action.label}
        </button>
      )}
    </div>
  )
}
