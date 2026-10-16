import { useState, useSyncExternalStore } from 'react'
import {
  autoCheck,
  checkForUpdates,
  installUpdate,
  setAutoCheck,
  subscribeUpdates,
  updateState,
} from './updates.js'

// Settings > This install: is there a newer OpenRemote, and should the app
// keep looking. Installing always waits for the user's click: the app
// restarts into the new version, so it never happens under them.
export default function UpdatesRow() {
  const s = useSyncExternalStore(subscribeUpdates, updateState)
  const [auto, setAuto] = useState(autoCheck)
  const status = s.installing
    ? "Installing. The app restarts when it's done."
    : s.checking
      ? 'Looking for a newer version…'
      : s.available
        ? `Version ${s.available.version} is ready.`
        : s.error
          ? s.error
          : s.checkedAt
            ? 'This is the newest version.'
            : 'Looks once a day while the app runs.'
  return (
    <>
      <div className="pn-row">
        <div>
          <div className="pn-name">Updates</div>
          <div className="pn-detail">{status}</div>
        </div>
        {s.available ? (
          <button type="button" className="pn-btn on" onClick={installUpdate} disabled={s.installing}>
            Update and restart
          </button>
        ) : (
          <button type="button" className="pn-btn" onClick={checkForUpdates} disabled={s.checking}>
            Check now
          </button>
        )}
      </div>
      <div className="pn-row">
        <div>
          <div className="pn-name">Look for updates automatically</div>
          <div className="pn-detail">Once a day. Installing still waits for you.</div>
        </div>
        <button
          type="button"
          className={auto ? 'pn-btn on' : 'pn-btn'}
          onClick={() => {
            setAutoCheck(!auto)
            setAuto(!auto)
          }}
        >
          {auto ? 'On' : 'Off'}
        </button>
      </div>
    </>
  )
}
