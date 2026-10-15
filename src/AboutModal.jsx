import { useEffect, useState } from 'react'
import { X } from '@phosphor-icons/react'
// The one copy of the version the UI renders - package.json is the
// source; tauri.conf.json and src-tauri/Cargo.toml carry it for the
// installer side.
import { version } from '../package.json'
import './about.css'
import { useBack } from './use-back.js'

export default function AboutModal({ onClose, daemonVersion, api }) {
  useBack(true, onClose)
  // 'about' is the glance; 'licenses' swaps the body to the notices.
  const [view, setView] = useState('about')
  const [notices, setNotices] = useState(null)
  const [noticesError, setNoticesError] = useState(null)
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])
  // The daemon serves the notices itself (GET /notices), so the text is
  // whatever this build carries - the same file the installers bundle
  // beside the app. Fetched once, only when the licenses are asked for.
  useEffect(() => {
    if (view !== 'licenses' || notices !== null || noticesError !== null || !api?.ready) {
      return
    }
    let stopped = false
    api
      .notices()
      .then((text) => {
        if (!stopped) setNotices(text)
      })
      .catch(() => {
        if (!stopped) setNoticesError('The licenses could not be loaded.')
      })
    return () => {
      stopped = true
    }
  }, [view, notices, noticesError, api])

  return (
    <div
      className="ab-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div
        className={view === 'licenses' ? 'ab-modal ab-modal--wide' : 'ab-modal'}
        role="dialog"
        aria-modal="true"
        aria-label={view === 'licenses' ? 'Third-party licenses' : 'About OpenRemote'}
      >
        <div className="ab-head">
          <h2 className="ab-wordmark">{view === 'licenses' ? 'Third-party licenses' : 'OpenRemote'}</h2>
          <button className="ab-close" onClick={onClose} title="Close">
            <X size={14} weight="bold" />
          </button>
        </div>
        {view === 'about' ? (
          <>
            <div className="ab-version">Version {version} · slice 1</div>
            {daemonVersion && <div className="ab-version">Daemon {daemonVersion}</div>}
            <div className="ab-sep" />
            <button type="button" className="ab-btn ab-btn--block" onClick={() => setView('licenses')}>
              Third-party licenses
            </button>
            <div className="ab-foot">Moreweb · 2026</div>
          </>
        ) : noticesError !== null ? (
          <>
            <div className="ab-notices-error">{noticesError}</div>
            <button type="button" className="ab-btn ab-btn--block" onClick={() => setView('about')}>
              Back
            </button>
          </>
        ) : notices !== null ? (
          <>
            <pre className="ab-notices" aria-label="Third-party notices">{notices}</pre>
            <button type="button" className="ab-btn ab-btn--block" onClick={() => setView('about')}>
              Back
            </button>
          </>
        ) : (
          <>
            <div className="ab-notices-loading">Loading the licenses…</div>
            <button type="button" className="ab-btn ab-btn--block" onClick={() => setView('about')}>
              Back
            </button>
          </>
        )}
      </div>
    </div>
  )
}
