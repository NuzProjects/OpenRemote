import { useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  Archive,
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  CaretDown,
  ChartBar,
  ChatCircle,
  Cloud,
  Copy,
  Desktop,
  DeviceMobile,
  GearSix,
  Globe,
  House,
  Lightning,
  MagnifyingGlass,
  Plus,
  PuzzlePiece,
  TrashSimple,
  UserCircle,
  X,
} from '@phosphor-icons/react'
import { useConsole } from './state/console.jsx'
import { sections } from './projects.js'
import { activeSessions } from './archive.js'
import { deviceName, isPhone, sessionsForMode } from './cloud.js'
import { isMobile } from './platform.js'
import { HarnessMark } from './brand-marks.jsx'
import ContextMenu from './ContextMenu.jsx'
import DeleteChatModal from './DeleteChatModal.jsx'
import { usePrivacyMode } from './privacy.js'
import { useHint, useShortcut } from './keyboard.jsx'
import { usePlugins } from './plugins-host.jsx'
import { PluginIcon } from './plugin-icons.jsx'
import { useMoveChat } from './useMoveChat.jsx'
import { useChatDrag } from './useChatDrag.js'
import { wouldMove } from './move-chat.js'
import { rolledStatus } from './team.js'
import './sidebar.css'
import './move.css'
import './team.css'

