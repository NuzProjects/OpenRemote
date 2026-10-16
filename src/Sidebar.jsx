import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  Archive,
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  ArrowsInLineVertical,
  ChartBar,
  ChatCircle,
  Cloud,
  Copy,
  Desktop,
  DeviceMobile,
  EnvelopeSimple,
  EnvelopeSimpleOpen,
  FolderOpen,
  GearSix,
  Globe,
  House,
  Lightning,
  MagnifyingGlass,
  PencilSimple,
  Plus,
  PushPin,
  PushPinSlash,
  PuzzlePiece,
  TrashSimple,
  UserCircle,
  X,
} from '@phosphor-icons/react'
import { useConsole } from './state/console.jsx'
import { projectName, sections } from './projects.js'
import { chatStatus } from './state/reducer.js'
import { activeSessions } from './archive.js'
import { deviceName, isPhone, sessionsForMode } from './cloud.js'
import { hasTauri, isMobile } from './platform.js'
import { HarnessMark } from './brand-marks.jsx'
import ContextMenu from './ContextMenu.jsx'
import DeleteChatModal from './DeleteChatModal.jsx'
import { usePrivacyMode } from './privacy.js'
import { useHint, useShortcut } from './keyboard.jsx'
import { usePlugins } from './plugins-host.jsx'
import { PluginIcon } from './plugin-icons.jsx'
import { useMoveChat } from './useMoveChat.jsx'
import { usePersistedList, usePinned, useUnseen } from './useSidebarMarks.js'
import { KEYS, toggled } from './sidebar-marks.js'
import { CHATS_PAGE, DOT_WORDS, PROJECT_PAGE, dotKind, pageOf, pinnedRows, rollup } from './sidebar-groups.js'
import SidebarChat from './SidebarChat.jsx'
import SidebarProject from './SidebarProject.jsx'
import SidebarNote, { useNote } from './SidebarNote.jsx'
import { useChatDrag } from './useChatDrag.js'
import { wouldMove } from './move-chat.js'
import './sidebar.css'
import './move.css'

// The "Show more" count of the flat Chats list (a project's is its id).
const FLAT_KEY = '@chats'

