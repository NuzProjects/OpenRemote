// "Clear browsing data", from Settings > Browser and the history page:
// history over a time range, and the browser's cookies and site data and
// its cache. The shell clears those two whole (a time range doesn't reach
// them), and the dialog says so.

import { useEffect, useState } from 'react'
import { X } from '@phosphor-icons/react'
import { CLEAR_RANGES, sinceFor } from './browser-history.js'
import { clearBrowsingData } from './browser-data.js'
import './devices.css'
import './panels.css'
import './contextmenu.css'
import './browser-settings.css'

export default function BrowserClearData({ api, onClose, onCleared }) {
  const [range, setRange] = useState('hour')
  const [history, setHistory] = useState(true)
  // Off unless chosen: it signs the user out of most sites.
  const [cookies, setCookies] = useState(false)
  const [cache, setCache] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)

  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const clear = async () => {
    setBusy(true)
    setError(null)
    try {
      await clearBrowsingData(api, { since: sinceFor(range), history, cookies, cache })
      onCleared?.()
      onClose()
    } catch (err) {
      setError(err?.message ?? String(err))
      setBusy(false)
    }
  }

  const rows = [
    {
      on: history,
      set: setHistory,
      name: 'Browsing history',
      detail: 'The pages you visited in the time above.',
    },
    {
      on: cookies,
      set: setCookies,
      name: 'Cookies and site data',
      detail: 'Signs you out of most sites. Every site, from any time.',
    },
    {
      on: cache,
      set: setCache,
      name: 'Cached images and files',
      detail: 'Frees space; some pages load more slowly the first time after. From any time.',
    },
  ]

  return (
    <div
      className="dv-modal-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div className="dv-modal bw-dialog" role="dialog" aria-modal="true" aria-label="Clear browsing data">
        <div className="dv-modal-head">
          <h2 className="dv-modal-title">Clear browsing data</h2>
          <button type="button" className="dv-modal-close" onClick={onClose} title="Close">
            <X size={14} weight="bold" />
          </button>
        </div>
        <div className="bw-clear-ranges" role="radiogroup" aria-label="Time range">
          {CLEAR_RANGES.map((r) => (
            <button
              key={r.id}
              type="button"
              role="radio"
              aria-checked={range === r.id}
              className={range === r.id ? 'on' : ''}
              onClick={() => setRange(r.id)}
            >
              {r.label}
            </button>
          ))}
        </div>
        {rows.map((row) => (
          <label key={row.name} className="bw-clear-row">
            <input type="checkbox" checked={row.on} onChange={(e) => row.set(e.target.checked)} />
            <span>
              <span className="bw-clear-name">{row.name}</span>
              <span className="bw-clear-detail">{row.detail}</span>
            </span>
          </label>
        ))}
        {error && <p className="bw-dialog-error">{error}</p>}
        <div className="ctx-modal-actions">
          <button type="button" className="pn-btn" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button
            type="button"
            className="pn-btn pn-btn--danger"
            onClick={clear}
            disabled={busy || !(history || cookies || cache)}
          >
            {busy ? 'Clearing...' : 'Clear data'}
          </button>
        </div>
      </div>
    </div>
  )
}
