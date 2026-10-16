// The browser's info bars, in the page's flow between the bars and the
// page (so nothing floats over the page): a site asking for a permission,
// a chat's agent using the tab (and the user's hand on it), and the
// element picker at work.

import { useState } from 'react'
import { Bell, Camera, ClipboardText, Crosshair, Info, MapPin, Microphone, MusicNotes } from '@phosphor-icons/react'
import { hostOf, permissionAsk } from './browser-chrome.js'
import './panels.css'

const KIND_ICONS = {
  camera: Camera,
  microphone: Microphone,
  geolocation: MapPin,
  notifications: Bell,
  'clipboard-read': ClipboardText,
  midi: MusicNotes,
}

// "<host> wants to use your camera": Allow, Block, and whether to remember
// the answer for the site (never offered in a private tab, which keeps
// nothing).
export function PermissionBar({ prompt, onAnswer }) {
  const [remember, setRemember] = useState(false)
  const Icon = KIND_ICONS[prompt.kind] ?? Info
  const host = hostOf(prompt.origin) || prompt.origin || 'This site'
  return (
    <div className="bw-info" role="alert">
      <Icon size={15} className="bw-info-icon" />
      <span className="bw-info-text">
        <strong>{host}</strong> wants to {permissionAsk(prompt.kind, prompt.label)}
      </span>
      {!prompt.private && (
        <label className="bw-check">
          <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} />
          Remember for this site
        </label>
      )}
      <button type="button" className="pn-btn" onClick={() => onAnswer(false, remember)}>
        Block
      </button>
      <button type="button" className="pn-btn bw-primary" onClick={() => onAnswer(true, remember)}>
        Allow
      </button>
    </div>
  )
}

// A chat's agent in this tab: what it is doing, and the user's hand.
// "Take over" pauses the agent's actions here (it can still read the
// page); "Hand back" lets it go on; "Stop sharing" ends its hold.
export function AgentBar({ controller, onControl }) {
  const paused = controller.kind === 'paused'
  const name = controller.title || 'A chat'
  return (
    <div className="bw-info" role="status">
      <span className={`bw-agent-dot${paused ? '' : ' live'}`} />
      <span className="bw-info-text">
        {paused ? (
          <>
            You took over from <strong className="pv">{name}</strong>
          </>
        ) : (
          <>
            <strong className="pv">{name}</strong> is using this tab
          </>
        )}
      </span>
      {paused ? (
        <>
          <button type="button" className="pn-btn" onClick={() => onControl('release')}>
            Stop sharing
          </button>
          <button type="button" className="pn-btn bw-primary" onClick={() => onControl('hand_back')}>
            Hand back
          </button>
        </>
      ) : (
        <button type="button" className="pn-btn bw-primary" onClick={() => onControl('take_over')}>
          Take over
        </button>
      )}
    </div>
  )
}

// The element picker is on: the next click on the page picks.
export function PickBar({ onCancel }) {
  return (
    <div className="bw-info" role="status">
      <Crosshair size={15} className="bw-info-icon" />
      <span className="bw-info-text">Click anything on the page to add it to the chat.</span>
      <button type="button" className="pn-btn" onClick={onCancel}>
        Cancel
      </button>
    </div>
  )
}
