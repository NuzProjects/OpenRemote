// Mobile: the phone companion page. A phone drives the account's chats -
// it runs none itself - so this is where the phones are: what signing in
// on one gets you, and the phones already in the Cloud, each opening the
// same device detail every other device gets.
//
// Pairing by QR code sits above all of that and depends on none of it: a
// phone scans a code from this computer, on this network, with no account.

import { useState } from 'react'
import { DeviceMobile } from '@phosphor-icons/react'
import MachineModal from './MachineModal.jsx'
import CloudStateRow from './CloudStateRow.jsx'
import PairingSection from './PairingSection.jsx'
import { useConsole } from './state/console.jsx'
import { usePrivacyMode } from './privacy.js'
import { isPhone, platformLabel, selfLabel, signedIn } from './cloud.js'
import './devices.css'
import './panels.css'

function detail(device) {
  return [platformLabel(device.platform), device.app_version].filter(Boolean).join(' · ')
}

export default function MobileView({ onOpenChat }) {
  const privacy = usePrivacyMode()
  const { devices, thisDevice, cloud } = useConsole()
  const [openId, setOpenId] = useState(null)
  const inCloud = signedIn(cloud)
  const phones = (devices ?? []).filter(isPhone)
  const open = phones.find((d) => d.id === openId) ?? null

  return (
    <div className="devices">
      <header className="dv-head">
        <div>
          <h1 className="dv-title">Mobile</h1>
          <p className="dv-meta">
            {inCloud
              ? `${phones.length} ${phones.length === 1 ? 'phone' : 'phones'} in your Cloud`
              : 'OpenRemote on your phone'}
          </p>
        </div>
      </header>

      <p className="pn-lead">
        Install OpenRemote on a phone and sign in with the same moreweb account. Synced chats appear
        there, and from a phone a new chat can run on one of your machines.
      </p>

      <PairingSection />

      {!inCloud ? (
        <div className="pn-list pn-list--tight">
          <CloudStateRow one="phone" />
        </div>
      ) : (
        <>
          <div className="dv-grid">
            {phones.map((device) => (
              <button
                key={device.id}
                className="dv-card"
                onClick={() => setOpenId(device.id)}
                title={privacy ? undefined : device.name}
              >
                <span className="dv-icon">
                  <DeviceMobile size={19} weight="light" />
                </span>
                <span className="dv-name">
                  <span className="pv">{device.name}</span>
                  {device.id === thisDevice && <span className="dv-badge">{selfLabel(device)}</span>}
                </span>
                <span className="dv-detail">{detail(device)}</span>
                <span className="dv-status">
                  <span className={`dv-dot dv-dot--${device.online ? 'online' : 'offline'}`} />
                  {device.online ? 'Online' : 'Offline'}
                </span>
              </button>
            ))}
          </div>
          {phones.length === 0 && (
            <p className="pn-empty">No phones yet. The first one to sign in shows up here.</p>
          )}
        </>
      )}

      {open && (
        <MachineModal device={open} onOpenChat={onOpenChat} onClose={() => setOpenId(null)} />
      )}
    </div>
  )
}
