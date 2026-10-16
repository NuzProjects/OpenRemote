// The browser's own pages, drawn by the console in the page's place (no
// webview): openremote://history, openremote://downloads and
// openremote://bookmarks. Each reads and writes through the daemon's
// browser routes.

import { useEffect, useState } from 'react'
import {
  ArrowClockwise,
  ArrowSquareOut,
  DotsSixVertical,
  DotsThreeVertical,
  DownloadSimple,
  FolderOpen,
  MagnifyingGlass,
  PencilSimple,
  Plus,
  Trash,
  Warning,
  X,
  ArrowDown,
  ArrowUp,
  FolderSimple,
} from '@phosphor-icons/react'
import ContextMenu from './ContextMenu.jsx'
import BrowserClearData from './BrowserClearData.jsx'
import { MarkIcon } from './BrowserBookmarksBar.jsx'
import { bareAddress } from './browser-omnibox.js'
import { fileName, hostOf, viewable } from './browser-chrome.js'
import { groupByDay, timeLabel } from './browser-history.js'
import { FOLDERS, inFolder, positionAt, stepPosition } from './browser-bookmarks.js'
import { removeBookmark, saveBookmark } from './browser-data.js'
import { usePrivacyMode } from './privacy.js'
import './panels.css'
import './contextmenu.css'
import './browser-pages.css'

// How many visits one page of history holds.
const HISTORY_PAGE = 100

function PageHead({ title, children }) {
  return (
    <div className="bwp-head">
      <h1 className="bwp-title">{title}</h1>
      <div className="bwp-head-tools">{children}</div>
    </div>
  )
}

function Search({ value, onChange, placeholder }) {
  return (
    <label className="bwp-search">
      <MagnifyingGlass size={14} />
      <input value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} spellCheck={false} />
      {value && (
        <button type="button" className="bwp-icon" title="Clear" onClick={() => onChange('')}>
          <X size={12} />
        </button>
      )}
    </label>
  )
}

// ---- history ----

function HistoryPage({ api, icons, act }) {
  // Privacy mode blurs the list; a tooltip would show an address plainly.
  const privacy = usePrivacyMode()
  const [q, setQ] = useState('')
  const [visits, setVisits] = useState([])
  const [more, setMore] = useState(false)
  const [loaded, setLoaded] = useState(false)
  const [selected, setSelected] = useState(() => new Set())
  const [clearing, setClearing] = useState(false)
  const [nonce, setNonce] = useState(0)

  const fetchPage = async (before) => {
    const params = new URLSearchParams({ q: q.trim(), limit: String(HISTORY_PAGE) })
    if (before != null) params.set('before', String(before))
    const got = await api.call('GET', `/browser/history?${params}`)
    return Array.isArray(got) ? got : []
  }

  useEffect(() => {
    if (!api?.ready) return undefined
    let cancelled = false
    const timer = setTimeout(
      async () => {
        try {
          const got = await fetchPage(null)
          if (cancelled) return
          setVisits(got)
          setMore(got.length === HISTORY_PAGE)
          setSelected(new Set())
        } catch {
          if (!cancelled) setVisits([])
        } finally {
          if (!cancelled) setLoaded(true)
        }
      },
      q ? 150 : 0,
    )
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q, api, nonce])

  const showMore = async () => {
    const last = visits[visits.length - 1]
    if (!last) return
    try {
      const got = await fetchPage(last.at)
      const known = new Set(visits.map((v) => v.id))
      setVisits((list) => [...list, ...got.filter((v) => !known.has(v.id))])
      setMore(got.length === HISTORY_PAGE)
    } catch {
      setMore(false)
    }
  }

  const remove = async (ids) => {
    if (!ids.length) return
    const doomed = new Set(ids)
    setVisits((list) => list.filter((v) => !doomed.has(v.id)))
    setSelected((s) => new Set([...s].filter((id) => !doomed.has(id))))
    try {
      await api.call('POST', '/browser/history/remove', { ids })
    } catch {
      setNonce((n) => n + 1)
    }
  }

  const toggle = (id) =>
    setSelected((s) => {
      const next = new Set(s)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })

  const groups = groupByDay(visits)

  return (
    <div className="bwp">
      <div className="bwp-inner">
        <PageHead title="History">
          <Search value={q} onChange={setQ} placeholder="Search history" />
          <button type="button" className="pn-btn" onClick={() => setClearing(true)}>
            Clear browsing data
          </button>
        </PageHead>
        {selected.size > 0 && (
          <div className="bwp-selbar">
            <span>{selected.size} selected</span>
            <span className="bwp-fill" />
            <button type="button" className="pn-btn" onClick={() => setSelected(new Set())}>
              Cancel
            </button>
            <button type="button" className="pn-btn pn-btn--danger" onClick={() => remove([...selected])}>
              Remove
            </button>
          </div>
        )}
        {loaded && !visits.length && (
          <p className="bwp-empty">{q ? 'No pages in your history match.' : 'Pages you visit show here.'}</p>
        )}
        {groups.map((g) => (
          <section key={g.key} className="bwp-group">
            <h2 className="bwp-day">{g.label}</h2>
            <div className="bwp-card">
              {g.visits.map((v) => (
                <div key={v.id} className={`bwp-row${selected.has(v.id) ? ' on' : ''}`}>
                  <input
                    type="checkbox"
                    className="bwp-check"
                    checked={selected.has(v.id)}
                    onChange={() => toggle(v.id)}
                    aria-label={`Select ${v.title || v.url}`}
                  />
                  <span className="bwp-time">{timeLabel(v.at)}</span>
                  <MarkIcon url={v.url} icons={icons} />
                  <button
                    type="button"
                    className="bwp-link pv"
                    title={privacy ? undefined : v.url}
                    onMouseDown={(e) => {
                      if (e.button === 1) e.preventDefault()
                    }}
                    onClick={(e) => act.openUrl(v.url, { newTab: e.ctrlKey || e.metaKey })}
                    onAuxClick={(e) => {
                      if (e.button === 1) act.openUrl(v.url, { newTab: true })
                    }}
                  >
                    {v.title || bareAddress(v.url)}
                  </button>
                  <span className="bwp-host pv">{hostOf(v.url)}</span>
                  <button type="button" className="bwp-icon" title="Remove from history" onClick={() => remove([v.id])}>
                    <X size={12} />
                  </button>
                </div>
              ))}
            </div>
          </section>
        ))}
        {more && (
          <button type="button" className="pn-btn bwp-more" onClick={showMore}>
            Show more
          </button>
        )}
      </div>
      {clearing && <BrowserClearData api={api} onClose={() => setClearing(false)} onCleared={() => setNonce((n) => n + 1)} />}
    </div>
  )
}

