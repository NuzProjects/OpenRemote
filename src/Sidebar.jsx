import { useEffect, useMemo, useRef, useState } from 'react'
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
import { chatStatus } from './state/reducer.js'
import { attentionTitle, needsYou } from './needs-you.js'
import { sections } from './projects.js'
import { activeSessions } from './archive.js'
import { deviceName, isPhone, sessionsForMode } from './cloud.js'
import { isMobile } from './platform.js'
import { chatDragPayload } from './split.js'
import { armRow, clearRow, rowIsArmed } from './row-confirm.js'
import { listHasUnread, loadSeen, recordSeen, seedSeen, storeSeen, unreadIds } from './unread.js'
import { lineFor, missingLines, pruneLines, questionKey, questionLine, rememberLine, wantedKeys } from './question-line.js'
import { HarnessMark } from './brand-marks.jsx'
import ContextMenu from './ContextMenu.jsx'
import DeleteChatModal from './DeleteChatModal.jsx'
import { usePrivacyMode } from './privacy.js'
import { useHint, useShortcut } from './keyboard.jsx'
import './sidebar.css'

// How long the archived line stays. Long enough to catch a mispress on a
// hover control, short enough that the sidebar keeps no history of its own.
const UNDO_MS = 8000

export default function Sidebar({ open, active, mode, onMode, onSelect, onSplit, onAddProject, onNewChatIn, onReveal }) {
  const { connection, sessions, chats, devices, thisDevice, projects, projectsAnswered, sessionsAnswered, removeProject, archived, setChatArchived, deleteChat, api } = useConsole()
  const privacy = usePrivacyMode()
  const [query, setQuery] = useState('')
  const [collapsed, setCollapsed] = useState({})
  // The project waiting on a "unregister?" answer. The sidebar's trash sits
  // two pixels from the project's new-chat button, and unregistering has no
  // undo, so the first press arms the row and the second acts. row-confirm.js
  // owns the rule (one armed row at a time, no id, no arming) so this surface
  // and the panes that remove plugins cannot drift apart.
  const [armed, setArmed] = useState(null)
  const [menu, setMenu] = useState(null)
  const [deleting, setDeleting] = useState(null)
  // The archive's way back. Archive is a hover button at the row's edge, so a
  // mispress otherwise costs a hunt through Settings > Archived chats that a
  // first-time user does not know exists. One line, for a moment after the
  // act, replaced by a second archive rather than stacked - the same
  // one-at-a-time rule the armed rows follow. Not the notice stack: that
  // lives in the shell, and this is the list the control lives in.
  const [undo, setUndo] = useState(null)

  // The line outlives nothing: eight seconds, or the next archive, or the
  // sidebar going away. A row that lingered would teach people to ignore it.
  useEffect(() => {
    if (!undo) return
    const timer = setTimeout(() => setUndo(null), UNDO_MS)
    return () => clearTimeout(timer)
  }, [undo])
  // What this console has looked at, per chat: the stamp each chat showed
  // the last time it was read. Read once at mount from this computer's own
  // key, never on the boot path, so a damaged record cannot take the first
  // paint. The ref carries the newest value to the effects below, so the two
  // of them cannot overwrite each other's fresh write with a stale copy.
  const [seen, setSeen] = useState(() => loadSeen())
  const seenRef = useRef(seen)
  seenRef.current = seen
  const remember = (next) => {
    if (next === seenRef.current) return
    seenRef.current = next
    setSeen(next)
    storeSeen(next)
  }

  // Local: everything that runs on this computer. Cloud: every synced chat,
  // named by the device it runs on when that isn't this one.
  const rows = useMemo(() => {
    return sessionsForMode(activeSessions(sessions, archived), mode, thisDevice).map((session) => {
      const elsewhere = session.executor && session.executor !== thisDevice
      const device = elsewhere ? (devices ?? []).find((d) => d.id === session.executor) : null
      // A chat on screen has a live status from its own stream; every chat has
      // the poll's. They are kept apart because the dot shows the live one and
      // the waiting rule needs to know which it is reading (needs-you.js).
      const liveStatus = chats[session.id]?.status ?? null
      return {
        id: session.id,
        title: chats[session.id]?.title ?? session.title ?? 'A new task',
        status: liveStatus ?? 'idle',
        liveStatus,
        polledStatus: chatStatus(session.status),
        harness: session.harness,
        workspace: session.workspace ?? null,
        updatedAt: session.updated_at ?? 0,
        device: elsewhere ? deviceName(devices, session.executor) : null,
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

  // The chats that are blocked on a person, oldest wait first. This group
  // ignores the search field on purpose: a search narrows the lists below, and
  // a chat whose harness is starving should not be hidden by a query typed for
  // something else.
  const needs = useMemo(() => needsYou(rows), [rows])

  // What each waiting chat is holding, one line each, read once per question.
  // There is no clock here of its own: the sessions beat is the only thing
  // that changes `needs`, an answer is cached under the stamp it was read at,
  // and a chat that stops waiting is dropped, so a steady state reads
  // nothing. The line is a summary only - see the row below for the rule.
  const [questions, setQuestions] = useState({})
  const questionsRef = useRef(questions)
  questionsRef.current = questions
  const waitingKey = needs.chats.map((c) => questionKey(c.id, c.updatedAt)).join('|')
  useEffect(() => {
    if (!needs.chats.length) {
      if (Object.keys(questionsRef.current).length) setQuestions({})
      return undefined
    }
    const kept = pruneLines(questionsRef.current, wantedKeys(needs.chats))
    if (Object.keys(kept).length !== Object.keys(questionsRef.current).length) {
      questionsRef.current = kept
      setQuestions(kept)
    }
    const missing = missingLines(kept, needs.chats)
    if (!missing.length) return undefined
    let cancelled = false
    let cache = { ...kept }
    ;(async () => {
      for (const row of missing) {
        let line = null
        try {
          line = questionLine(await api.decisions(row.id))
        } catch {
          // A chat whose decisions cannot be read shows no line rather than
          // an error in the sidebar: the group already says it is waiting.
          line = null
        }
        if (cancelled) return
        // Kept even when null, so a failed or empty read is not retried on
        // every beat; only a new question (a new stamp) asks again.
        cache = rememberLine(cache, questionKey(row.id, row.updatedAt), line)
        setQuestions({ ...cache })
      }
    })()
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [waitingKey, api])

  // The two sections: registered projects with their chats, then the flat
  // Chats list - every chat that belongs to no project. A waiting chat is in
  // the group above instead, so no chat reads twice and each project's count
  // matches the rows under it.
  const rest = useMemo(() => {
    const waiting = new Set(needs.chats.map((c) => c.id))
    return visible.filter((c) => !waiting.has(c.id))
  }, [visible, needs])
  const grouped = useMemo(() => sections(projects, rest), [projects, rest])

  // The ids that should carry the quiet mark. Ordering never consults it:
  // the sorts above keep the order they had, so nothing jumps under the
  // pointer when a mark appears or clears.
  const unread = useMemo(() => unreadIds(seen, rows), [seen, rows])

  const toggleProject = (id) => {
    setCollapsed((c) => ({ ...c, [id]: !c[id] }))
  }

  // The keyboard's walk through the list goes in the order it reads: the
  // chats that need the user first (they are at the top of the list), then
  // each open project's chats, then the flat Chats list. A collapsed
  // project's chats are skipped, like the eye skips them.
  const searchRef = useRef(null)
  const order = [
    ...needs.chats,
    ...grouped.projects.flatMap(({ project, items }) => (collapsed[project.id] ? [] : items)),
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

  // Attention without a toast: while the window cannot be looked at, the
  // document title carries how many chats are waiting. Looking at the window
  // again, or a waiting list that emptied, gives the console's own title back.
  // A background window still shows its title, so this is the quietest place
  // to put a count that is not a dialog. The desktop shell's real window
  // title and a taskbar flash are shell commands, which the console cannot
  // reach from here.
  const [watched, setWatched] = useState(true)
  const baseTitle = useRef('')
  // The string this effect last wrote. Anything else in the title at the next
  // beat means another writer owns it now, and that is the console's own title
  // from then on - so the base is read at the moment of the decision instead of
  // being a value cached at mount that can go stale.
  const writtenTitle = useRef(null)
  useEffect(() => {
    baseTitle.current = document.title
    const read = () => setWatched(!document.hidden && document.hasFocus())
    read()
    window.addEventListener('focus', read)
    window.addEventListener('blur', read)
    document.addEventListener('visibilitychange', read)
    return () => {
      window.removeEventListener('focus', read)
      window.removeEventListener('blur', read)
      document.removeEventListener('visibilitychange', read)
    }
  }, [])
  useEffect(() => {
    if (writtenTitle.current !== null && document.title !== writtenTitle.current) {
      baseTitle.current = document.title
    }
    const next = attentionTitle(baseTitle.current, needs.count, unread.size, watched)
    // Written only when it changed: a title that rewrote itself on every beat
    // would be worse than no title at all.
    if (document.title !== next) {
      writtenTitle.current = next
      document.title = next
    }
    return () => {
      // Leaving a title behind that somebody else wrote would be the same
      // rudeness as taking it in the first place, so the cleanup only puts the
      // console's own title back when the attention title is still ours.
      if (writtenTitle.current !== null && document.title !== writtenTitle.current) return
      const back = attentionTitle(baseTitle.current, 0, 0, true)
      if (document.title !== back) {
        writtenTitle.current = back
        document.title = back
      }
    }
  }, [needs.count, unread.size, watched])

  // The quiet mark's two halves. First sight of a chat is not news: a
  // backlog from before this existed, or a chat another device created,
  // gets its record at the stamp it had when this console first listed it.
  // Only what moves after that is marked.
  useEffect(() => {
    remember(seedSeen(seenRef.current, rows))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows])

  // Looking at a chat marks it read - the chat on screen, and only while the
  // window is actually being looked at (visible and focused), which is the
  // same fact the title effect above reads. A chat left open in a
  // background window has not been read.
  useEffect(() => {
    if (!watched || !active) return
    const row = rows.find((r) => r.id === active)
    if (!row) return
    remember(recordSeen(seenRef.current, row.id, row.updatedAt))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [watched, active, rows])

  const archive = (id) => {
    const row = rows.find((r) => r.id === id)
    setChatArchived(id, true)
    // Both ways in come through here (the hover button and the row's menu),
    // so the way back is offered whichever one the press came from.
    setUndo(row ? { id: row.id, title: row.title } : null)
    if (id === active) onSelect('new')
  }

  // The same call the Settings list makes. Restoring puts the chat back in
  // the list it was archived from, with its own record untouched.
  const undoArchive = () => {
    if (!undo) return
    setChatArchived(undo.id, false)
    setUndo(null)
  }

  // Right-click on a chat: the same actions as the hover buttons, plus the
  // split directions - the same four words the pane header and the main
  // area's own menu use.
  const menuItems = (row) => {
    const split = (dir, before) => () => onSplit(row.id, dir, before)
    const canSplit = onSplit && !isMobile
    return [
      { label: 'Open', icon: <ChatCircle size={14} />, onSelect: () => onSelect(row.id) },
      ...(canSplit
        ? [
            { divider: true },
            { label: 'Split right', icon: <ArrowRight size={14} />, onSelect: split('row', false) },
            { label: 'Split down', icon: <ArrowDown size={14} />, onSelect: split('col', false) },
            { label: 'Split left', icon: <ArrowLeft size={14} />, onSelect: split('row', true) },
            { label: 'Split up', icon: <ArrowUp size={14} />, onSelect: split('col', true) },
          ]
        : []),
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
      {
        label: 'Copy title',
        icon: <Copy size={14} />,
        onSelect: () => navigator.clipboard?.writeText(row.title).catch(() => {}),
      },
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
      className="chat-item"
      // A chat is a thing you can drag into a pane: the middle opens it
      // there, an edge band splits. Right-click and the palette still do
      // the same job for anyone who never drags.
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData('text/plain', chatDragPayload(row.id))
        e.dataTransfer.effectAllowed = 'move'
      }}
      onContextMenu={(e) => {
        e.preventDefault()
        setMenu({ x: e.clientX, y: e.clientY, row })
      }}
    >
      <button
        className={`chat-row${row.id === active ? ' active' : ''}`}
        data-status={row.status}
        // The quiet mark: one white-alpha tint step (DESIGN.md's ladder),
        // not a colour and not a number. The status column keeps its own
        // language, so "not read" and "waiting" cannot be mistaken.
        data-unread={unread.has(row.id) ? 'true' : undefined}
        onClick={() => onSelect(row.id)}
      >
        {/* the harness's mark leads - every harness, one
            sidebar, the at-a-glance signal of which agent owns
            each chat - sized to read from afar, then the title, with
            the status dot at the right edge so every status scans in
            one column */}
        {row.harness && <HarnessMark harness={row.harness} size={15} />}
        <div className="chat-titles">
          <span className="chat-title pv">{row.title}</span>
          {/* What the harness is holding, one line, read only. The sidebar
              never answers, approves or dismisses anything: a decision is
              answered in the chat, where the harness's own words, its
              options and (for an approval) what it wants to run are on
              screen together. A summary here that could act would be an
              approvals panel built out of a row, without any of that. */}
          {row.question && <span className="chat-question pv">{row.question}</span>}
        </div>
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

      {/* Pinned between the actions and the scrolled list, not inside it: the
          row that went is gone from whichever group held it, so there is no
          stable place in the list to put its way back, and a line that
          scrolls out of view is a line nobody reads. */}
      {undo && (
        <div className="chat-undo" role="status">
          <span className="chat-undo-text pv">Archived “{undo.title}”</span>
          <button
            type="button"
            className="chat-undo-act"
            aria-label={`Undo archiving ${undo.title}`}
            onClick={undoArchive}
          >
            Undo
          </button>
        </div>
      )}

      <nav className="sb-list" aria-label="Projects and chats">
        {/* The one group that exists only while it has something in it: a
            chat whose harness is blocked on an answer is starving, and it
            should not be hunted for in a long list. Same row, same mark, same
            amber dot - the status word is what puts it here. */}
        {needs.count > 0 && (
          <section className="sb-needs" aria-label="Needs you">
            <div className="section-title sb-needs-head">
              Needs you
              <span className="sb-needs-count">{needs.count}</span>
            </div>
            {needs.chats.map((row) => chatRow({ ...row, status: 'waiting', question: lineFor(questions, row.id, row.updatedAt) }))}
          </section>
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
          <p className="sb-empty">
            {projectsAnswered ? 'No projects yet.' : 'Loading your projects…'}
          </p>
        )}
        {grouped.projects.map(({ project, items }) => {
          const isCollapsed = !!collapsed[project.id]
          const name = project.folders[0].split(/[\\/]/).filter(Boolean).pop()
          const isArmed = rowIsArmed(armed, project.id)
          return (
            <section
              key={project.id}
              className={`project${isArmed ? ' armed' : ''}`}
              // Focus or a click leaving the row is a decision to keep it:
              // the armed state never survives a look away.
              onBlur={(e) => {
                if (isArmed && !e.currentTarget.contains(e.relatedTarget)) {
                  setArmed(clearRow())
                }
              }}
            >
              <button
                className="project-head"
                // Something inside is unread: the list says so quietly, one
                // text tier up, and never with a count.
                data-unread={listHasUnread(items, unread) ? 'true' : undefined}
                onClick={() => toggleProject(project.id)}
                aria-expanded={!isCollapsed}
              >
                <span className={`project-caret${isCollapsed ? ' closed' : ''}`}>
                  <CaretDown size={12} />
                </span>
                <span className="project-name pv">{name}</span>
                <span className="project-count">{items.length}</span>
              </button>
              {isArmed ? (
                /* The trash is replaced in place by the word that acts, so a
                   second press is a press on the same spot and cannot land on
                   the `+` two pixels away. It is always visible while armed
                   (a hover-only confirm is easy to miss) and Escape keeps. */
                <button
                  type="button"
                  className="sb-unregister"
                  autoFocus
                  title="Unregister this project. Its chats move to Chats and the folder on disk is never touched."
                  aria-label={`Unregister ${name}`}
                  onKeyDown={(e) => {
                    if (e.key === 'Escape') {
                      e.preventDefault()
                      setArmed(clearRow())
                    }
                  }}
                  onClick={() => {
                    setArmed(clearRow())
                    removeProject(project.id)
                  }}
                >
                  Unregister
                </button>
              ) : (
                <>
                  {/* A new chat already in this project, straight from its
                      row: no trip through the home screen's project picker. */}
                  <button
                    type="button"
                    className="sb-project-new"
                    title={`New chat in ${name}`}
                    aria-label={`New chat in ${name}`}
                    onClick={() => onNewChatIn?.(project.id)}
                  >
                    <Plus size={12} weight="bold" />
                  </button>
                  {/* Unregistering keeps the chats - they fall to the flat
                      list below; the folder on disk is never touched. It asks
                      once first, because that click sits beside the `+`. */}
                  <button
                    type="button"
                    className="sb-project-remove"
                    title="Remove the project - it asks once, and its chats stay"
                    aria-label={`Remove ${name}`}
                    onClick={() => setArmed((current) => armRow(current, project.id))}
                  >
                    <TrashSimple size={11} />
                  </button>
                </>
              )}
              {!isCollapsed && items.length === 0 && (
                <p className="sb-empty sb-project-empty">
                  {sessionsAnswered ? 'No chats yet.' : 'Loading your chats…'}
                </p>
              )}
              {!isCollapsed && items.map(chatRow)}
            </section>
          )
        })}

        <div className="section-title sb-chats-title" data-unread={listHasUnread(grouped.flat, unread) ? 'true' : undefined}>
          Chats
        </div>
        {/* Only while there are chats to be outside a project: with every
            project at zero, the projects say it and this line would be a
            second sentence about nothing. */}
        {grouped.projects.length > 0 && grouped.flat.length === 0 && rows.length > 0 && (
          <p className="sb-empty">
            {sessionsAnswered ? 'No chats outside projects.' : 'Loading your chats…'}
          </p>
        )}
        {grouped.flat.map(chatRow)}

        {/* With a project registered and nothing running, the project's own row
            says it has no chats yet; the generic line would say it twice. An
            unanswered first poll is not "no chats yet": until the list has
            answered, the line says it is still reading. */}
        {rows.length === 0 && grouped.projects.length === 0 && (
          <p className="sb-empty">
            {!sessionsAnswered
              ? 'Loading your chats…'
              : query.trim()
                ? `No chats match “${query.trim()}”.`
                : mode === 'cloud'
                  ? 'No synced chats yet.'
                  : 'No chats yet.'}
          </p>
        )}
        {rows.length > 0 && query.trim() && visible.length === 0 && (
          <p className="sb-empty">No chats match “{query.trim()}”.</p>
        )}
      </nav>

      <footer className="sb-foot">
        {/* The footer's views, as icons: account, mobile, metrics, then
            settings. Each opens its view in the primary pane. The browser
            lives in the homepage's floating bar instead. */}
        <div className="sb-foot-row" role="group" aria-label="Account, mobile, metrics, settings">
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
        <ContextMenu x={menu.x} y={menu.y} items={menuItems(menu.row)} onClose={() => setMenu(null)} />
      )}
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
