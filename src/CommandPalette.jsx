// The command palette (Ctrl+K): one search over everything you can do or
// open - actions, chats, views, projects, machines - grouped, best match
// first, each row with its key on the right. An empty query shows recent
// chats and a few suggestions. "Switch model…", "Set effort…" and "Set
// permission…" open their own list inside the palette; Esc or Backspace
// on an empty search steps back out.

import { useEffect, useMemo, useRef, useState } from 'react'
import {
  ArrowRight,
  ChartBar,
  Check,
  ClockCounterClockwise,
  Command,
  Desktop,
  DeviceMobile,
  FileCode,
  FolderOpen,
  GearSix,
  HardDrives,
  Keyboard,
  Lightning,
  MagnifyingGlass,
  PuzzlePiece,
  Repeat,
  StopCircle,
  UserCircle,
} from '@phosphor-icons/react'
import { useConsole } from './state/console.jsx'
import { useKeyboard, isMac } from './keyboard.jsx'
import { ACTIONS, comboFromEvent, comboLabel, rankMatches } from './shortcuts.js'
import { activeSessions } from './archive.js'
import { hasFileChanges } from './changes.js'
import { planJob, requestJob } from './chat-to-job.js'
import { openChanges } from './ChangesModal.jsx'
import {
  elsewhereAside,
  namedChats,
  runningLabel,
  stopQuestion,
  stopSummary,
  stopTargets,
  stoppingLine,
} from './stop-everything.js'
import {
  HARNESS_EMPTY_LINE,
  HARNESS_PICK_LINE,
  HARNESS_STOP_NAME,
  harnessQuestion,
  harnessStopSub,
  harnessStopping,
  harnessStops,
  harnessSummary,
} from './stop-harness.js'
import { sessionGone } from './api/daemon.js'
import { harnessName } from './harness-names.js'
import { HarnessMark } from './brand-marks.jsx'
import { isPhone } from './cloud.js'
import { chatStatus } from './state/reducer.js'
import { loadSeen, recordSeen, storeSeen } from './unread.js'
import { movedLine, sinceLastLook, whatHappened, whenLabel } from './since-last-look.js'
import './keyboard.css'

const VIEW_ICONS = {
  'view-settings': <GearSix size={15} />,
  'view-automations': <Lightning size={15} />,
  'view-plugins': <PuzzlePiece size={15} />,
  'view-machines': <HardDrives size={15} />,
  'view-account': <UserCircle size={15} />,
  'view-mobile': <DeviceMobile size={15} />,
  'view-metrics': <ChartBar size={15} />,
}

// The lists an action opens inside the palette, and what each is called.
const PAGES = [
  { kind: 'model', name: 'Switch model…' },
  { kind: 'effort', name: 'Set effort…' },
  { kind: 'permission', name: 'Set permission…' },
]

const SECTION_ORDER = ['Actions', 'Chats', 'Views', 'Projects', 'Machines']
const SECTION_CAP = 8

// The pages with no keyboard source behind them, so the crumb has a name.
const PAGE_TITLES = { since: 'Since your last look' }

const projectLabel = (p) => p.folders[0].split(/[\\/]/).filter(Boolean).pop()