export default function Sidebar({ open, active, mode, onMode, onSelect, onSplit, onAddProject, onNewChatIn, onReveal }) {
  const { connection, sessions, chats, devices, thisDevice, projects, removeProject, archived, setChatArchived, deleteChat, renameChat, restoreChatTitle } = useConsole()
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
  // The chat whose name is being edited in its row.
  const [renaming, setRenaming] = useState(null)

  // A chat never opened here has no record, but the poll still carries its
  // status: without it a chat running in the background (started on another
  // device, or by an automation) showed no dot.
  const statusOf = (session) => chats[session.id]?.status ?? chatStatus(session.status)

  // Local: everything that runs on this computer. Cloud: every synced chat,
  // named by the device it runs on when that isn't this one.
  const rows = useMemo(() => {
    return sessionsForMode(activeSessions(sessions, archived), mode, thisDevice).map((session) => {
      const elsewhere = session.executor && session.executor !== thisDevice
      const device = elsewhere ? (devices ?? []).find((d) => d.id === session.executor) : null
      return {
        id: session.id,
        title: chats[session.id]?.title ?? session.title ?? 'A new task',
        // A chat with no name yet shows a stand-in; renaming starts blank.
        named: Boolean(chats[session.id]?.title ?? session.title),
        status: statusOf(session),
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

  // "Done, not seen": a turn that ended or failed in a chat that was not on
  // screen keeps a mark until the chat is opened. It watches every chat -
  // whatever the mode, search or archive hides - so the mark is there when
  // the chat comes back into view.
  const statuses = useMemo(
    () => new Map((sessions ?? []).map((s) => [s.id, statusOf(s)])),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [sessions, chats],
  )
  const alive = useMemo(
    () => (connection.state === 'connected' && sessions.length > 0 ? new Set(sessions.map((s) => s.id)) : null),
    [connection.state, sessions],
  )
  const { unseen, mark } = useUnseen({ statuses, archived, active, alive })
  const { pinned, pin } = usePinned(alive)

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
  //
  // Pinned chats sit in their own group above Projects, so a chat is in one
  // place only: they leave their project's list (and the flat one). A
  // project knows how many of its chats went there, so it never claims to
  // have none.
  const pins = useMemo(() => pinnedRows(visible, pinned), [visible, pinned])
  const grouped = useMemo(() => {
    const pinnedIds = new Set(pins.map((row) => row.id))
    const apart = (items) => items.filter((row) => !pinnedIds.has(row.id))
    const all = sections(projects, visible)
    return {
      projects: all.projects.map((g) => {
        const items = apart(g.items)
        return { ...g, items, pinned: g.items.length - items.length }
      }),
      flat: apart(all.flat),
    }
  }, [projects, visible, pins])
  const searching = query.trim() !== ''
  const groups = searching ? grouped.projects.filter((g) => g.items.length > 0) : grouped.projects

  // How many extra pages of chats each list has been asked for ("Show N
  // more"). They belong to this look at the list: folding a project puts it
  // back to its first page.
  const [more, setMore] = useState({})
  const showMore = (key) => setMore((m) => ({ ...m, [key]: (m[key] ?? 0) + 1 }))
  const toggleProject = (id) => {
    setFolded((list) => toggled(list, id, !list.includes(id)))
    setMore((m) => {
      if (!(id in m)) return m
      const { [id]: _folded, ...rest } = m
      return rest
    })
  }
  // A search opens the projects that hold a match: a folded one would hide
  // the very chats being looked for.
  const isFolded = (id) => !searching && collapsed.has(id)

  // Each project shows its five most recent chats, the flat Chats list
  // fifteen; "Show N more" opens the next page. A chat that needs you, and
  // the one that is open, stay in view wherever they sit - a long list
  // never hides the one that is waiting, or the user's place in it. A
  // search shows every match.
  const keepShown = (row) => row.id === active || (row.status === 'waiting' && !row.offline)
  const pageFor = (key, items, page) =>
    searching
      ? { shown: items, rest: [], next: 0 }
      : pageOf(items, { page, pages: more[key] ?? 0, keep: keepShown })
  const projectViews = groups.map((g) => ({
    ...g,
    key: g.project.id,
    device: null,
    deviceName: null,
    folded: isFolded(g.project.id),
    page: pageFor(g.project.id, g.items, PROJECT_PAGE),
  }))
  const flatPage = pageFor(FLAT_KEY, grouped.flat, CHATS_PAGE)

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
  // pinned chats, each open project's chats, then the flat Chats list. A
  // folded project's chats are skipped, like the eye skips them - and so
  // are the ones "Show more" has not opened.
  const searchRef = useRef(null)
  const order = [
    ...pins,
    ...projectViews.flatMap((v) => (v.folded ? [] : v.page.shown)),
    ...flatPage.shown,
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

  // Archiving is forgiving: a quiet note offers Undo for a few seconds. A
  // chat is archived from many places (the row's button, its menu, the
  // shortcut, a pane's menu) and all of them end in the console's archived
  // set, so the note watches that set rather than each way in.
  const { note, say, dismiss } = useNote()
  const archivedBefore = useRef(archived)
  useEffect(() => {
    const before = archivedBefore.current
    archivedBefore.current = archived
    const added = [...archived].filter((id) => !before.has(id))
    if (added.length === 0) return
    const id = added[added.length - 1]
    say('Archived.', { label: 'Undo', run: () => setChatArchived(id, false) })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [archived])

  // A chat that leaves the list mid-edit (deleted on another device, say)
  // must not come back later with its field open.
  useEffect(() => {
    if (renaming && !rows.some((r) => r.id === renaming)) setRenaming(null)
  }, [rows, renaming])

  // Save a chat's new name from its row. An empty name puts back the one
  // the chat was given from its first message; a name that did not change
  // asks the daemon for nothing. The daemon's answer reaches every device.
  const saveName = async (row, text) => {
    setRenaming(null)
    const name = text.trim()
    if (name === (row.named ? row.title : '')) return
    try {
      if (name) await renameChat(row.id, name)
      else await restoreChatTitle(row.id, row.named ? row.title : null)
    } catch (err) {
      say(`Couldn't rename the chat: ${err.message ?? err}`, null, { veiled: true })
    }
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
      pinned.includes(row.id)
        ? { label: 'Unpin', icon: <PushPinSlash size={14} />, onSelect: () => pin(row.id, false) }
        : { label: 'Pin', icon: <PushPin size={14} />, onSelect: () => pin(row.id, true) },
      { label: 'Rename', icon: <PencilSimple size={14} />, onSelect: () => setRenaming(row.id) },
      unseen.has(row.id)
        ? { label: 'Mark as read', icon: <EnvelopeSimpleOpen size={14} />, onSelect: () => mark(row.id, false) }
        : { label: 'Mark as unread', icon: <EnvelopeSimple size={14} />, onSelect: () => mark(row.id, true) },
      move.menuItem(row),
      {
        label: 'Copy title',
        icon: <Copy size={14} />,
        onSelect: () => navigator.clipboard?.writeText(row.title).catch(() => {}),
      },
      { divider: true },
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
    ]
  }

  // A project's menu - right-click, the ... on its row, or a long press.
  // Removing is here, not beside the +: it sat one slip away from a new
  // chat. Its promise is the same - the chats stay, the folder is untouched.
  const reveal = async (folder) => {
    try {
      const { invoke } = await import('@tauri-apps/api/core')
      await invoke('reveal_in_folder', { path: folder })
    } catch (err) {
      say(`Couldn't open the folder: ${err?.message ?? err}`, null, { veiled: true })
    }
  }
  const collapseOthers = (key) => {
    const others = projectViews.filter((v) => v.key !== key).map((v) => v.key)
    setFolded((list) => others.reduce((l, k) => toggled(l, k, true), list))
    setMore((m) => (key in m ? { [key]: m[key] } : {}))
  }
  const removeHere = async (v) => {
    try {
      await removeProject(v.project.id)
      setFolded((list) => toggled(list, v.key, false))
    } catch (err) {
      say(`Couldn't remove the project: ${err?.message ?? err}`, null, { veiled: true })
    }
  }
  const projectMenuItems = (v) => {
    const folder = v.project.folders[0]
    return [
      { label: 'New chat here', icon: <Plus size={14} />, onSelect: () => onNewChatIn?.(v.project.id, v.device) },
      // The file manager is the desktop app's, and the folder this
      // computer's: a project of another machine has no folder here.
      ...(hasTauri && !isMobile && !v.device
        ? [{ label: 'Open folder', icon: <FolderOpen size={14} />, onSelect: () => reveal(folder) }]
        : []),
      {
        label: 'Copy path',
        icon: <Copy size={14} />,
        onSelect: () => navigator.clipboard?.writeText(folder).catch(() => {}),
      },
      { divider: true },
      {
        label: 'Collapse all others',
        icon: <ArrowsInLineVertical size={14} />,
        disabled: !projectViews.some((o) => o.key !== v.key && !o.folded),
        onSelect: () => collapseOthers(v.key),
      },
      { divider: true },
      {
        label: 'Remove project',
        icon: <TrashSimple size={14} />,
        hint: 'Chats stay',
        danger: true,
        onSelect: () => removeHere(v),
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

  const kindOf = (row) => dotKind({ status: row.status, offline: row.offline, unseen: unseen.has(row.id) })

  // The quiet line under a list that has more to show. A dot on it says what
  // the chats it leaves out are up to, so a long list never hides a failure.
  const moreLine = (key, page) => {
    const top = rollup(page.rest.map(kindOf))
    return (
      <button type="button" className="sb-more" onClick={() => showMore(key)}>
        <span>Show {page.next} more</span>
        {top && (
          <span className={`dot dot--${top}`} role="img" aria-label={DOT_WORDS[top]} title={DOT_WORDS[top]} />
        )}
      </button>
    )
  }

  const chatRow = (row) => (
    <SidebarChat
      key={row.id}
      row={row}
      kind={kindOf(row)}
      mode={mode}
      active={row.id === active}
      dragged={drag?.item.id === row.id}
      privacy={privacy}
      renaming={renaming === row.id}
      onOpen={onSelect}
      onArchive={archive}
      onMenu={(e, chat) => {
        // A chat on another machine moves among that machine's projects.
        move.prepare(chat)
        setMenu({ x: e.clientX, y: e.clientY, row: chat })
      }}
      // Only a chat that runs here can be dropped on this computer's
      // projects; one on another machine moves from its menu.
      onPointerDown={!isMobile && !row.device ? start(row) : undefined}
      onRenameStart={setRenaming}
      onRenameSave={saveName}
      onRenameCancel={() => setRenaming(null)}
    />
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

      <div className="sb-body">
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
        {/* Pinned chats, in the order they were pinned: each keeps its
            harness mark, device and dot. */}
        {pins.length > 0 && (
          <div className="sb-pinned" role="group" aria-label="Pinned chats">
            <div className="section-title">Pinned</div>
            {pins.map(chatRow)}
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
        {projectViews.map((v) => {
          const { project, items, folded, page } = v
          return (
            <SidebarProject
              key={v.key}
              name={projectName(project)}
              device={v.deviceName}
              count={items.length}
              top={folded ? rollup(items.map(kindOf)) : null}
              folded={folded}
              dropKey={v.device ? undefined : project.id}
              dropping={drag?.over === project.id}
              privacy={privacy}
              onToggle={() => toggleProject(v.key)}
              onNewChat={() => onNewChatIn?.(project.id, v.device)}
              onMenu={({ x, y }) => setMenu({ x, y, group: v })}
            >
              {!folded && page.shown.map(chatRow)}
              {!folded && page.rest.length > 0 && moreLine(v.key, page)}
              {/* A project just added has no chats: say so quietly, and
                  leave its + (and the drop target) in place. */}
              {!folded && items.length === 0 && (
                <p className="sb-empty sb-project-empty">
                  {v.pinned > 0 ? 'Its chats are pinned' : 'No chats yet'}
                </p>
              )}
            </SidebarProject>
          )
        })}

        {/* The flat Chats list is a drop target too: a chat dropped here
            leaves its project and works in the home folder. */}
        <div className={drag?.over === '' ? 'sb-drop-target' : undefined} data-drop="">
          <div className="section-title sb-chats-title">Chats</div>
          {grouped.projects.length > 0 && grouped.flat.length === 0 && (
            <p className="sb-empty">No chats outside projects.</p>
          )}
          {flatPage.shown.map(chatRow)}
          {flatPage.rest.length > 0 && moreLine(FLAT_KEY, flatPage)}
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
      <SidebarNote note={note} onDismiss={dismiss} />
      </div>

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
          items={menu.view ? viewMenuItems(menu.view) : menu.group ? projectMenuItems(menu.group) : menuItems(menu.row)}
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
