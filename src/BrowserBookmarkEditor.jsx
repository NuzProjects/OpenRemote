// The star's small editor (Chrome's): the bookmark's name and folder,
// Remove, Done. Enter, Esc and a click elsewhere all keep the bookmark as
// edited; only Remove takes it away. It floats over the page, so the page
// shows as its picture while it is open (browser-occlusion.js).

import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { FOLDERS } from './browser-bookmarks.js'
import './panels.css'
import './contextmenu.css'

const WIDTH = 300

export default function BrowserBookmarkEditor({ mark, fresh, anchor, onDone, onRemove }) {
  const ref = useRef(null)
  const [title, setTitle] = useState(mark.title ?? '')
  const [folder, setFolder] = useState(mark.folder === 'other' ? 'other' : 'bar')
  const latest = useRef(null)
  latest.current = () => onDone({ title: title.trim() || mark.title || mark.url, folder })

  // A click anywhere else closes it, as Done. It waits a tick: the click
  // that opened it is still on its way.
  useEffect(() => {
    const away = (e) => {
      // The star itself leaves the editor open (it opened it).
      if (ref.current?.contains(e.target) || e.target.closest?.('[data-bw-anchor="star"]')) return
      latest.current()
    }
    const arm = setTimeout(() => window.addEventListener('mousedown', away, true), 0)
    return () => {
      clearTimeout(arm)
      window.removeEventListener('mousedown', away, true)
    }
  }, [])

  // Under the star, its right edge at the star's, kept on screen.
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const left = Math.max(8, Math.min(anchor.right - WIDTH, window.innerWidth - WIDTH - 8))
    const top = Math.max(8, Math.min(anchor.y, window.innerHeight - el.offsetHeight - 8))
    el.style.left = `${left}px`
    el.style.top = `${top}px`
  }, [anchor])

  return createPortal(
    <div
      ref={ref}
      className="bw-pop"
      role="dialog"
      aria-label={fresh ? 'Bookmark added' : 'Edit bookmark'}
      style={{ width: WIDTH, left: anchor.right - WIDTH, top: anchor.y }}
      onKeyDown={(e) => {
        if (e.key === 'Escape' || (e.key === 'Enter' && e.target.tagName === 'INPUT')) {
          e.preventDefault()
          e.stopPropagation()
          latest.current()
        }
      }}
    >
      <div className="bw-pop-title">{fresh ? 'Bookmark added' : 'Edit bookmark'}</div>
      <label className="bw-field">
        <span>Name</span>
        <input
          value={title}
          spellCheck={false}
          autoFocus
          onFocus={(e) => e.target.select()}
          onChange={(e) => setTitle(e.target.value)}
        />
      </label>
      <div className="bw-field">
        <span>Folder</span>
        <div className="bw-seg" role="radiogroup" aria-label="Folder">
          {Object.entries(FOLDERS).map(([id, label]) => (
            <button
              key={id}
              type="button"
              role="radio"
              aria-checked={folder === id}
              className={folder === id ? 'on' : ''}
              onClick={() => setFolder(id)}
            >
              {label}
            </button>
          ))}
        </div>
      </div>
      <div className="ctx-modal-actions">
        <button type="button" className="pn-btn" onClick={onRemove}>
          Remove
        </button>
        <button type="button" className="pn-btn bw-primary" onClick={() => latest.current()}>
          Done
        </button>
      </div>
    </div>,
    document.body,
  )
}