export default function CommandPalette({ recentChatIds, onClose, onOpenChat, onOpenProject, onOpenMachine, onRace, raceFree }) {
  // One line on purpose: the stop-everything wiring test reads this call to
  // prove the palette stops chats through the action a single chat already
  // uses. The two new names sit before `stopChat`, which stays last.
  const { sessions, chats, archived, projects, devices, thisDevice, capabilities, machines, stopChat } = useConsole()
  const kb = useKeyboard()
  const [query, setQuery] = useState('')
  const [page, setPage] = useState(null)
  const [cursor, setCursor] = useState(0)
  // Stop everything: the plan the question was built from (so the numbers
  // in it cannot move under the user between the ask and the press), the
  // phase, and the sentence that settles it.
  const [stopPlan, setStopPlan] = useState(null)
  const [stopPhase, setStopPhase] = useState(null)
  const [stopResult, setStopResult] = useState(null)
  // One harness's chats: the harness being confirmed, the plan it was built
  // from (pinned for the same reason), the phase, and the sentence that
  // settles it.
  const [harnessStopId, setHarnessStopId] = useState(null)
  const [harnessPlan, setHarnessPlan] = useState(null)
  const [harnessPhase, setHarnessPhase] = useState(null)
  const [harnessResult, setHarnessResult] = useState(null)
  const listRef = useRef(null)
  const inputRef = useRef(null)

  // What moved while nobody was reading: unread.js owns the record of what has
  // been seen, so this reads it once per palette and hands the same map to the
  // page that marks a chat read.
  const [seen, setSeen] = useState(() => loadSeen())
  // The poll, in the shape the unread rules read: the sidebar's own status
  // words and the activity stamp, one row per chat that is not archived.
  const moveRows = useMemo(
    () =>
      activeSessions(sessions ?? [], archived).map((session) => ({
        id: session.id,
        title: session.title ?? 'A new task',
        harness: session.harness,
        updatedAt: session.updated_at ?? 0,
        status: chatStatus(session.status),
      })),
    [sessions, archived],
  )
  const moved = useMemo(() => sinceLastLook(moveRows, seen), [moveRows, seen])

  // Everything the palette can offer right now, as rows.
  const everything = useMemo(() => {
    const keys = (id) => comboLabel(kb.bindings[id], isMac)
    const actions = ACTIONS.filter((a) => a.id !== 'palette' && kb.available(a.id)).map((a) => ({
      key: `action:${a.id}`,
      section: a.id.startsWith('view-') ? 'Views' : 'Actions',
      name: a.label,
      icon: VIEW_ICONS[a.id] ?? (a.id === 'cheat-sheet' ? <Keyboard size={15} /> : <Command size={15} />),
      keys: keys(a.id),
      run: { action: a.id },
    }))
    const pages = PAGES.filter((p) => (kb.source(p.kind)?.items ?? []).length > 0).map((p) => ({
      key: `page:${p.kind}`,
      section: 'Actions',
      name: p.name,
      icon: <ArrowRight size={15} />,
      run: { page: p.kind },
    }))
    // The chat on screen: the shell writes the address on every navigation,
    // and the palette gets no prop about the view, so the address is the
    // only honest answer to "this chat". A review of a chat the user cannot
    // see would be a lie, so the row appears only when the address names a
    // chat this window holds and that chat has file changes to read.
    const onScreen = typeof location === 'undefined' ? '' : location.hash.replace(/^#/, '')
    const reviewChat = chats?.[onScreen] ?? null
    const review = reviewChat && hasFileChanges(reviewChat.timeline)
      ? [
          {
            key: 'action:changes',
            section: 'Actions',
            name: 'Changes in this chat',
            icon: <FileCode size={15} />,
            run: { changes: reviewChat.id },
          },
        ]
      : []
    const chatRows = activeSessions(sessions ?? [], archived).map((s) => ({
      key: `chat:${s.id}`,
      section: 'Chats',
      name: s.title ?? 'A new task',
      sub: harnessName(s.harness),
      icon: <HarnessMark harness={s.harness} size={15} />,
      veiled: true,
      run: { chat: s.id },
    }))
    const projectRows = (projects ?? []).map((p) => ({
      key: `project:${p.id}`,
      section: 'Projects',
      name: projectLabel(p),
      sub: p.folders[0],
      subVeiled: true,
      icon: <FolderOpen size={15} />,
      veiled: true,
      run: { project: p.id },
    }))
    const machines = (devices ?? [])
      .filter((d) => !isPhone(d))
      .map((d) => ({
        key: `machine:${d.id}`,
        section: 'Machines',
        name: d.name,
        sub: d.id === thisDevice ? 'This computer' : d.online ? 'Online' : 'Offline',
        icon: d.kind === 'machine' ? <HardDrives size={15} /> : <Desktop size={15} />,
        veiled: true,
        run: { machine: d.id },
      }))
    // The one command that ends every running chat. Offered only while
    // something is running: a command that would end nothing is noise in
    // a list that is searched by name.
    const targets = stopTargets(sessions ?? [], { thisDevice })
    const stopRow = targets.running.length
      ? [
          {
            key: 'action:stop-all',
            section: 'Actions',
            name: 'Stop all running chats',
            sub: runningLabel(targets.running.length),
            icon: <StopCircle size={15} />,
            run: { stopAll: true },
          },
        ]
      : []
    // The same command narrowed to one harness. Only harnesses this computer
    // can actually stop are listed, and the page is not offered when that
    // list is empty: a page of nothing is noise next to the command that
    // would have said the same thing in one row.
    const harnessRows = harnessStops(sessions ?? [], { thisDevice })
    const harnessRow = harnessRows.length
      ? [
          {
            key: 'action:stop-harness',
            section: 'Actions',
            name: HARNESS_STOP_NAME,
            sub: harnessStopSub(harnessRows),
            icon: <StopCircle size={15} />,
            run: { stopHarnessPage: true },
          },
        ]
      : []
    // The chat on screen as a rule. chat-to-job.js decides whether the chat
    // can seed one at all: with no first task, no harness a rule could name,
    // no machine online or no workspace to carry, the row is not offered
    // rather than opening the editor on a hole.
    const job = planJob(reviewChat, {
      harnesses: capabilities?.harnesses ?? [],
      machines: machines ?? [],
      projects: projects ?? [],
    })
    const jobRow = job.offer
      ? [
          {
            key: 'action:chat-job',
            section: 'Actions',
            name: 'Turn this chat into a recurring job',
            icon: <Repeat size={15} />,
            run: { job: job.draft },
          },
        ]
      : []
    // One prompt into several harnesses at once: the console's own thesis as an
    // action. A race opens a pane per harness, so a window with fewer than two
    // free says why in the row's own words instead of offering a start the
    // modal would have to refuse.
    const raceShort = (raceFree ?? 0) < 2
    const raceRow = [
      {
        key: 'action:race',
        section: 'Actions',
        name: 'Race a prompt across harnesses',
        ...(raceShort ? { sub: 'No free pane' } : {}),
        icon: <Repeat size={15} />,
        run: { race: true },
      },
    ]
    // The page of what moved, offered only while something did: a command that
    // opens an empty page costs a keystroke to learn nothing.
    const sinceRow = moved.length
      ? [
          {
            key: 'action:since',
            section: 'Actions',
            name: 'Since your last look',
            sub: movedLine(moved.length),
            icon: <ClockCounterClockwise size={15} />,
            run: { since: true },
          },
        ]
      : []
    return {
      actions: [...stopRow, ...harnessRow, ...raceRow, ...sinceRow, ...review, ...jobRow, ...pages, ...actions],
      chats: chatRows,
      projectRows,
      machines,
      harnessRows,
    }
  }, [kb, sessions, chats, archived, projects, devices, thisDevice, capabilities, machines, raceFree, moved])

  const sections = useMemo(() => {
    if (page === 'since') {
      // A record, not a queue: the chats are in the order the module put them,
      // newest activity first, and each row says what happened last and when.
      const rows = moved.map((row) => ({
        key: `since:${row.id}`,
        section: 'Chats',
        name: row.title,
        sub: [whatHappened(row.status), whenLabel(row.updatedAt)].filter(Boolean).join(' · '),
        icon: <HarnessMark harness={row.harness} size={15} />,
        veiled: true,
        run: { sinceChat: { id: row.id, stamp: row.updatedAt } },
      }))
      const shown = query.trim() ? rankMatches(query, rows, (r) => r.name) : rows
      return shown.length ? [{ label: 'Chats', items: shown }] : []
    }
    if (page === 'stop-all') {
      // The question lives above this list; these are the two answers. The
      // safe one comes first, so the Enter that muscle memory sends keeps
      // the work rather than ending it.
      if (stopPhase === 'stopping') return []
      if (stopPhase === 'done') {
        return [
          {
            label: 'Stop everything',
            items: [{ key: 'stop:close', section: 'Stop everything', name: 'Close', run: { stopClose: true } }],
          },
        ]
      }
      return [
        {
          label: 'Stop everything',
          items: [
            { key: 'stop:keep', section: 'Stop everything', name: 'Keep them running', run: { stopKeep: true } },
            { key: 'stop:stop', section: 'Stop everything', name: 'Stop them', run: { stopGo: true } },
          ],
        },
      ]
    }
    if (page === 'stop-harness') {
      const label = HARNESS_STOP_NAME
      // While the stops land: nothing to answer, the question above says what
      // is happening. After: one way out, so the palette never closes under a
      // sentence nobody has read.
      if (harnessPhase === 'stopping') return []
      if (harnessPhase === 'done') {
        return [
          {
            label,
            items: [{ key: 'harness-stop:close', section: label, name: 'Close', run: { harnessClose: true } }],
          },
        ]
      }
      if (harnessStopId && harnessPlan) {
        // The confirm's two answers. The safe one is first for the same
        // reason stop-all puts it first: the Enter muscle memory sends keeps
        // the work.
        return [
          {
            label,
            items: [
              { key: 'harness-stop:keep', section: label, name: 'Keep them running', run: { harnessKeep: true } },
              { key: 'harness-stop:stop', section: label, name: 'Stop them', run: { harnessGo: true } },
            ],
          },
        ]
      }
      // The pick: one row per harness this computer can stop, biggest first,
      // each with what a press would end.
      return everything.harnessRows.length
        ? [
            {
              label,
              items: everything.harnessRows.map((row) => ({
                key: `harness-stop:${row.id}`,
                section: label,
                name: row.name,
                sub: runningLabel(row.count),
                icon: <HarnessMark harness={row.id} size={15} />,
                run: { harnessPick: row.id },
              })),
            },
          ]
        : []
    }
    if (page) {
      const src = kb.source(page) ?? { items: [] }
      const rows = src.items.map((item) => ({
        key: `pick:${item.id}`,
        section: src.title,
        name: item.name,
        icon: item.icon ?? null,
        selected: item.id === src.selectedId,
        run: { pick: item.id },
      }))
      const shown = query.trim() ? rankMatches(query, rows, (r) => r.name) : rows
      return shown.length ? [{ label: src.title, items: shown }] : []
    }
    if (!query.trim()) {
      const byId = new Map(everything.chats.map((c) => [c.run.chat, c]))
      const recent = recentChatIds.map((id) => byId.get(id)).filter(Boolean).slice(0, 5)
      // The review belongs in the suggestions when there is something to
      // review: it is the one action on this list the user cannot reach
      // anywhere else yet.
      const suggested = [
        'action:new-chat',
        'action:changes',
        'page:model',
        'action:view-settings',
        'action:cheat-sheet',
      ]
        .map((k) => everything.actions.find((a) => a.key === k))
        .filter(Boolean)
      return [
        ...(recent.length ? [{ label: 'Recent', items: recent }] : []),
        ...(suggested.length ? [{ label: 'Suggestions', items: suggested }] : []),
      ]
    }
    const all = [...everything.actions, ...everything.chats, ...everything.projectRows, ...everything.machines]
    const ranked = rankMatches(query, all, (r) => r.name)
    return SECTION_ORDER.map((label) => ({
      label,
      items: ranked.filter((r) => r.section === label).slice(0, SECTION_CAP),
    })).filter((s) => s.items.length)
  }, [page, query, everything, recentChatIds, kb, stopPhase, moved, harnessStopId, harnessPhase])

  const flat = sections.flatMap((s) => s.items)

  useEffect(() => setCursor(0), [query, page])
  useEffect(() => {
    listRef.current?.querySelector('.kb-item.cursor')?.scrollIntoView({ block: 'nearest' })
  }, [cursor])

  // The stop itself, per chat, through the action a single chat already
  // uses (`stopChat` calls the daemon's own stop route; no new route, no
  // mesh call). A chat that is already gone is skipped rather than failed:
  // the daemon answers 404 for a session it no longer has, which means the
  // work this command was about has ended anyway. Both stops count the same
  // way, so this is one loop, not two.
  const stopChats = async (chats) => {
    let stopped = 0
    let gone = 0
    let failed = 0
    for (const chat of chats) {
      try {
        await stopChat(chat.id)
        stopped += 1
      } catch (err) {
        if (sessionGone(err)) gone += 1
        else failed += 1
      }
    }
    return { stopped, gone, failed }
  }

  const runStopAll = async () => {
    const plan = stopPlan
    if (!plan) return
    setStopPhase('stopping')
    const counts = await stopChats(plan.stoppable)
    setStopResult(stopSummary({ ...counts, elsewhere: plan.elsewhere.length }))
    setStopPhase('done')
  }

  // The same loop over one harness's chats, with the sentence that names it.
  const runStopHarness = async () => {
    const plan = harnessPlan
    const name = harnessName(harnessStopId)
    if (!plan || !harnessStopId) return
    setHarnessPhase('stopping')
    const counts = await stopChats(plan.stoppable)
    setHarnessResult(harnessSummary({ name, ...counts, elsewhere: plan.elsewhere.length }))
    setHarnessPhase('done')
  }

  const choose = (row) => {
    if (!row) return
    const r = row.run
    if (r.since) {
      // A page, like the stop-everything question: the list is the point, so
      // opening it stays inside the palette rather than closing to show it.
      setPage('since')
      setQuery('')
      inputRef.current?.focus()
      return
    }
    if (r.sinceChat) {
      // Looking at the chat is the look: record it with unread.js's own rule,
      // so the sidebar's mark and this page cannot disagree about what read
      // means. The record never goes backwards, and storage is the same one
      // the sidebar writes.
      const next = recordSeen(seen, r.sinceChat.id, r.sinceChat.stamp)
      if (next !== seen) {
        setSeen(next)
        storeSeen(next)
      }
    }
    if (r.stopAll) {
      // The question is asked inside the palette, on the numbers the list
      // shows: closing to ask elsewhere would lose the count and the names
      // the user is deciding on. With nothing stoppable, the command skips
      // the question and says what kept running.
      const targets = stopTargets(sessions ?? [], { thisDevice })
      setStopPlan(targets)
      setStopResult(
        targets.stoppable.length === 0 ? stopSummary({ stopped: 0, elsewhere: targets.elsewhere.length }) : null,
      )
      setStopPhase(targets.stoppable.length === 0 ? 'done' : 'asking')
      setPage('stop-all')
      setQuery('')
      inputRef.current?.focus()
      return
    }
    if (r.stopKeep) {
      back()
      return
    }
    if (r.stopGo) {
      runStopAll()
      return
    }
    if (r.stopClose) {
      onClose()
      return
    }
    if (r.stopHarnessPage) {
      // The page opens inside the palette, like stop-everything's question:
      // the list of harnesses is the point, and closing to show it would lose
      // the search the person already typed.
      setPage('stop-harness')
      setHarnessStopId(null)
      setHarnessPlan(null)
      setHarnessPhase(null)
      setHarnessResult(null)
      setQuery('')
      inputRef.current?.focus()
      return
    }
    if (r.harnessPick) {
      // Choosing a harness asks one question about that harness, on the plan
      // the list was showing (so the count cannot move between the ask and
      // the press). A harness whose chats all ended in the meantime answers
      // with what happened instead of asking about nothing.
      const picked = harnessStops(sessions ?? [], { thisDevice }).find((row) => row.id === r.harnessPick)
      const name = picked?.name ?? harnessName(r.harnessPick)
      const plan = stopTargets((sessions ?? []).filter((s) => s.harness === r.harnessPick), { thisDevice })
      setHarnessStopId(r.harnessPick)
      setHarnessPlan(plan)
      setHarnessResult(
        plan.stoppable.length === 0 ? harnessSummary({ name, elsewhere: plan.elsewhere.length }) : null,
      )
      setHarnessPhase(plan.stoppable.length === 0 ? 'done' : 'asking')
      setQuery('')
      return
    }
    if (r.harnessKeep) {
      // One step back, to the harness list: the question here is about one
      // harness, and someone who says no to it may want another one.
      setHarnessStopId(null)
      setHarnessPlan(null)
      setHarnessPhase(null)
      setHarnessResult(null)
      setQuery('')
      return
    }
    if (r.harnessGo) {
      runStopHarness()
      return
    }
    if (r.harnessClose) {
      onClose()
      return
    }
    if (r.page) {
      setPage(r.page)
      setQuery('')
      inputRef.current?.focus()
      return
    }
    if (r.pick !== undefined) {
      kb.source(page)?.choose(r.pick)
      onClose()
      return
    }
    onClose()
    // After the palette is gone, so focus and anchors land on the app. The
    // rule editor lives in the Automations view, so the draft is staged for
    // it first and the shell is asked for that view second: the view picks
    // the draft up as it mounts.
    requestAnimationFrame(() => {
      if (r.action) kb.run(r.action)
      else if (r.changes) openChanges(r.changes)
      else if (r.race) onRace?.()
      else if (r.sinceChat) onOpenChat(r.sinceChat.id)
      else if (r.job) {
        requestJob(r.job)
        kb.run('view-automations')
      } else if (r.chat) onOpenChat(r.chat)
      else if (r.project) onOpenProject(r.project)
      else if (r.machine) onOpenMachine(r.machine)
    })
  }

  const back = () => {
    setPage(null)
    setQuery('')
  }

  // Esc and the palette's own key answer from anywhere inside the dialog: Tab
  // moves focus onto a row, and the key the footer promises for leaving has to
  // keep working there. Arrows, Enter and Backspace stay with the search
  // field, so a focused row keeps its own native Enter.
  const onKeyDown = (e) => {
    if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      if (page) back()
      else onClose()
      return
    }
    if (comboFromEvent(e, isMac) === kb.bindings.palette) {
      // The palette's own key closes it again.
      e.preventDefault()
      onClose()
      return
    }
    if (e.target !== inputRef.current) return
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setCursor((c) => (flat.length ? (c + 1) % flat.length : 0))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setCursor((c) => (flat.length ? (c - 1 + flat.length) % flat.length : 0))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      choose(flat[cursor])
    } else if (e.key === 'Backspace' && !query && page) {
      e.preventDefault()
      back()
    }
  }

  let index = -1
  const stopNames = stopPlan ? namedChats(stopPlan.stoppable) : null
  return (
    <div
      className="kb-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div className="kb-palette" role="dialog" aria-modal="true" aria-label="Command palette" onKeyDown={onKeyDown}>
        <div className="kb-search">
          <MagnifyingGlass size={15} />
          {page && <span className="kb-crumb">{kb.source(page)?.title ?? PAGE_TITLES[page]}</span>}
          <input
            ref={inputRef}
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={page ? 'Search' : 'Type a command or search'}
            spellCheck={false}
            role="combobox"
            aria-expanded="true"
            aria-controls="kb-list"
          />
        </div>
        <div className="kb-list" id="kb-list" role="listbox" ref={listRef}>
          {page === 'since' && (
            // The count as a sentence: what the page is about, said in words
            // rather than worn as a badge.
            <div className="kb-stop">
              <p className="kb-stop-question" role="status">
                {movedLine(moved.length) || 'Nothing has moved since your last look.'}
              </p>
            </div>
          )}
          {page === 'stop-all' && (
            <div className="kb-stop">
              {stopPhase === 'asking' && stopPlan && stopNames && (
                <>
                  <p className="kb-stop-question">{stopQuestion(stopPlan.stoppable.length)}</p>
                  <div className="kb-stop-names">
                    {stopNames.rows.map((row) => (
                      <div className="kb-stop-name pv" key={row.id}>
                        {row.name}
                      </div>
                    ))}
                    {stopNames.more > 0 && <div className="kb-stop-more">and {stopNames.more} more</div>}
                  </div>
                  {stopPlan.elsewhere.length > 0 && (
                    <p className="kb-stop-aside">{elsewhereAside(stopPlan.elsewhere.length)}</p>
                  )}
                </>
              )}
              {stopPhase === 'stopping' && stopPlan && (
                <p className="kb-stop-question">{stoppingLine(stopPlan.stoppable.length)}</p>
              )}
              {stopPhase === 'done' && stopResult && (
                <p className="kb-stop-question" role="status">
                  {stopResult}
                </p>
              )}
            </div>
          )}
          {sections.map((section) => (
            <div key={section.label} className="kb-group">
              <div className="kb-group-label">{section.label}</div>
              {section.items.map((row) => {
                index += 1
                const i = index
                return (
                  <button
                    key={row.key}
                    type="button"
                    role="option"
                    aria-selected={i === cursor}
                    className={`kb-item${i === cursor ? ' cursor' : ''}`}
                    onMouseMove={() => i !== cursor && setCursor(i)}
                    onClick={() => choose(row)}
                  >
                    {row.icon && <span className="kb-icon">{row.icon}</span>}
                    <span className={row.veiled ? 'kb-name pv' : 'kb-name'}>{row.name}</span>
                    {row.sub && <span className={row.subVeiled ? 'kb-sub pv' : 'kb-sub'}>{row.sub}</span>}
                    {row.selected && <Check size={13} className="kb-check" />}
                    {row.keys && <kbd className="kb-keys">{row.keys}</kbd>}
                  </button>
                )
              })}
            </div>
          ))}
          {flat.length === 0 && page !== 'stop-all' && (
            <div className="kb-empty">
              {query.trim() ? `Nothing matches “${query.trim()}”.` : 'Nothing to show here yet.'}
            </div>
          )}
        </div>
        <div className="kb-foot">
          <span>
            <kbd>↑</kbd>
            <kbd>↓</kbd> move
          </span>
          <span>
            <kbd>Enter</kbd> {page ? 'choose' : 'open'}
          </span>
          <span>
            <kbd>Esc</kbd> {page ? 'back' : 'close'}
          </span>
        </div>
      </div>
    </div>
  )
}
