// The new tab page (Chrome's): a search box, up to eight shortcuts - the
// user's own first, then the sites visited most (GET /browser/tiles) -
// and one quiet row of the dev servers seen in chats. A private tab's page
// says what private means instead.

import { useEffect, useState, useSyncExternalStore } from 'react'
import { Detective, DotsThreeVertical, MagnifyingGlass, PencilSimple, Plus, Terminal, Trash, X } from '@phosphor-icons/react'
import ContextMenu from './ContextMenu.jsx'
import { addressKind, bareAddress, engineName, omnibox } from './browser-omnibox.js'
import { hostOf, originOf } from './browser-chrome.js'
import { recentDevServers, subscribeDevServers } from './devservers.js'
import { usePrivacyMode } from './privacy.js'
import './devices.css'
import './panels.css'
import './contextmenu.css'
import './browser-pages.css'

const MAX_TILES = 8

function SearchBox({ engine, onGo }) {
  return (
    <form
      className="bw-ntp-search"
      onSubmit={(e) => {
        e.preventDefault()
        onGo(e.currentTarget.elements.q.value)
      }}
    >
      <MagnifyingGlass size={18} className="bw-ntp-icon" />
      <input name="q" placeholder={`Search ${engineName(engine)} or type a URL`} spellCheck={false} autoComplete="off" />
    </form>
  )
}

function TileIcon({ url, icons }) {
  const icon = icons[originOf(url)]
  if (icon) return <img src={icon} alt="" />
  const letter = (hostOf(url).replace(/^www\./, '') || bareAddress(url) || '?').charAt(0).toUpperCase()
  return <span className="bw-tile-letter">{letter}</span>
}

// Adding or editing a shortcut: its name and address.
function TileDialog({ tile, onSave, onClose }) {
  const [title, setTitle] = useState(tile?.title ?? '')
  const [url, setUrl] = useState(tile?.url ?? '')
  const [error, setError] = useState(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const save = async (e) => {
    e.preventDefault()
    if (addressKind(url) !== 'address') {
      setError('Type an address, like example.com.')
      return
    }
    setBusy(true)
    try {
      await onSave({ title: title.trim(), url: omnibox(url) })
      onClose()
    } catch (err) {
      setError(err?.message ?? String(err))
      setBusy(false)
    }
  }

  return (
    <div
      className="dv-modal-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <form className="dv-modal bw-dialog" role="dialog" aria-modal="true" aria-label={tile ? 'Edit shortcut' : 'Add shortcut'} onSubmit={save}>
        <div className="dv-modal-head">
          <h2 className="dv-modal-title">{tile ? 'Edit shortcut' : 'Add shortcut'}</h2>
          <button type="button" className="dv-modal-close" onClick={onClose} title="Close">
            <X size={14} weight="bold" />
          </button>
        </div>
        <label className="bw-field">
          <span>Name</span>
          <input value={title} onChange={(e) => setTitle(e.target.value)} spellCheck={false} autoFocus />
        </label>
        <label className="bw-field">
          <span>URL</span>
          <input
            value={url}
            onChange={(e) => {
              setUrl(e.target.value)
              setError(null)
            }}
            spellCheck={false}
            placeholder="example.com"
          />
        </label>
        {error && <p className="bw-dialog-error">{error}</p>}
        <div className="ctx-modal-actions">
          <button type="button" className="pn-btn" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button type="submit" className="pn-btn bw-primary" disabled={busy || !url.trim()}>
            Done
          </button>
        </div>
      </form>
    </div>
  )
}

export default function BrowserNewTab({ privateTab, engine, api, icons, chats, act }) {
  const [tiles, setTiles] = useState([])
  const [menu, setMenu] = useState(null)
  const [dialog, setDialog] = useState(null)
  const servers = useSyncExternalStore(subscribeDevServers, recentDevServers, recentDevServers)
  const privacy = usePrivacyMode()

  const load = async () => {
    if (!api?.ready) return
    try {
      const got = await api.call('GET', '/browser/tiles')
      setTiles(Array.isArray(got) ? got.slice(0, MAX_TILES) : [])
    } catch {
      setTiles([])
    }
  }

  useEffect(() => {
    if (!privateTab) load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [privateTab, api])

  const saveTile = async (next) => {
    const before = dialog?.tile
    if (before && before.url !== next.url) await api.call('POST', '/browser/tiles/remove', { url: before.url })
    await api.call('POST', '/browser/tiles', next)
    await load()
  }

  const removeTile = async (tile) => {
    try {
      await api.call('POST', '/browser/tiles/remove', { url: tile.url })
    } finally {
      await load()
    }
  }

  if (privateTab) {
    return (
      <div className="bw-ntp private">
        <Detective size={34} className="bw-ntp-mark" />
        <h1 className="bw-ntp-heading">Private tab</h1>
        <p className="bw-ntp-note">
          Pages you visit here aren't kept in history or brought back next time. Agents can't see this tab unless you
          share it from the site's menu.
        </p>
        <SearchBox engine={engine} onGo={act.go} />
      </div>
    )
  }

  const pinned = tiles.filter((t) => t.pinned).length

  return (
    <div className="bw-ntp">
      <SearchBox engine={engine} onGo={act.go} />
      <div className="bw-tiles">
        {tiles.map((t) => (
          <div className="bw-tile" key={t.url}>
            <button type="button" className="bw-tile-main" title={t.url} onClick={() => act.openUrl(t.url)}>
              <span className="bw-tile-icon">
                <TileIcon url={t.url} icons={icons} />
              </span>
              <span className="bw-tile-title">{t.title || hostOf(t.url) || bareAddress(t.url)}</span>
            </button>
            <button
              type="button"
              className="bw-tile-more"
              title="Edit or remove"
              onClick={(e) => {
                const r = e.currentTarget.getBoundingClientRect()
                setMenu({ tile: t, x: r.left, y: r.bottom + 4 })
              }}
            >
              <DotsThreeVertical size={14} weight="bold" />
            </button>
          </div>
        ))}
        {pinned < MAX_TILES && (
          <div className="bw-tile">
            <button type="button" className="bw-tile-main" onClick={() => setDialog({ tile: null })}>
              <span className="bw-tile-icon">
                <Plus size={18} />
              </span>
              <span className="bw-tile-title">Add shortcut</span>
            </button>
          </div>
        )}
      </div>
      {servers.length > 0 && (
        <div className="bw-ntp-servers">
          <span className="bw-ntp-label">Dev servers in your chats</span>
          {servers.slice(0, 6).map((s) => {
            const chat = chats?.[s.chat]?.title
            return (
              <button
                key={s.url}
                type="button"
                className="bw-chip"
                title={chat && !privacy ? `${s.url}, seen in ${chat}` : s.url}
                onClick={() => act.openUrl(s.url)}
              >
                <Terminal size={12} />
                {bareAddress(s.url)}
              </button>
            )
          })}
        </div>
      )}
      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          onClose={() => setMenu(null)}
          items={[
            { label: 'Edit shortcut', icon: <PencilSimple size={14} />, onSelect: () => setDialog({ tile: menu.tile }) },
            { label: 'Remove', icon: <Trash size={14} />, danger: true, onSelect: () => removeTile(menu.tile) },
          ]}
        />
      )}
      {dialog && <TileDialog tile={dialog.tile} onSave={saveTile} onClose={() => setDialog(null)} />}
    </div>
  )
}
