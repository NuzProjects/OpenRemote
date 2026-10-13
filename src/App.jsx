import { useEffect, useRef, useState } from 'react'
import Sidebar from './Sidebar.jsx'
import TitleBar from './TitleBar.jsx'
import NewChat from './NewChat.jsx'
import ChatView from './ChatView.jsx'
import CloudMode from './CloudMode.jsx'
import Onboarding from './Onboarding.jsx'
import SettingsView from './SettingsView.jsx'
import PluginsView from './PluginsView.jsx'
import AutomationsView from './AutomationsView.jsx'
import MachinesView from './MachinesView.jsx'
import { ConsoleProvider, useConsole } from './state/console.jsx'
import { needsSignIn } from './cloud.js'
import CloudNotices from './CloudNotices.jsx'
import { isMobile } from './platform.js'
import { hashWriteReady } from './settings.js'
import { Archive, ArrowDown, ArrowLeft, ArrowRight, ArrowUp, Copy, X } from '@phosphor-icons/react'
import { pushBack, useBack } from './use-back.js'
import SplitArea from './SplitArea.jsx'
import ContextMenu from './ContextMenu.jsx'
import {
  MAX_PANES,
  closeLeaf,
  focusLeaf,
  leafById,
  leaves,
  newLayout,
  paneCount,
  restoreLayout,
  secondaryChatIds,
  setLeafView,
  splitLeaf,
} from './split.js'


const OB_KEY = 'openremote-onboarded'
const STORE_KEY = 'openremote-view-state'
const MODE_KEY = 'openremote-mode'
const SPLIT_KEY = 'openremote-split-layout'
const STATIC_VIEWS = ['new', 'plugins', 'automations', 'machines', 'settings']

// The mode the user left the app in. Local unless they chose Cloud, so a
// first launch never asks anyone to sign in. A phone runs no chats of its
// own, so it is always in Cloud.
function loadMode() {
  if (isMobile) return 'cloud'
  try {
    return localStorage.getItem(MODE_KEY) === 'cloud' ? 'cloud' : 'local'
  } catch {
    return 'local'
  }
}

