// The bookmarks bar under the toolbar (Chrome's): the bar folder's
// bookmarks left to right, the ones that don't fit behind a » menu, and
// Other bookmarks at the right end. A click opens a bookmark here, a
// middle or Ctrl+click in a new tab; right-click has its menu.

import { useLayoutEffect, useRef, useState } from 'react'
import { CaretDoubleRight, FolderSimple, Globe } from '@phosphor-icons/react'
import { inFolder } from './browser-bookmarks.js'
import { bareAddress } from './browser-omnibox.js'
import { originOf } from './browser-chrome.js'

export function MarkIcon({ url, icons, size = 14 }) {
  const icon = icons[originOf(url)]
  return icon ? <img className="bw-favicon" src={icon} alt="" /> : <Globe size={size} className="bw-tab-icon" />
}

export default function BrowserBookmarksBar({ marks, icons, act }) {
  const bar = inFolder(marks, 'bar')
  const other = inFolder(marks, 'other')
  const listRef = useRef(null)
  // How many of the bar's bookmarks fit; the rest are in the » menu.
  const [fit, setFit] = useState(bar.length)

  useLayoutEffect(() => {
    const el = listRef.current
    if (!el) return undefined
    const measure = () => {
      let n = 0
      for (const child of el.children) {
        if (child.offsetLeft + child.offsetWidth > el.clientWidth + 0.5) break
        n += 1
      }
      setFit(n)
    }
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [marks])

  return (
    <div className="bw-marks" aria-label="Bookmarks bar">
      <div className="bw-marks-list" ref={listRef}>
        {bar.map((m, i) => (
          <button
            key={m.id}
            type="button"
            className="bw-mark"
            style={i >= fit ? { visibility: 'hidden' } : undefined}
            tabIndex={i >= fit ? -1 : 0}
            title={`${m.title || bareAddress(m.url)}\n${m.url}`}
            onMouseDown={(e) => {
              // A middle click opens a tab, never the page's autoscroll.
              if (e.button === 1) e.preventDefault()
            }}
            onClick={(e) => act.openUrl(m.url, { newTab: e.ctrlKey || e.metaKey })}
            onAuxClick={(e) => {
              if (e.button === 1) act.openUrl(m.url, { newTab: true })
            }}
            onContextMenu={(e) => {
              e.preventDefault()
              e.stopPropagation()
              act.markMenu(m, e.clientX, e.clientY)
            }}
          >
            <MarkIcon url={m.url} icons={icons} />
            <span className="bw-mark-title">{m.title || bareAddress(m.url)}</span>
          </button>
        ))}
        {!bar.length && <span className="bw-marks-empty">Bookmark a page with the star to keep it here.</span>}
      </div>
      {fit < bar.length && (
        <button
          type="button"
          className="bw-btn bw-marks-more"
          title="More bookmarks"
          onClick={(e) => act.menu('overflow', e.currentTarget, { marks: bar.slice(fit) })}
        >
          <CaretDoubleRight size={14} />
        </button>
      )}
      {other.length > 0 && (
        <button type="button" className="bw-mark bw-mark-folder" onClick={(e) => act.menu('other', e.currentTarget)}>
          <FolderSimple size={14} className="bw-tab-icon" />
          <span className="bw-mark-title">Other bookmarks</span>
        </button>
      )}
    </div>
  )
}
