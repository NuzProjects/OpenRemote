import { useConsole } from './state/console.jsx'
import { daemonStatus } from './daemon-status.js'
import { isMobile } from './platform.js'
import './daemon-status.css'

// The screen the app shows while it has no daemon: what happened, when the
// shell has a reason to give, and one button that starts it again. It is
// not a dead end: the console keeps asking, so the panel leaves by itself
// the moment a daemon answers. `onManualConnect` keeps the door open for
// someone who runs the daemon themselves instead of the app's sidecar, and
// only on a computer: the phone app has no daemon of its own to point at,
// so an address form there would ask for something a phone cannot produce.
export default function DaemonStatus({ onManualConnect = null }) {
  const { daemon, retryDaemon } = useConsole()
  const status = daemonStatus(daemon)

  return (
    <div className="ds">
      <div className="ds-panel" role="status" aria-live="polite">
        <h1 className="ds-title">{status.title}</h1>
        {status.detail && <p className="ds-detail">{status.detail}</p>}
        <p className="ds-note">{status.note}</p>
        {status.action === 'try-now' && (
          <button className="ds-cta" onClick={retryDaemon}>
            Try now
          </button>
        )}
        {onManualConnect && !isMobile && (
          <button className="ds-link" onClick={onManualConnect}>
            Connect by address instead
          </button>
        )}
      </div>
    </div>
  )
}