export default function Sidebar({ open, active, mode, onMode, onSelect, onSplit, onAddProject, onNewChatIn, onReveal }) {
  const { connection, sessions, chats, devices, thisDevice, projects, removeProject, archived, setChatArchived, deleteChat } = useConsole()
  const privacy = usePrivacyMode()
  // The views enabled plugins add: the Plugins group's tiles.
  const pluginViews = usePlugins()?.views ?? []
  const [query, setQuery] = useState('')
  const [collapsed, setCollapsed] = useState({})
  const [menu, setMenu] = useState(null)
  const [deleting, setDeleting] = useState(null)
  // The leads whose workers are folded away (open by default).
  const [folded, setFolded] = useState({})

  // Local: everything that runs on this computer. Cloud: every synced chat,
  // named by the device it runs on when that isn't this one.
  const rows = useMemo(() => {
    return sessionsForMode(activeSessions(sessions, archived), mode, thisDevice).map((session) => {
      const elsewhere = session.executor && session.executor !== thisDevice
      const device = elsewhere ? (devices ?? []).find((d) => d.id === session.executor) : null
      return {
        id: session.id,
        title: chats[session.id]?.title ?? session.title ?? 'A new task',
        status: chats[session.id]?.status ?? 'idle',
        harness: session.harness,
        workspace: session.workspace ?? null,
        updatedAt: session.updated_at ?? 0,
        device: elsewhere ? deviceName(devices, session.executor) : null,
        executor: session.executor ?? null,
        // A copy's last status is stale while its device is away.
        offline: elsewhere && !device?.online,
        synced: Boolean(session.executor),
        // The chat that started this one, when its agent did.
        parent: session.parent?.chat ?? null,
        spawnedAt: session.parent?.spawned_at ?? 0,
      }
    })
  }, [sessions, archived, chats, mode, devices, thisDevice])

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase()
    const sorted = [...rows].sort((a, b) => b.updatedAt - a.updatedAt)
    if (!q) return sorted
    return sorted.filter((c) => c.title.toLowerCase().includes(q))
  }, [rows, query])

  // A worker nests under the chat that started it, when that chat is on
  // the list: the lists below hold the chats that stand on their own, and
  // each lead carries its workers (oldest first). A worker whose lead is
  // archived, filtered out or gone stands on its own.
  const nest = useMemo(() => {
    const here = new Set(visible.map((r) => r.id))
    const kids = new Map()
    const top = []
    for (const row of visible) {
      if (row.parent && row.parent !== row.id && here.has(row.parent)) {
        const list = kids.get(row.parent) ?? []
        list.push(row)
        kids.set(row.parent, list)
      } else {
        top.push(row)
      }
    }
    for (const list of kids.values()) list.sort((a, b) => a.spawnedAt - b.spawnedAt)
    return { top, kids }
  }, [visible])

  // The two sections: registered projects with their chats, then the flat
  // Chats list - every chat that belongs to no project.
  const grouped = useMemo(() => sections(projects, nest.top), [projects, nest.top])

  // What a lead's dot says of everything under it as well as itself:
  // waiting beats failed beats running.
  const rolled = (row) =>
    rolledStatus(
      row.status,
      (nest.kids.get(row.id) ?? []).map((kid) => rolled(kid)),
    )

  const toggleProject = (id) => {
    setCollapsed((c) => ({ ...c, [id]: !c[id] }))
  }

  // Moving chats between projects: from a chat's menu, or by dragging a
  // chat that runs on this computer onto one of its projects (or onto
  // Chats, for none). A phone has the menu only.
  const move = useMoveChat()
  const listRef = useRef(null)
  const projectById = (id) => (projects ?? []).find((p) => p.id === id) ?? null
  const targetOf = (target) => (target === '' ? null : projectById(target))
  const { drag, label, start } = useChatDrag({
    scroller: listRef,
    accepts: (row, target) =>
      (target === '' || projectById(target) != null) &&
      wouldMove(projects, row.workspace, targetOf(target)),
    onDrop: (row, target) => move.moveTo(row, targetOf(target)),
  })
  // While a chat is dragged, the projects with no chats yet show too, so
  // a drop can give one its first chat.
  const shownProjects = drag
    ? [
        ...grouped.projects,
        ...(projects ?? [])
          .filter((p) => !grouped.projects.some((g) => g.project.id === p.id))
          .map((project) => ({ project, items: [] })),
      ]
    : grouped.projects

  // The keyboard's walk through the list goes in the order it reads:
  // each open project's chats, then the flat Chats list. A collapsed
  // project's chats are skipped, like the eye skips them.
  const searchRef = useRef(null)
  const walk = (row) => [
    row.id,
    ...(folded[row.id] ? [] : (nest.kids.get(row.id) ?? []).flatMap(walk)),
  ]
  const order = [
    ...grouped.projects.flatMap(({ project, items }) =>
      collapsed[project.id] ? [] : items.flatMap(walk),
    ),
    ...grouped.flat.flatMap(walk),
  ]
  const step = (pick) => () => {
    if (!order.length) return false
    const at = order.indexOf(active)
    onSelect(pick(at))
  }
  useShortcut('next-chat', step((at) => order[at === -1 ? 0 : Math.min(at + 1, order.length - 1)]))
  useShortcut('prev-chat', step((at) => order[at === -1 ? order.length - 1 : Math.max(at - 1, 0)]))
  useShortcut('first-chat', step(() => order[0]))
  useShortcut('last-chat', step(() => order[order.length - 1]))
  useShortcut('search-chats', () => {
    if (!open) onReveal?.()
    // After the reveal renders, so the field is there to take focus.
    requestAnimationFrame(() => {
      searchRef.current?.focus()
      searchRef.current?.select()
    })
  })
  const hintNew = useHint('new-chat')
  const hintSearch = useHint('search-chats')

  // A lead with workers asks what becomes of them first: the list lets go
  // of the chat only once it is archived.
  const archive = (id) => {
    Promise.resolve(setChatArchived(id, true)).then((done) => {
      if (done !== false && id === active) onSelect('new')
    })
  }

  // Right-click on a chat: the same actions as the hover buttons, plus the
  // split directions.
  const menuItems = (row) => {
    const split = (dir, before) => () => onSplit(row.id, dir, before)
    const canSplit = onSplit && !isMobile
    return [
      { label: 'Open', icon: <ChatCircle size={14} />, onSelect: () => onSelect(row.id) },
      ...(canSplit
        ? [
            { divider: true },
            { header: 'Open in a new split' },
            { label: 'To the left', icon: <ArrowLeft size={14} />, onSelect: split('row', true) },
            { label: 'To the right', icon: <ArrowRight size={14} />, onSelect: split('row', false) },
            { label: 'Above', icon: <ArrowUp size={14} />, onSelect: split('col', true) },
            { label: 'Below', icon: <ArrowDown size={14} />, onSelect: split('col', false) },
          ]
        : []),
      { divider: true },
      move.menuItem(row),
      { label: 'Archive', icon: <Archive size={14} />, onSelect: () => archive(row.id) },
      // The daemon deletes synced chats only (it removes them from every
      // device); a private chat has no delete.
      ...(row.synced
        ? [
            {
              label: 'Delete chat',
              icon: <TrashSimple size={14} />,
              danger: true,
              onSelect: () => setDeleting(row),
            },
          ]
        : []),
      {
        label: 'Copy title',
        icon: <Copy size={14} />,
        onSelect: () => navigator.clipboard?.writeText(row.title).catch(() => {}),
      },
    ]
  }

  // Right-click on a plugin's tile: open it, or open it in a new split.
  const viewMenuItems = (item) => {
    const split = (dir, before) => () => onSplit(item.key, dir, before)
    return [
      { label: 'Open', icon: <PluginIcon name={item.icon} size={14} />, onSelect: () => onSelect(item.key) },
      ...(onSplit && !isMobile
        ? [
            { divider: true },
            { header: 'Open in a new split' },
            { label: 'To the left', icon: <ArrowLeft size={14} />, onSelect: split('row', true) },
            { label: 'To the right', icon: <ArrowRight size={14} />, onSelect: split('row', false) },
            { label: 'Above', icon: <ArrowUp size={14} />, onSelect: split('col', true) },
            { label: 'Below', icon: <ArrowDown size={14} />, onSelect: split('col', false) },
          ]
        : []),
    ]
  }

  // The Mobile tile's phone fact: the phones of this Cloud and whether
  // one is reachable. The status is color, not words - a reachable phone
  // turns the tile green with a black glyph, away phones leave a hollow
  // corner dot. No phones, no mark at all.
  const phones = (devices ?? []).filter(isPhone)
  const phoneOnline = phones.some((d) => d.online)

  const chatRow = (row) => {
    const workers = nest.kids.get(row.id) ?? []
    const open = workers.length > 0 && !folded[row.id]
    const dot = row.offline ? 'offline' : rolled(row)
    return (
      <div key={row.id} className="chat-branch">
        {chatItem(row, workers.length, open, dot)}
        {open && <div className="chat-team">{workers.map(chatRow)}</div>}
      </div>
    )
  }

  const chatItem = (row, workerCount, open, dot) => (
    <div
      className={`chat-item${drag?.item.id === row.id ? ' sb-dragged' : ''}${workerCount > 0 ? ' chat-item--lead' : ''}`}
      onContextMenu={(e) => {
        e.preventDefault()
        // A chat on another machine moves among that machine's projects.
        move.prepare(row)
        setMenu({ x: e.clientX, y: e.clientY, row })
      }}
    >
      <button
        className={`chat-row${row.id === active ? ' active' : ''}`}
        data-status={row.status}
        onClick={() => onSelect(row.id)}
        onPointerDown={
          // Only a chat that runs here can be dropped on this computer's
          // projects; one on another machine moves from its menu.
          !isMobile && !row.device ? start(row) : undefined
        }
      >
        {/* the harness's mark leads - every harness, one
            sidebar, the at-a-glance signal of which agent owns
            each chat - sized to read from afar, then the title, with
            the status dot at the right edge so every status scans in
            one column */}
        {row.harness && <HarnessMark harness={row.harness} size={15} />}
        <span className="chat-title pv">{row.title}</span>
        {mode === 'cloud' && row.device && (
          <span className="chat-device pv">{row.device}</span>
        )}
        {mode === 'local' && row.synced && (
          <Cloud size={11} className="chat-synced" aria-label="Synced to your devices" />
        )}
        <span
          className={`dot dot--${dot}`}
          title={row.offline ? (privacy ? 'Offline' : `${row.device} is offline`) : undefined}
        />
      </button>
      {/* A lead folds its workers away; the dot above keeps saying what
          is under it. */}
      {workerCount > 0 && (
        <button
          type="button"
          className="chat-fold"
          title={open ? 'Fold its workers' : `Show its ${workerCount} worker${workerCount === 1 ? '' : 's'}`}
          aria-label={open ? 'Fold its workers' : 'Show its workers'}
          aria-expanded={open}
          onClick={() => setFolded((f) => ({ ...f, [row.id]: !f[row.id] }))}
        >
          <CaretDown size={10} className={`chat-fold-caret${open ? '' : ' closed'}`} />
        </button>
      )}
      {/* Archive hides the chat from this list; Settings keeps it. */}
      <button
        type="button"
        className="chat-archive"
        title="Archive this chat"
        aria-label={`Archive ${row.title}`}
        onClick={() => archive(row.id)}
      >
        <Archive size={12} />
      </button>
    </div>
  )

  return (
    <aside className={`sidebar${open ? '' : ' collapsed'}`}>
      <div className="sb-actions">
        {/* Local is this computer's chats; Cloud is the synced chats of
            every device the user signed in on. A phone has only Cloud. */}
        {!isMobile && (
        <div className="mode-switch" role="group" aria-label="Connection mode">
          <button
            className={mode === 'local' ? 'on' : ''}
            aria-pressed={mode === 'local'}
            onClick={() => onMode('local')}
          >
            <House size={13} />
            Local
          </button>
          <button
            className={mode === 'cloud' ? 'on' : ''}
            aria-pressed={mode === 'cloud'}
            onClick={() => onMode('cloud')}
          >
            <Cloud size={13} />
            Cloud
          </button>
        </div>
        )}
        <button className="side-tile" onClick={() => onSelect('new')} title={hintNew('New chat')}>
          <Plus size={17} weight="bold" />
          New chat
        </button>
        <label className="side-tile search">
          <MagnifyingGlass size={17} className="search-icon" />
          <input
            ref={searchRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              // Esc in the search clears it, then leaves it.
              if (e.key === 'Escape') {
                e.preventDefault()
                if (query) setQuery('')
                else e.currentTarget.blur()
              }
            }}
            placeholder="Search"
            title={hintSearch('Search chats')}
            spellCheck={false}
          />
          {query && (
            <button className="search-clear" onClick={() => setQuery('')} title="Clear">
              <X size={12} weight="bold" />
            </button>
          )}
        </label>
        {/* Plugins and automations act on this computer, so the desktop
            shows them in Local and Cloud alike (a phone runs no chats and
            has neither); Machines belongs to Cloud and reveals and
            collapses with the mode switch (the grid-rows transition). */}
        <div className={`machines-reveal${isMobile ? ' closed' : ''}`}>
          <div className="machines-clip">
            <button
              className={`side-tile${active === 'plugins' ? ' on' : ''}`}
              onClick={() => onSelect('plugins')}
            >
              <PuzzlePiece size={17} />
              Plugins
            </button>
            <button
              className={`side-tile${active === 'automations' ? ' on' : ''}`}
              onClick={() => onSelect('automations')}
            >
              <Lightning size={17} />
              Automations
            </button>
          </div>
        </div>
        <div className={`machines-reveal${mode === 'cloud' ? '' : ' closed'}`}>
          <div className="machines-clip">
            <button
              className={`side-tile${active === 'machines' ? ' on' : ''}`}
              onClick={() => onSelect('machines')}
            >
              <Desktop size={17} />
              Machines
            </button>
          </div>
        </div>
      </div>

      <nav className="sb-list" aria-label={pluginViews.length > 0 ? 'Plugins, projects and chats' : 'Projects and chats'} ref={listRef}>
        {/* The views plugins add, each a tile that opens in a pane. A
            plugin runs in this console, so the group shows in Local and
            Cloud alike; with no such plugin there is no group. */}
        {pluginViews.length > 0 && (
          <div className="sb-plugins" role="group" aria-label="Plugins">
            <div className="section-title sb-plugins-title">Plugins</div>
            {pluginViews.map((item) => (
              <button
                key={item.key}
                type="button"
                className={`sb-plugin-row${item.key === active ? ' active' : ''}`}
                title={item.title === item.pluginName ? item.title : `${item.title} (${item.pluginName})`}
                onClick={() => onSelect(item.key)}
                onContextMenu={(e) => {
                  e.preventDefault()
                  setMenu({ x: e.clientX, y: e.clientY, view: item })
                }}
              >
                <PluginIcon name={item.icon} size={15} />
                <span className="sb-plugin-name">{item.title}</span>
              </button>
            ))}
          </div>
        )}
        <div className="section-title sb-projects-head">
          Projects
          {/* The one way a folder becomes a project - the same flow the
              home screen's Add project button opens. */}
          <button
            type="button"
            className="sb-add-project"
            onClick={onAddProject}
            title="Add a project"
          >
            <Plus size={12} weight="bold" />
          </button>
        </div>
        {shownProjects.length === 0 && (
          <p className="sb-empty sb-projects-empty">
            No projects yet. <button className="sb-empty-add" onClick={onAddProject}>Add a project</button> to group its chats here.
          </p>
        )}
        {shownProjects.map(({ project, items }) => {
          const isCollapsed = !!collapsed[project.id]
          return (
            <section
              key={project.id}
              className={`project${drag?.over === project.id ? ' sb-drop-target' : ''}`}
              data-drop={project.id}
            >
              <button
                className="project-head"
                onClick={() => toggleProject(project.id)}
                aria-expanded={!isCollapsed}
              >
                <span className={`project-caret${isCollapsed ? ' closed' : ''}`}>
                  <CaretDown size={12} />
                </span>
                <span className="project-name pv">{project.folders[0].split(/[\\/]/).filter(Boolean).pop()}</span>
                <span className="project-count">{items.length}</span>
              </button>
              {/* A new chat already in this project, straight from its
                  row: no trip through the home screen's project picker. */}
              <button
                type="button"
                className="sb-project-new"
                title={`New chat in ${project.folders[0].split(/[\\/]/).filter(Boolean).pop()}`}
                aria-label={`New chat in ${project.folders[0].split(/[\\/]/).filter(Boolean).pop()}`}
                onClick={() => onNewChatIn?.(project.id)}
              >
                <Plus size={12} weight="bold" />
              </button>
              {/* Unregistering keeps the chats - they fall to the flat
                  list below; the folder on disk is never touched. */}
              <button
                type="button"
                className="sb-project-remove"
                title="Remove the project - its chats stay"
                onClick={() => removeProject(project.id)}
              >
                <TrashSimple size={11} />
              </button>
              {!isCollapsed && items.map(chatRow)}
            </section>
          )
        })}

        {/* The flat Chats list is a drop target too: a chat dropped here
            leaves its project and works in the home folder. */}
        <div className={drag?.over === '' ? 'sb-drop-target' : undefined} data-drop="">
          <div className="section-title sb-chats-title">Chats</div>
          {grouped.projects.length > 0 && grouped.flat.length === 0 && (
            <p className="sb-empty">No chats outside projects.</p>
          )}
          {grouped.flat.map(chatRow)}
        </div>

        {rows.length === 0 && (
          <p className="sb-empty">
            {query.trim()
              ? `No chats match “${query.trim()}”.`
              : mode === 'cloud'
                ? 'No synced chats yet. Start one - it shows up on all your devices.'
                : 'No chats yet. Start one - it will appear here.'}
          </p>
        )}
        {rows.length > 0 && query.trim() && visible.length === 0 && (
          <p className="sb-empty">No chats match “{query.trim()}”.</p>
        )}
      </nav>

      <footer className="sb-foot">
        {/* The footer's views, as icons: account, mobile, metrics, the
            browser, then settings. Each opens its view in the primary pane. */}
        <div className="sb-foot-row" role="group" aria-label="Account, mobile, metrics, browser, settings">
          <button
            type="button"
            className={`sb-icon-btn${active === 'account' ? ' on' : ''}`}
            aria-pressed={active === 'account'}
            title="Account"
            aria-label="Account"
            onClick={() => onSelect('account')}
          >
            {/* UserCircle's ink sits inside a thin circle, so it reads
                smaller than its neighbors - 2px of optical correction. */}
            <UserCircle size={22} />
          </button>
          <button
            type="button"
            className={`sb-icon-btn${phones.length ? (phoneOnline ? ' sb-phone--online' : ' sb-phone--offline') : ''}${active === 'mobile' ? ' on' : ''}`}
            aria-pressed={active === 'mobile'}
            title={
              !phones.length
                ? 'Mobile'
                : phoneOnline
                  ? `Phone online${phones.length > 1 ? ` (${phones.filter((d) => d.online).length} of ${phones.length})` : ''}`
                  : 'Phone away'
            }
            aria-label="Mobile"
            onClick={() => onSelect('mobile')}
          >
            <DeviceMobile size={20} />
            {/* The status is color, not words: a reachable phone tints
                the tile green with a black glyph; an away one leaves a
                hollow dot in the tile's corner. */}
            {phones.length > 0 && !phoneOnline && (
              <span className="sb-phone-dot" aria-hidden="true" />
            )}
          </button>
          <button
            type="button"
            className={`sb-icon-btn${active === 'metrics' ? ' on' : ''}`}
            aria-pressed={active === 'metrics'}
            title="Metrics"
            aria-label="Metrics"
            onClick={() => onSelect('metrics')}
          >
            <ChartBar size={20} />
          </button>
          {/* The browser is this device's own, in Local and Cloud alike. */}
          <button
            type="button"
            className={`sb-icon-btn${active === 'browser' ? ' on' : ''}`}
            aria-pressed={active === 'browser'}
            title="Browser"
            aria-label="Browser"
            onClick={() => onSelect('browser')}
          >
            <Globe size={20} />
          </button>
          <button
            type="button"
            className={`sb-icon-btn${active === 'settings' ? ' on' : ''}`}
            aria-pressed={active === 'settings'}
            title="Settings"
            aria-label="Settings"
            onClick={() => onSelect('settings')}
          >
            <GearSix size={20} />
          </button>
        </div>
      </footer>
      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          items={menu.view ? viewMenuItems(menu.view) : menuItems(menu.row)}
          onClose={() => setMenu(null)}
        />
      )}
      {drag &&
        createPortal(
          <div ref={label} className="sb-drag-label" style={{ left: drag.x, top: drag.y }} aria-hidden="true">
            {drag.item.harness && <HarnessMark harness={drag.item.harness} size={13} />}
            <span className="pv">{drag.item.title}</span>
          </div>,
          document.body,
        )}
      {move.modal}
      {deleting && (
        <DeleteChatModal
          title={deleting.title}
          onClose={() => setDeleting(null)}
          onDelete={async () => {
            await deleteChat(deleting.id)
            if (deleting.id === active) onSelect('new')
          }}
        />
      )}
    </aside>
  )
}
