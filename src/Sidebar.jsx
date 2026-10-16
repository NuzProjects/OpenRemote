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
import { chatStatus } from './state/reducer.js'
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
import { usePersistedList } from './useSidebarMarks.js'
import { KEYS, toggled } from './sidebar-marks.js'
import { useChatDrag } from './useChatDrag.js'
import { wouldMove } from './move-chat.js'
import './sidebar.css'
import './move.css'

export default function Sidebar({ open, active, mode, onMode, onSelect, onSplit, onAddProject, onNewChatIn, onReveal }) {
  const { connection, sessions, chats, devices, thisDevice, projects, removeProject, archived, setChatArchived, deleteChat } = useConsole()
  const privacy = usePrivacyMode()
  // The views enabled plugins add: the Plugins group's tiles.
  const pluginViews = usePlugins()?.views ?? []
  const [query, setQuery] = useState('')
  // Which projects are folded: kept on this device, so the tree opens the
  // way it was left.
  const [folded, setFolded] = usePersistedList(KEYS.collapsed)
  const collapsed = useMemo(() => new Set(folded), [folded])
  const [menu, setMenu] = useState(null)
  const [deleting, setDeleting] = useState(null)

  // Local: everything that runs on this computer. Cloud: every synced chat,
  // named by the device it runs on when that isn't this one.
  const rows = useMemo(() => {
    return sessionsForMode(activeSessions(sessions, archived), mode, thisDevice).map((session) => {
      const elsewhere = session.executor && session.executor !== thisDevice
      const device = elsewhere ? (devices ?? []).find((d) => d.id === session.executor) : null
      return {
        id: session.id,
        title: chats[session.id]?.title ?? session.title ?? 'A new task',
        // A chat never opened here has no record, but the poll still
        // carries its status: without it a chat running in the background
        // (started on another device, or by an automation) showed no dot.
        status: chats[session.id]?.status ?? chatStatus(session.status),
        harness: session.harness,
        workspace: session.workspace ?? null,
        updatedAt: session.updated_at ?? 0,
        device: elsewhere ? deviceName(devices, session.executor) : null,
        executor: session.executor ?? null,
        // A copy's last status is stale while its device is away.
        offline: elsewhere && !device?.online,
        synced: Boolean(session.executor),
      }
    })
  }, [sessions, archived, chats, mode, devices, thisDevice])

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase()
    const sorted = [...rows].sort((a, b) => b.updatedAt - a.updatedAt)
    if (!q) return sorted
    return sorted.filter((c) => c.title.toLowerCase().includes(q))
  }, [rows, query])

  // The two sections: registered projects with their chats, then the flat
  // Chats list - every chat that belongs to no project. Every project
  // shows, empty ones too; a search narrows the list to the projects that
  // hold a match (an empty one would claim "no chats" about a project
  // whose chats merely didn't match).
  const grouped = useMemo(() => sections(projects, visible), [projects, visible])
  const searching = query.trim() !== ''
  const groups = searching ? grouped.projects.filter((g) => g.items.length > 0) : grouped.projects

  const toggleProject = (id) => setFolded((list) => toggled(list, id, !list.includes(id)))
  // A search opens the projects that hold a match: a folded one would hide
  // the very chats being looked for.
  const isFolded = (id) => !searching && collapsed.has(id)

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

  // The keyboard's walk through the list goes in the order it reads:
  // each open project's chats, then the flat Chats list. A collapsed
  // project's chats are skipped, like the eye skips them.
  const searchRef = useRef(null)
  const order = [
    ...grouped.projects.flatMap(({ project, items }) => (isFolded(project.id) ? [] : items)),
    ...grouped.flat,
  ].map((row) => row.id)
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

  const archive = (id) => {
    setChatArchived(id, true)
    if (id === active) onSelect('new')
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

  const chatRow = (row) => (
    <div
      key={row.id}
      className={`chat-item${drag?.item.id === row.id ? ' sb-dragged' : ''}`}
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
          className={`dot dot--${row.offline ? 'offline' : row.status}`}
          title={row.offline ? (privacy ? 'Offline' : `${row.device} is offline`) : undefined}
        />
      </button>
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
        {grouped.projects.length === 0 && (
          <p className="sb-empty sb-projects-empty">
            No projects yet. <button className="sb-empty-add" onClick={onAddProject}>Add a project</button> to group its chats here.
          </p>
        )}
        {groups.map(({ project, items }) => {
          const isCollapsed = isFolded(project.id)
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
                {items.length > 0 && <span className="project-count">{items.length}</span>}
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
              {/* A project just added has no chats: say so quietly, and
                  leave its + (and the drop target) in place. */}
              {!isCollapsed && items.length === 0 && (
                <p className="sb-empty sb-project-empty">No chats yet</p>
              )}
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
