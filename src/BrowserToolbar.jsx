// The browser's toolbar: back, forward, reload or stop, the address bar,
// then the tools Chrome keeps at the right - picking an element or taking
// a screenshot for the chat, device view, downloads and the menu. A short
// note ("Added to <chat>") and a recording's timer sit before the tools.

import { useEffect, useState } from 'react'
import {
  ArrowClockwise,
  ArrowLeft,
  ArrowRight,
  Camera,
  Crosshair,
  DeviceMobile,
  DotsThreeVertical,
  DownloadSimple,
  X,
} from '@phosphor-icons/react'
import BrowserOmnibox from './BrowserOmnibox.jsx'

// "Recording 0:12 · Stop": the pill is the stop button.
function RecordPill({ rec, onStop }) {
  const [, tick] = useState(0)
  useEffect(() => {
    const timer = setInterval(() => tick((n) => n + 1), 500)
    return () => clearInterval(timer)
  }, [])
  const secs = rec.startedAt ? Math.max(0, Math.floor((Date.now() - rec.startedAt) / 1000)) : 0
  const shown = `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`
  return (
    <button type="button" className="bw-rec" title="Stop recording and save it to Downloads" onClick={onStop}>
      <span className="bw-rec-dot" />
      <span>Recording {shown} · Stop</span>
    </button>
  )
}

export default function BrowserToolbar({
  tab,
  live,
  act,
  hint,
  engine,
  bookmarked,
  picking,
  rec,
  notice,
  busy,
  device,
  omni,
  api,
  icons,
  precapture,
}) {
  return (
    <div className="bw-bar" onPointerEnter={precapture}>
      <button type="button" className="bw-btn" title={hint('Back', 'browser-back')} disabled={!tab?.canBack} onClick={act.back}>
        <ArrowLeft size={16} />
      </button>
      <button
        type="button"
        className="bw-btn"
        title={hint('Forward', 'browser-forward')}
        disabled={!tab?.canForward}
        onClick={act.forward}
      >
        <ArrowRight size={16} />
      </button>
      {tab?.loading && live ? (
        <button type="button" className="bw-btn" title="Stop loading" onClick={act.stop}>
          <X size={16} />
        </button>
      ) : (
        <button type="button" className="bw-btn" title={hint('Reload', 'browser-reload')} disabled={!live} onClick={act.reload}>
          <ArrowClockwise size={16} />
        </button>
      )}
      <BrowserOmnibox
        tab={tab}
        live={live}
        engine={engine}
        bookmarked={bookmarked}
        api={api}
        icons={icons}
        handle={omni}
        act={act}
        hint={hint}
      />
      {notice && (
        <span className={`bw-notice${notice.kind === 'error' ? ' error' : ''}`} role="status">
          {notice.text}
        </span>
      )}
      {rec && <RecordPill rec={rec} onStop={act.stopRecord} />}
      <button
        type="button"
        className={`bw-btn${picking ? ' on' : ''}`}
        title={picking ? 'Stop selecting' : 'Select an element to add to the chat'}
        aria-pressed={picking}
        disabled={!live}
        onClick={act.pick}
      >
        <Crosshair size={17} />
      </button>
      <button type="button" className="bw-btn" title="Screenshot to chat" disabled={!live} onClick={act.shot}>
        <Camera size={17} />
      </button>
      <button type="button" className={`bw-btn${device ? ' on' : ''}`} title="Device view" disabled={!live} onClick={act.toggleDevice}>
        <DeviceMobile size={17} />
      </button>
      <button
        type="button"
        className={`bw-btn${busy ? ' busy' : ''}`}
        data-bw-anchor="downloads"
        title={hint('Downloads', 'browser-downloads')}
        onClick={(e) => act.menu('downloads', e.currentTarget)}
      >
        <DownloadSimple size={17} />
      </button>
      <button type="button" className="bw-btn" data-bw-anchor="main" title="More" onClick={(e) => act.menu('main', e.currentTarget)}>
        <DotsThreeVertical size={18} weight="bold" />
      </button>
    </div>
  )
}
