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
  UserCircle,
} from '@phosphor-icons/react'
import { useConsole } from './state/console.jsx'
import { useKeyboard, isMac } from './keyboard.jsx'
import { ACTIONS, comboFromEvent, comboLabel, rankMatches } from './shortcuts.js'
import { activeSessions } from './archive.js'
import { hasFileChanges } from './changes.js'
import { openChanges } from './ChangesModal.jsx'
import { harnessName } from './harness-names.js'
import { HarnessMark } from './brand-marks.jsx'
import { isPhone } from './cloud.js'
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

const projectLabel = (p) => p.folders[0].split(/[\\/]/).filter(Boolean).pop()

export default function CommandPalette({ recentChatIds, onClose, onOpenChat, onOpenProject, onOpenMachine }) {
  const { sessions, chats, archived, projects, devices, thisDevice } = useConsole()
  const kb = useKeyboard()
  const [query, setQuery] = useState('')
  const [page, setPage] = useState(null)
  const [cursor, setCursor] = useState(0)
  const listRef = useRef(null)
  const inputRef = useRef(null)

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
    return { actions: [...review, ...pages, ...actions], chats: chatRows, projectRows, machines }
  }, [kb, sessions, chats, archived, projects, devices, thisDevice])

  const sections = useMemo(() => {
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
  }, [page, query, everything, recentChatIds, kb])

  const flat = sections.flatMap((s) => s.items)

  useEffect(() => setCursor(0), [query, page])
  useEffect(() => {
    listRef.current?.querySelector('.kb-item.cursor')?.scrollIntoView({ block: 'nearest' })
  }, [cursor])

  const choose = (row) => {
    if (!row) return
    const r = row.run
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
    // After the palette is gone, so focus and anchors land on the app.
    requestAnimationFrame(() => {
      if (r.action) kb.run(r.action)
      else if (r.changes) openChanges(r.changes)
      else if (r.chat) onOpenChat(r.chat)
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
          {page && <span className="kb-crumb">{kb.source(page)?.title}</span>}
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
          {flat.length === 0 && (
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