// ---- downloads ----

function DownloadsPage({ downloads, act }) {
  const done = downloads.some((d) => d.state !== 'started')
  return (
    <div className="bwp">
      <div className="bwp-inner">
        <PageHead title="Downloads">
          {done && (
            <button type="button" className="pn-btn" onClick={() => act.clearDownloads()}>
              Clear all
            </button>
          )}
        </PageHead>
        {!downloads.length && <p className="bwp-empty">Files you download show here. They're saved to your Downloads folder.</p>}
        {downloads.length > 0 && (
          <div className="bwp-card">
            {downloads.map((d) => {
              const name = fileName(d.path ?? d.url)
              return (
                <div key={String(d.id)} className="bwp-row bwp-download">
                  {d.state === 'failed' ? (
                    <Warning size={16} className="bwp-file-icon" />
                  ) : (
                    <DownloadSimple size={16} className="bwp-file-icon" />
                  )}
                  <div className="bwp-file">
                    <span className="bwp-file-name pv">{name}</span>
                    <span className="bwp-file-sub">
                      {d.state === 'started'
                        ? 'Downloading'
                        : d.state === 'failed'
                          ? 'Failed'
                          : d.state === 'cancelled'
                            ? 'Cancelled'
                            : hostOf(d.url) || 'Saved to Downloads'}
                    </span>
                  </div>
                  <div className="bwp-actions">
                    {d.state === 'done' && d.path && viewable(d.path) && (
                      <button type="button" className="pn-btn" onClick={() => act.openFile(d.path)}>
                        <ArrowSquareOut size={13} />
                        Open
                      </button>
                    )}
                    {d.state === 'done' && d.path && (
                      <button type="button" className="pn-btn" onClick={() => act.reveal(d.path)}>
                        <FolderOpen size={13} />
                        Show in folder
                      </button>
                    )}
                    {(d.state === 'failed' || d.state === 'cancelled') && d.url && (
                      <button type="button" className="pn-btn" onClick={() => act.retry(d)}>
                        <ArrowClockwise size={13} />
                        Retry
                      </button>
                    )}
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}

// ---- bookmarks ----

function BookmarkRow({ mark, renaming, dropBefore, dragging, icons, act, onRename, onMenu, onKey, drag }) {
  const privacy = usePrivacyMode()
  const [title, setTitle] = useState(mark.title ?? '')
  useEffect(() => setTitle(mark.title ?? ''), [mark.title, renaming])
  return (
    <div
      className={`bwp-row bwp-mark${dropBefore ? ' drop' : ''}${dragging ? ' dragging' : ''}`}
      tabIndex={0}
      draggable={!renaming && drag.enabled}
      onDragStart={(e) => drag.start(e, mark)}
      onDragEnd={drag.end}
      onDragOver={(e) => drag.over(e, mark)}
      onDrop={drag.drop}
      onKeyDown={(e) => onKey(e, mark)}
      aria-label={privacy ? 'Bookmark' : mark.title || mark.url}
    >
      {drag.enabled && <DotsSixVertical size={14} className="bwp-grip" aria-hidden="true" />}
      <MarkIcon url={mark.url} icons={icons} />
      {renaming ? (
        <input
          className="bwp-rename"
          value={title}
          autoFocus
          spellCheck={false}
          onFocus={(e) => e.target.select()}
          onChange={(e) => setTitle(e.target.value)}
          onBlur={() => onRename(mark, title)}
          onKeyDown={(e) => {
            e.stopPropagation()
            if (e.key === 'Enter') onRename(mark, title)
            else if (e.key === 'Escape') onRename(mark, null)
          }}
        />
      ) : (
        <button
          type="button"
          className="bwp-link pv"
          title={privacy ? undefined : mark.url}
          onMouseDown={(e) => {
            if (e.button === 1) e.preventDefault()
          }}
          onClick={(e) => act.openUrl(mark.url, { newTab: e.ctrlKey || e.metaKey })}
          onAuxClick={(e) => {
            if (e.button === 1) act.openUrl(mark.url, { newTab: true })
          }}
        >
          {mark.title || bareAddress(mark.url)}
        </button>
      )}
      <span className="bwp-host pv">{bareAddress(mark.url)}</span>
      <button type="button" className="bwp-icon" title="More" onClick={(e) => onMenu(e, mark)}>
        <DotsThreeVertical size={14} weight="bold" />
      </button>
    </div>
  )
}

function BookmarksPage({ api, marks, icons, act }) {
  const [q, setQ] = useState('')
  const [renaming, setRenaming] = useState(null)
  const [menu, setMenu] = useState(null)
  const [dragId, setDragId] = useState(null)
  const [over, setOver] = useState(null)
  const filter = q.trim().toLowerCase()
  const shown = (folder) =>
    inFolder(marks, folder).filter(
      (m) => !filter || (m.title ?? '').toLowerCase().includes(filter) || m.url.toLowerCase().includes(filter),
    )

  // A bookmark's new place: `index` counts the folder as it shows now,
  // the moving bookmark included.
  const moveTo = (mark, folder, index) => {
    const full = inFolder(marks, folder)
    const from = full.findIndex((m) => m.id === mark.id)
    const to = from !== -1 && from < index ? index - 1 : index
    const rest = full.filter((m) => m.id !== mark.id)
    saveBookmark(api, { ...mark, folder, position: positionAt(rest, to) })
  }

  const step = (mark, dir) => {
    const position = stepPosition(marks, mark, dir)
    if (position != null) saveBookmark(api, { ...mark, position })
  }

  const otherFolder = (mark) => (mark.folder === 'other' ? 'bar' : 'other')

  const rename = (mark, title) => {
    setRenaming(null)
    if (title == null) return
    const clean = title.trim()
    if (clean && clean !== mark.title) saveBookmark(api, { ...mark, title: clean })
  }

  const onKey = (e, mark) => {
    if (e.target !== e.currentTarget) return
    if (e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
      e.preventDefault()
      step(mark, e.key === 'ArrowUp' ? -1 : 1)
    } else if (e.key === 'F2') {
      e.preventDefault()
      setRenaming(mark.id)
    } else if (e.key === 'Delete') {
      e.preventDefault()
      removeBookmark(api, mark.id)
    } else if (e.key === 'Enter') {
      e.preventDefault()
      act.openUrl(mark.url)
    }
  }

  const drag = (folder) => ({
    enabled: !filter,
    start: (e, mark) => {
      e.dataTransfer.effectAllowed = 'move'
      e.dataTransfer.setData('text/plain', mark.url)
      setDragId(mark.id)
    },
    end: () => {
      setDragId(null)
      setOver(null)
    },
    over: (e, mark) => {
      if (!dragId) return
      e.preventDefault()
      e.stopPropagation()
      const list = inFolder(marks, folder)
      const r = e.currentTarget.getBoundingClientRect()
      const at = list.findIndex((m) => m.id === mark.id)
      const index = e.clientY > r.top + r.height / 2 ? at + 1 : at
      if (over?.folder !== folder || over?.index !== index) setOver({ folder, index })
    },
    drop: (e) => {
      e.preventDefault()
      e.stopPropagation()
      const mark = marks.find((m) => m.id === dragId)
      if (mark && over) moveTo(mark, over.folder, over.index)
      setDragId(null)
      setOver(null)
    },
  })

  const menuItems = (mark) => {
    const list = inFolder(marks, mark.folder === 'other' ? 'other' : 'bar')
    const at = list.findIndex((m) => m.id === mark.id)
    return [
      { label: 'Open in new tab', icon: <Plus size={14} />, onSelect: () => act.openUrl(mark.url, { newTab: true }) },
      { label: 'Rename', icon: <PencilSimple size={14} />, hint: 'F2', onSelect: () => setRenaming(mark.id) },
      { divider: true },
      { label: 'Move up', icon: <ArrowUp size={14} />, hint: 'Alt+↑', disabled: at <= 0, onSelect: () => step(mark, -1) },
      { label: 'Move down', icon: <ArrowDown size={14} />, hint: 'Alt+↓', disabled: at === list.length - 1, onSelect: () => step(mark, 1) },
      {
        label: `Move to ${FOLDERS[otherFolder(mark)]}`,
        icon: <FolderSimple size={14} />,
        onSelect: () => moveTo(mark, otherFolder(mark), inFolder(marks, otherFolder(mark)).length),
      },
      { divider: true },
      { label: 'Delete', icon: <Trash size={14} />, hint: 'Del', danger: true, onSelect: () => removeBookmark(api, mark.id) },
    ]
  }

  return (
    <div className="bwp">
      <div className="bwp-inner">
        <PageHead title="Bookmarks">
          <Search value={q} onChange={setQ} placeholder="Search bookmarks" />
        </PageHead>
        <p className="bwp-lead">Drag to reorder, or focus a bookmark and use Alt+↑ and Alt+↓. F2 renames, Delete removes.</p>
        {Object.entries(FOLDERS).map(([folder, label]) => {
          const list = shown(folder)
          const handlers = drag(folder)
          const all = inFolder(marks, folder)
          return (
            <section key={folder} className="bwp-group">
              <h2 className="bwp-day">{label}</h2>
              <div
                className={`bwp-card${over?.folder === folder && over.index >= all.length ? ' drop-end' : ''}`}
                onDragOver={(e) => {
                  if (!dragId) return
                  e.preventDefault()
                  // Past the last row, or anywhere in an empty folder: the end.
                  if ((!all.length || e.target === e.currentTarget) && (over?.folder !== folder || over?.index !== all.length)) {
                    setOver({ folder, index: all.length })
                  }
                }}
                onDrop={handlers.drop}
              >
                {list.map((m) => (
                  <BookmarkRow
                    key={m.id}
                    mark={m}
                    renaming={renaming === m.id}
                    dropBefore={over?.folder === folder && all[over.index]?.id === m.id && dragId !== m.id}
                    dragging={dragId === m.id}
                    icons={icons}
                    act={act}
                    drag={handlers}
                    onRename={rename}
                    onKey={onKey}
                    onMenu={(e, mark) => {
                      const r = e.currentTarget.getBoundingClientRect()
                      setMenu({ mark, x: r.left, y: r.bottom + 4 })
                    }}
                  />
                ))}
                {!list.length && (
                  <p className="bwp-empty bwp-empty--card">
                    {filter ? 'None match.' : folder === 'bar' ? 'Bookmarks you add with the star land here.' : 'Nothing here yet.'}
                  </p>
                )}
              </div>
            </section>
          )
        })}
      </div>
      {menu && <ContextMenu x={menu.x} y={menu.y} items={menuItems(menu.mark)} onClose={() => setMenu(null)} />}
    </div>
  )
}

export default function BrowserPages({ page, ...props }) {
  if (page === 'history') return <HistoryPage {...props} />
  if (page === 'downloads') return <DownloadsPage {...props} />
  if (page === 'bookmarks') return <BookmarksPage {...props} />
  return null
}
