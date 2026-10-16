// The find strip and the device strip: both sit in the page's flow under
// the bars, so neither covers the page.

import { ArrowsClockwise, CaretDown, CaretUp, DeviceMobile, MagnifyingGlass, X } from '@phosphor-icons/react'
import { DEVICES } from './browser-chrome.js'

export function BrowserFindBar({ find, state, inputRef, onFind, onClose }) {
  return (
    <div className="bw-strip">
      <MagnifyingGlass size={14} className="bw-strip-icon" />
      <input
        ref={inputRef}
        className="bw-find-input"
        value={find.term}
        placeholder="Find in page"
        spellCheck={false}
        onChange={(e) => onFind(e.target.value, 0)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault()
            onFind(find.term, e.shiftKey ? -1 : 1)
          } else if (e.key === 'Escape') {
            e.preventDefault()
            onClose()
          }
        }}
      />
      <span className="bw-find-count">
        {find.term ? (state?.count ? `${state.active} of ${state.count}` : 'No matches') : ''}
      </span>
      <button type="button" className="bw-btn" title="Previous (Shift+Enter)" onClick={() => onFind(find.term, -1)}>
        <CaretUp size={14} />
      </button>
      <button type="button" className="bw-btn" title="Next (Enter)" onClick={() => onFind(find.term, 1)}>
        <CaretDown size={14} />
      </button>
      <button type="button" className="bw-btn" title="Close (Esc)" onClick={onClose}>
        <X size={14} />
      </button>
    </div>
  )
}

export function BrowserDeviceBar({ device, onChange, onClose }) {
  return (
    <div className="bw-strip">
      <DeviceMobile size={14} className="bw-strip-icon" />
      {DEVICES.map((d) => (
        <button
          key={d.name}
          type="button"
          className={`bw-chip${device.name === d.name ? ' on' : ''}`}
          onClick={() => onChange({ ...d })}
        >
          {d.name}
        </button>
      ))}
      <span className="bw-size">
        <input
          type="number"
          value={device.width}
          min={200}
          max={3840}
          aria-label="Width"
          onChange={(e) => onChange({ name: 'Custom', width: Number(e.target.value) || device.width })}
        />
        <span>x</span>
        <input
          type="number"
          value={device.height}
          min={200}
          max={2160}
          aria-label="Height"
          onChange={(e) => onChange({ name: 'Custom', height: Number(e.target.value) || device.height })}
        />
      </span>
      <button
        type="button"
        className="bw-btn"
        title="Rotate"
        onClick={() => onChange({ width: device.height, height: device.width })}
      >
        <ArrowsClockwise size={14} />
      </button>
      <span className="bw-strip-fill" />
      <button type="button" className="bw-btn" title="Leave device view" onClick={onClose}>
        <X size={14} />
      </button>
    </div>
  )
}