function loadViewState(sessions) {
  let saved = null
  try {
    saved = JSON.parse(sessionStorage.getItem(STORE_KEY) ?? 'null')
  } catch {
    saved = null
  }
  const known = new Set([...STATIC_VIEWS, ...sessions.map((s) => s.id)])
  const hashView = location.hash.replace(/^#/, '')
  const fromHash = known.has(hashView) ? hashView : null
  let history
  let hIndex
  if (saved?.history?.some((v) => known.has(v))) {
    history = saved.history.filter((v) => known.has(v))
    hIndex = Math.min(saved.hIndex ?? 0, history.length - 1)
  } else {
    history = ['new']
    hIndex = 0
  }
  if (fromHash && history[hIndex] !== fromHash) {
    history = [...history.slice(0, hIndex + 1), fromHash]
    hIndex = history.length - 1
  }
  return { history, hIndex }
}

function loadLayout() {
  try {
    return restoreLayout(JSON.parse(sessionStorage.getItem(SPLIT_KEY) ?? 'null'))
  } catch {
    return newLayout()
  }
}

const isChatView = (v) => !STATIC_VIEWS.includes(v)

function Shell() {
  const { sessions, chats, connection, ensureChat, cloud, watchChats, setChatArchived } = useConsole()
  // The sidebar's docked-vs-overlay shape is the viewport's, not a mount-time
  // guess: crossing 640px live swaps the layout (the alternative - reading
  // innerWidth once at mount - left the sidebar overlaid after narrowing).
  const [sidebarOpen, setSidebarOpen] = useState(() =>
    typeof window === 'undefined' ? true : window.matchMedia('(min-width: 640px)').matches,
  )
  useEffect(() => {
    if (typeof window === 'undefined') return
    const mq = window.matchMedia('(min-width: 640px)')
    const onChange = (e) => setSidebarOpen(e.matches)
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [])
  // The startup preference plants the last view in the hash before first
  // paint (restoreBootPrefs in settings.js). A static seed validates
  // right here, but a chat id cannot - the session list is empty until
  // the first poll beat - so the seed is held as state until a beat
  // answers or the user navigates. The [sessions] reconcile below
  // consumes the seeded hash once a beat lands, and the hash-write
  // effect holds off until then (hashWriteReady). Null when the boot
  // hash is empty or static: nothing needs holding.
  const [bootSeed, setBootSeed] = useState(() => {
    const bootHash = location.hash.replace(/^#/, '')
    return bootHash && !STATIC_VIEWS.includes(bootHash) ? bootHash : null
  })
  // The sessions list the shell mounted with (the console's initial
  // empty one): any later identity is a beat's answer, and that answer
  // is the hold's release.
  const mountSessionsRef = useRef(sessions)
  const [sessionsAnswered, setSessionsAnswered] = useState(false)
  const [{ history, hIndex }, setNav] = useState(() => loadViewState([]))
  // Split panes: more chats beside the primary view, Local and Cloud alike.
  // The primary pane follows the history above; the others hold their own.
  const [layout, setLayout] = useState(loadLayout)
  useEffect(() => {
    try {
      sessionStorage.setItem(SPLIT_KEY, JSON.stringify(layout))
    } catch {
      /* storage unavailable */
    }
  }, [layout])
  // The tour sets up this computer's harnesses; a phone has none, and
  // Cloud's sign-in screen is its welcome.
  const [onboarded, setOnboarded] = useState(() => {
    if (isMobile) return true
    try {
      return localStorage.getItem(OB_KEY) === '1'
    } catch {
      return true
    }
  })
  // Settings is a view like the others - the gear navigates to it.
  // Local vs Cloud: Local is this computer's chats; Cloud is the synced
  // chats of every device, behind a moreweb sign-in the first time.
  const [mode, setMode] = useState(loadMode)
  // The sidebar's + : opens New chat with the Add project flow engaged -
  // the same picker the home screen's own button opens.
  const [addProjectOpen, setAddProjectOpen] = useState(false)

  // Each mode has its own views; one restored from history that belongs to
  // the other mode opens New chat instead.
  const OTHER_MODE = { local: ['machines'], cloud: ['plugins', 'automations'] }
  const stored = history[hIndex]
  const view = OTHER_MODE[mode].includes(stored) ? 'new' : stored
  const chat = STATIC_VIEWS.includes(view) ? null : chats[view] ?? null

  // Ctrl+\ splits the focused pane to the right, Ctrl+Shift+\ downward.
  useEffect(() => {
    if (isMobile || !onboarded) return
    const onKey = (e) => {
      if (!e.ctrlKey || e.altKey || e.metaKey || (e.key !== '\\' && e.key !== '|')) return
      e.preventDefault()
      setLayout((l) => splitLeaf(l, l.focus, e.shiftKey ? 'col' : 'row'))
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onboarded])

  // Every chat on screen streams live - the primary's and each pane's -
  // but only one that still exists. A chat deleted on another device
  // loses its record on the poll beat that drops it, so it leaves the
  // watched set here (its pane shows the fallback) and no stream keeps
  // asking the daemon for a session it no longer has.
  const watchKey = [
    ...(isChatView(view) && chats[view] ? [view] : []),
    ...secondaryChatIds(layout, isChatView).filter((id) => chats[id]),
  ].join(',')
  useEffect(() => {
    watchChats(watchKey ? watchKey.split(',') : [])
  }, [watchKey, watchChats])

  // Reconcile navigation with the live session list (a chat in the history
  // that no longer exists falls back to New chat). A chat reached by hash
  // still needs its record - ensure it, the same as a sidebar open.
  useEffect(() => {
    // The first beat's answer (a new sessions identity - the mount-time
    // list is the console's initial empty one, not an answer) marks the
    // session list as loaded. This run reads the still-seeded hash
    // against the real list, which is the seed's consumption; from here
    // the hash-write effect may run again (hashWriteReady).
    if (sessions !== mountSessionsRef.current) setSessionsAnswered(true)
    const state = loadViewState(sessions)
    setNav(state)
    const view = state.history[state.hIndex]
    const session = (sessions ?? []).find((s) => s.id === view)
    if (session) ensureChat(session)
    // Panes restored from the last visit need their records too.
    for (const id of secondaryChatIds(layout, isChatView)) {
      const s = (sessions ?? []).find((x) => x.id === id)
      if (s) ensureChat(s)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessions])

  useEffect(() => {
    try {
      sessionStorage.setItem(STORE_KEY, JSON.stringify({ history, hIndex }))
    } catch {
      /* storage unavailable */
    }
  }, [history, hIndex])

  useEffect(() => {
    // This effect runs on mount, and its replaceState would clobber a
    // boot-seeded chat id to #new before any session beat arrived to
    // validate it (the [sessions] reconcile above is the hash's only
    // reader), stamping 'new' over the last-view record too. So it
    // holds until the seed is resolved: a beat answered, or no seed is
    // pending (never planted, or the user navigated). The rule lives in
    // hashWriteReady so it is tested.
    if (!hashWriteReady({ sessionsLoaded: sessionsAnswered, seedConsumed: bootSeed === null }))
      return
    // Keep the entry's state: on a phone it is a back step.
    window.history.replaceState(window.history.state, '', `#${view}`)
    // The last view the user was on, for the startup preference's
    // restore path. Written only once onboarding is done - the tour's
    // own views are not the user's last view.
    if (onboarded) {
      try {
        localStorage.setItem('openremote-last-view', view)
      } catch {
        /* storage unavailable */
      }
    }
  }, [view, onboarded, sessionsAnswered, bootSeed])

  const navigate = (id) => {
    // The user's click supersedes the boot seed - release the hash hold
    // so the write effect reflects where they chose to go. Even a click
    // landing on the current view is their intent.
    setBootSeed(null)
    if (id === view) return
    setNav((nav) => ({
      history: [...nav.history.slice(0, nav.hIndex + 1), id],
      hIndex: nav.hIndex + 1,
    }))
    // Android's back button returns to the view before.
    if (isMobile) pushBack(goBack)
  }

  const switchMode = (next) => {
    setMode(next)
    try {
      localStorage.setItem(MODE_KEY, next)
    } catch {
      /* storage unavailable */
    }
    // With panes open the layout is the user's own; the primary view only
    // falls back when it belongs to the other mode (see `view` above).
    if (paneCount(layout) === 1) navigate('new')
  }

  function goBack() {
    // Back and forward are the user's navigation too - the seed gives way.
    setBootSeed(null)
    setNav((nav) => ({ ...nav, hIndex: Math.max(0, nav.hIndex - 1) }))
  }
  const goForward = () => {
    setBootSeed(null)
    setNav((nav) => ({ ...nav, hIndex: Math.min(nav.history.length - 1, nav.hIndex + 1) }))
  }

  // Opening a chat from the sidebar: make sure its record exists even
  // before the next session poll.
  const openSession = (id) => {
    const session = (sessions ?? []).find((s) => s.id === id)
    if (session) ensureChat(session)
    navigate(id)
    if (typeof window !== 'undefined' && !window.matchMedia('(min-width: 640px)').matches)
      setSidebarOpen(false)
  }

  // The sidebar's click goes where the user is looking: the focused pane
  // when that is a split pane and the target is a chat or New chat; every
  // other view (plugins, settings, ...) belongs to the primary pane.
  const focused = leafById(layout, layout.focus)
  const openInFocus = (id) => {
    if (focused?.view !== null && (id === 'new' || isChatView(id))) {
      const session = (sessions ?? []).find((s) => s.id === id)
      if (session) ensureChat(session)
      setLayout((l) => setLeafView(l, focused.id, id))
      return
    }
    setLayout((l) => focusLeaf(l, leaves(l.root).find((p) => p.view === null).id))
    openSession(id)
  }

  // Open a chat in a new pane beside the focused one.
  const openBeside = (id, dir = 'row', before = false) => {
    const session = (sessions ?? []).find((s) => s.id === id)
    if (session) ensureChat(session)
    const next = splitLeaf(layout, layout.focus, dir, id, before)
    if (next === layout) openInFocus(id)
    else setLayout(next)
  }

  // Right-click in the main area: split from the pane under the cursor,
  // and act on the chat it shows. Text, links and fields keep the
  // browser's own menu (copy, paste, spelling).
  const [paneMenu, setPaneMenu] = useState(null)
  const onMainContextMenu = (e) => {
    if (isMobile) return
    const t = e.target
    if (t.closest?.('input, textarea, select, a, [contenteditable="true"], .ctx-menu, .nc-menu')) return
    if (window.getSelection()?.toString()) return
    const leafId = t.closest?.('[data-leaf-id]')?.dataset.leafId ?? layout.focus
    e.preventDefault()
    setLayout((l) => focusLeaf(l, leafId))
    setPaneMenu({ x: e.clientX, y: e.clientY, leafId })
  }

  const archiveFrom = (leaf, id) => {
    setChatArchived(id, true)
    if (leaf.view === null) navigate('new')
    else setLayout((l) => setLeafView(l, leaf.id, 'new'))
  }

  const paneMenuItems = (leafId) => {
    const leaf = leafById(layout, leafId)
    if (!leaf) return []
    const v = leaf.view ?? view
    const full = paneCount(layout) >= MAX_PANES
    const split = (dir, before) => () => setLayout((l) => splitLeaf(l, leafId, dir, 'new', before))
    const items = [
      { header: full ? 'New chat split (4 panes is the most)' : 'New chat split' },
      { label: 'To the left', icon: <ArrowLeft size={14} />, disabled: full, onSelect: split('row', true) },
      { label: 'To the right', icon: <ArrowRight size={14} />, disabled: full, onSelect: split('row', false) },
      { label: 'Above', icon: <ArrowUp size={14} />, disabled: full, onSelect: split('col', true) },
      { label: 'Below', icon: <ArrowDown size={14} />, disabled: full, onSelect: split('col', false) },
    ]
    const title = chats[v]?.title
    if (isChatView(v) && title) {
      items.push(
        { divider: true },
        { label: 'Archive chat', icon: <Archive size={14} />, onSelect: () => archiveFrom(leaf, v) },
        {
          label: 'Copy chat title',
          icon: <Copy size={14} />,
          onSelect: () => navigator.clipboard?.writeText(title).catch(() => {}),
        },
      )
    }
    if (leaf.view !== null) {
      items.push(
        { divider: true },
        { label: 'Close pane', icon: <X size={14} />, onSelect: () => setLayout((l) => closeLeaf(l, leafId)) },
      )
    }
    return items
  }

  // The sidebar's + : New chat, with the Add project flow engaged.
  const addProject = () => {
    setAddProjectOpen(true)
    navigate('new')
    if (typeof window !== 'undefined' && !window.matchMedia('(min-width: 640px)').matches)
      setSidebarOpen(false)
  }

  const finishOnboarding = () => {
    try {
      localStorage.setItem(OB_KEY, '1')
    } catch {
      /* storage unavailable */
    }
    setOnboarded(true)
  }

  const replayOnboarding = () => {
    try {
      localStorage.removeItem(OB_KEY)
    } catch {
      /* storage unavailable */
    }
    setOnboarded(false)
  }

  // On a phone the sidebar is a drawer over the page; back closes it.
  const [narrow, setNarrow] = useState(
    () => typeof window !== 'undefined' && !window.matchMedia('(min-width: 640px)').matches,
  )
  useEffect(() => {
    if (typeof window === 'undefined') return
    const mq = window.matchMedia('(min-width: 640px)')
    const onChange = (e) => setNarrow(!e.matches)
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [])
  useBack(narrow && sidebarOpen, () => setSidebarOpen(false))

  // What the primary pane shows: the view the app's navigation points at.
  const primaryContent = (
    view === 'settings' ? (
    <SettingsView onReplay={replayOnboarding} onOpenChat={openSession} />
  ) : mode === 'cloud' && needsSignIn(cloud) ? (
    <CloudMode onBackToLocal={isMobile ? null : () => switchMode('local')} />
  ) : (
    <>
      {view === 'new' && (
        <NewChat
          onOpen={openSession}
          mode={mode}
          addProjectOpen={addProjectOpen}
          onAddProjectDone={() => setAddProjectOpen(false)}
        />
      )}
      {view === 'machines' && <MachinesView onOpenChat={openSession} />}
      {view === 'plugins' && <PluginsView />}
      {view === 'automations' && <AutomationsView onOpenChat={openSession} />}
      {!STATIC_VIEWS.includes(view) &&
        (chat ? (
          <ChatView key={chat.id} chat={chat} />
        ) : (
          <div className="cv-none">That chat is no longer in this workspace.</div>
        ))}
    </>
    )
  )

  const paneLabel = (leaf) => {
    const v = leaf.view ?? view
    if (v === 'new') return 'New chat'
    if (STATIC_VIEWS.includes(v)) return v[0].toUpperCase() + v.slice(1)
    return chats[v]?.title ?? 'Chat'
  }

  // A split pane holds a chat or a New chat composer; the same chats and
  // composers serve Local and Cloud, so one window mixes both.
  const renderPane = (leaf) => {
    if (leaf.view === null) return primaryContent
    if (leaf.view === 'new') {
      return (
        <NewChat
          onOpen={(id) => setLayout((l) => setLeafView(l, leaf.id, id))}
          mode={mode}
        />
      )
    }
    const paneChat = chats[leaf.view]
    return paneChat ? (
      <ChatView key={paneChat.id} chat={paneChat} />
    ) : (
      <div className="cv-none">That chat is no longer in this workspace.</div>
    )
  }

  const body = () => (
    <>
      {/* The frameless window has no OS chrome - the titlebar (drag,
          minimize, maximize, close) renders on every screen, onboarding
          included. */}
      <TitleBar
        sidebarOpen={sidebarOpen}
        onToggleSidebar={onboarded ? () => setSidebarOpen((v) => !v) : undefined}
        onBack={goBack}
        onForward={goForward}
        canBack={onboarded && hIndex > 0}
        canForward={onboarded && hIndex < history.length - 1}
        onSplit={onboarded ? () => setLayout((l) => splitLeaf(l, l.focus, 'row')) : undefined}
      />
      {!onboarded ? (
        <div className="app-body">
          <Onboarding onDone={finishOnboarding} />
        </div>
      ) : (
        <div className="app-body">
          {sidebarOpen && <div className="sb-backdrop" onClick={() => setSidebarOpen(false)} />}
          <Sidebar
            open={sidebarOpen}
            active={(focused?.view ?? view) === 'new' ? null : (focused?.view ?? view)}
            mode={mode}
            onMode={switchMode}
            onSelect={openInFocus}
            onSplit={openBeside}
            onAddProject={addProject}
          />
          <main className="main" onContextMenu={onMainContextMenu}>
            <CloudNotices />
            {paneCount(layout) > 1 ? (
              <SplitArea
                layout={layout}
                setLayout={setLayout}
                labelFor={paneLabel}
                renderPane={renderPane}
              />
            ) : (
              primaryContent
            )}
          </main>
          {paneMenu && (
            <ContextMenu
              x={paneMenu.x}
              y={paneMenu.y}
              items={paneMenuItems(paneMenu.leafId)}
              onClose={() => setPaneMenu(null)}
            />
          )}
        </div>
      )}
    </>
  )

  return body()
}

export default function App() {
  return (
    <ConsoleProvider>
      <div className="app">
        <Shell />
      </div>
    </ConsoleProvider>
  )
}
