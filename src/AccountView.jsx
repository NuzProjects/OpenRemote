// Account: the moreweb account this console belongs to - the sign-in and
// its state, this device's identity in it, and the devices it spans.
// One row per fact; a row renders only when the poll has answered its
// fact, so nothing here is ever dead.

import { useConsole } from './state/console.jsx'
import { kindLabel, platformLabel, signedIn } from './cloud.js'
import { isMobile } from './platform.js'
import CloudStateRow from './CloudStateRow.jsx'
import './devices.css'
import './panels.css'

export default function AccountView({ onOpenMachines }) {
  const { cloud, devices, thisDevice } = useConsole()
  const inCloud = signedIn(cloud)
  const one = isMobile ? 'phone' : 'computer'
  // The devices list knows the version; the cloud view answers even
  // while it is empty. Whichever holds the fact, the row shows it.
  const me = (devices ?? []).find((d) => d.id === thisDevice) ?? cloud?.device ?? null
  const meDetail = me
    ? [platformLabel(me.platform), kindLabel(me), me.app_version].filter(Boolean).join(' · ')
    : null
  const onlineCount = (devices ?? []).filter((d) => d.online).length

  return (
    <div className="panel">
      <header className="dv-head">
        <div>
          <h1 className="dv-title">Account</h1>
          <p className="dv-meta">
            {inCloud ? (cloud.account?.email ?? 'Signed in') : 'Not signed in'}
          </p>
        </div>
      </header>

      <h2 className="pn-section">Cloud</h2>
      <p className="pn-lead">
        Your moreweb account, and this {one}'s place in it.
      </p>
      <div className="pn-list pn-list--tight">
        <CloudStateRow one={one} />
      </div>

      {me && (
        <>
          <h2 className="pn-section">This {one}</h2>
          <div className="pn-list pn-list--tight">
            <div className="pn-row">
              <div>
                <div className="pn-name">{me.name}</div>
                <div className="pn-detail">{meDetail}</div>
              </div>
            </div>
          </div>
        </>
      )}

      {(devices ?? []).length > 0 && (
        <>
          <h2 className="pn-section">Devices</h2>
          <div className="pn-list pn-list--tight">
            <div className="pn-row">
              <div>
                <div className="pn-name">
                  {devices.length} {devices.length === 1 ? 'device' : 'devices'} · {onlineCount} online
                </div>
                <div className="pn-detail">Every device signed in on this account.</div>
              </div>
              {/* Machines is Cloud's view - the button crosses over when
                  this console sits in Local. */}
              <button type="button" className="pn-btn" onClick={onOpenMachines}>
                Machines
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  )
}
