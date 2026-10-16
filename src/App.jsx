import { Suspense, lazy, useEffect, useRef, useState } from 'react'
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
import AccountView from './AccountView.jsx'
import MobileView from './MobileView.jsx'
import MetricsView from './MetricsView.jsx'
// Loaded on first use: the browser costs nothing until it is opened.
const BrowserView = lazy(() => import('./BrowserView.jsx'))
import { ConsoleProvider, useConsole } from './state/console.jsx'
import { needsSignIn } from './cloud.js'
import CloudNotices from './CloudNotices.jsx'
import { hasTauri, isMobile } from './platform.js'
import { onBrowserRequest, openedKey, shouldAutoOpen } from './browser-placement.js'
import { hashWriteReady } from './settings.js'
import { Archive, ArrowDown, ArrowLeft, ArrowRight, ArrowUp, Copy, X } from '@phosphor-icons/react'
import { pushBack, useBack } from './use-back.js'
import SplitArea from './SplitArea.jsx'
import ContextMenu from './ContextMenu.jsx'
import CommandPalette from './CommandPalette.jsx'
import ShortcutSheet from './ShortcutSheet.jsx'
import ViewPopup from './ViewPopup.jsx'
import { POPUP_VIEWS, onPopup } from './popups.js'
import { KeyboardProvider, useKeyboard, useShortcut } from './keyboard.jsx'
import {
  BROWSER,
  MAX_PANES,
  browserPane,
  closeLeaf,
  focusLeaf,
  leafById,
  leaves,
  newLayout,
  openBrowserBeside,
  paneCount,
  restoreLayout,
  secondaryChatIds,
  setLeafView,
  singleBrowser,
  splitLeaf,
} from './split.js'
import { onBesideRequest } from './team-placement.js'


const OB_KEY = 'openremote-onboarded'
const STORE_KEY = 'openremote-view-state'
const MODE_KEY = 'openremote-mode'
const SPLIT_KEY = 'openremote-split-layout'
const STATIC_VIEWS = ['new', 'plugins', 'automations', 'machines', 'settings', 'account', 'mobile', 'metrics', 'browser']

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
  // the other mode opens New chat instead. Plugins and automations act on
  // this computer, so the desktop keeps them in Cloud too; a phone runs no
  // chats, so it has neither.
  const OTHER_MODE = { local: ['machines'], cloud: isMobile ? ['plugins', 'automations'] : [] }
  const stored = history[hIndex]
  // Settings, Metrics and Mobile open over the app (popups.js), never in
  // a pane; one left in the history from before opens New chat.
  const view = OTHER_MODE[mode].includes(stored) || POPUP_VIEWS.includes(stored) ? 'new' : stored
  const chat = STATIC_VIEWS.includes(view) ? null : chats[view] ?? null

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

  const keepMode = (next) => {
    setMode(next)
    try {
      localStorage.setItem(MODE_KEY, next)
    } catch {
      /* storage unavailable */
    }
  }

  const switchMode = (next) => {
    keepMode(next)
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
    // One pane holds the browser: where a split pane has it, that pane
    // takes focus instead of the main pane opening a second.
    const holder = id === BROWSER ? browserPane(layout, view) : null
    if (holder) {
      setLayout((l) => focusLeaf(l, holder.id))
      return
    }
    if (focused?.view !== null && (id === 'new' || isChatView(id))) {
      const session = (sessions ?? []).find((s) => s.id === id)
      if (session) ensureChat(session)
      setLayout((l) => setLeafView(l, focused.id, id))
      return
    }
    setLayout((l) => focusLeaf(l, leaves(l.root).find((p) => p.view === null).id))
    openSession(id)
  }

  // The browser keeps to one pane: going to it in the main pane (Back
  // and Forward included) closes a split pane that held it.
  useEffect(() => {
    setLayout((l) => singleBrowser(l, view))
  }, [view])

  // A chat asks for the browser - its Browser button, an "Open beside
  // chat" chip, the phone's pill, or its agent opening a tab (`focus`
  // false): beside that chat on the desktop (the pane that holds the
  // browser, if one does), the Browser view on the phone. With four panes
  // already open a click shows it in the main pane (Back returns); the
  // agent's own tab never takes the chat's place.
  const browserRequest = useRef(null)
  browserRequest.current = ({ chatId, url = null, tab = null, focus = true }) => {
    if (url || tab) {
      import('./browser-store.js').then((store) => (url ? store.openUrl(url) : store.focusTab(tab)))
    }
    if (isMobile) {
      navigate(BROWSER)
      return
    }
    const chatLeaf = leaves(layout.root).find((l) => (l.view ?? view) === chatId) ?? focused
    let next = openBrowserBeside(layout, chatLeaf.id, view)
    if (next === layout && !browserPane(layout, view)) {
      if (!focus) return
      focusPrimary()
      navigate(BROWSER)
      return
    }
    // The agent opening a tab never takes the keyboard from the chat.
    if (!focus) next = focusLeaf(next, chatLeaf.id)
    setLayout(next)
  }
  useEffect(() => onBrowserRequest((request) => browserRequest.current?.(request)), [])

  // The agent of the chat in the main pane opening a tab opens the browser
  // beside it, showing that tab; another chat's agent never steals the
  // view (its tab carries its badge in the browser instead).
  const primaryChat = useRef(null)
  primaryChat.current = isChatView(view) ? view : null
  useEffect(() => {
    if (!hasTauri || isMobile) return undefined
    const opened = new Set()
    let stop = null
    let gone = false
    import('@tauri-apps/api/event')
      .then(({ listen }) =>
        listen('browser:tab', ({ payload }) => {
          if (!shouldAutoOpen(payload, primaryChat.current, opened)) return
          opened.add(openedKey(payload))
          browserRequest.current?.({ chatId: payload.controller.chat, tab: payload.id, focus: false })
        }),
      )
      .then((unlisten) => {
        if (gone) unlisten()
        else stop = unlisten
      })
      .catch(() => {})
    return () => {
      gone = true
      stop?.()
    }
  }, [])

  // Open a chat in a new pane beside the focused one.
  const openBeside = (id, dir = 'row', before = false) => {
    const session = (sessions ?? []).find((s) => s.id === id)
    if (session) ensureChat(session)
    const next = splitLeaf(layout, layout.focus, dir, id, before)
    if (next === layout) openInFocus(id)
    else setLayout(next)
  }

  // A chat asks to show another beside it - a lead's team bar opening a
  // worker, a worker's "Started by" chip going back to its lead: in the
  // pane that already shows it, else in a new one beside the asking chat's
  // pane (the main view where there are no panes, as on the phone).
  const besideRequest = useRef(null)
  besideRequest.current = ({ from, chat }) => {
    const session = (sessions ?? []).find((s) => s.id === chat)
    if (!session) return
    ensureChat(session)
    const holder = leaves(layout.root).find((l) => (l.view ?? view) === chat)
    if (holder) {
      setLayout((l) => focusLeaf(l, holder.id))
      return
    }
    if (isMobile) {
      openInFocus(chat)
      return
    }
    const origin = leaves(layout.root).find((l) => (l.view ?? view) === from) ?? focused
    const next = splitLeaf(layout, origin.id, 'row', chat)
    if (next === layout) openInFocus(chat)
    else setLayout(next)
  }
  useEffect(() => onBesideRequest((request) => besideRequest.current?.(request)), [])

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
      { label: 'To the right', icon: <ArrowRight size={14} />, hint: kb.label('split-right'), disabled: full, onSelect: split('row', false) },
      { label: 'Above', icon: <ArrowUp size={14} />, disabled: full, onSelect: split('col', true) },
      { label: 'Below', icon: <ArrowDown size={14} />, hint: kb.label('split-down'), disabled: full, onSelect: split('col', false) },
    ]
    const title = chats[v]?.title
    if (isChatView(v) && title) {
      items.push(
        { divider: true },
        { label: 'Archive chat', icon: <Archive size={14} />, hint: kb.label('archive'), onSelect: () => archiveFrom(leaf, v) },
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
        { label: 'Close pane', icon: <X size={14} />, hint: kb.label('close-pane'), onSelect: () => setLayout((l) => closeLeaf(l, leafId)) },
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

  // Account's devices row crosses to Machines, which is Cloud's view -
  // the crossover switches the mode too, so the button never lands dead.
  const openMachines = () => {
    if (mode !== 'cloud') switchMode('cloud')
    navigate('machines')
  }

  // Keyboard actions the shell owns (keyboard.jsx): navigation, views,
  // the focused chat's archive, and the layout. A view that belongs to
  // the other mode switches the mode on the way, like Account's
  // crossover to Machines.
  const kb = useKeyboard()
  const desk = onboarded && !isMobile
  const [palette, setPalette] = useState(false)
  // The view open over the app, if any: settings, metrics or mobile.
  const [popup, setPopup] = useState(null)
  useEffect(() => onPopup((name) => setPopup(name)), [])
  const [sheet, setSheet] = useState(false)
  const [presetProject, setPresetProject] = useState(null)
  const [openDevice, setOpenDevice] = useState(null)
  const goView = (id) => {
    if (POPUP_VIEWS.includes(id)) {
      setPopup(id)
      return
    }
    // Machines is Cloud's; plugins and automations live in both modes.
    const needs = { machines: 'cloud' }[id]
    if (needs && mode !== needs) keepMode(needs)
    openInFocus(id)
  }
  // A new chat already in a project (the sidebar's + on a project, the
  // palette's project rows): the home screen with that project chosen and
  // its message box focused.
  const newChatIn = (id) => {
    setPresetProject({ id, nonce: Date.now() })
    focusPrimary()
    navigate('new')
    if (typeof window !== 'undefined' && !window.matchMedia('(min-width: 640px)').matches)
      setSidebarOpen(false)
  }
  const focusPrimary = () =>
    setLayout((l) => focusLeaf(l, leaves(l.root).find((p) => p.view === null).id))
  useShortcut('new-chat', () => openInFocus('new'), desk)
  useShortcut('palette', () => setPalette(true), desk)
  useShortcut('cheat-sheet', () => setSheet(true), desk)
  useShortcut('view-settings', () => goView('settings'), desk)
  useShortcut('view-automations', () => goView('automations'), desk)
  useShortcut('view-plugins', () => goView('plugins'), desk)
  useShortcut('view-machines', () => goView('machines'), desk)
  useShortcut('view-account', () => goView('account'), desk)
  useShortcut('view-mobile', () => goView('mobile'), desk)
  useShortcut('view-metrics', () => goView('metrics'), desk)
  useShortcut(
    'archive',
    () => {
      const v = focused?.view ?? view
      if (!focused || !isChatView(v) || !chats[v]) return false
      archiveFrom(focused, v)
    },
    desk,
  )
  useShortcut('toggle-sidebar', () => setSidebarOpen((v) => !v), desk)
  useShortcut('toggle-mode', () => switchMode(mode === 'local' ? 'cloud' : 'local'), desk)
  useShortcut('split-right', () => setLayout((l) => splitLeaf(l, l.focus, 'row')), desk)
  useShortcut('split-down', () => setLayout((l) => splitLeaf(l, l.focus, 'col')), desk)
  // The primary pane is the window's own view; only a split pane closes.
  useShortcut(
    'close-pane',
    () => {
      if (!focused || focused.view === null) return false
      setLayout((l) => closeLeaf(l, focused.id))
    },
    desk,
  )
  // The palette's recent chats: the navigation history, newest first.
  const recentChatIds = [...new Set([...history].reverse().filter(isChatView))]
  const primaryFocused = focused?.view === null

  // What the primary pane shows: the view the app's navigation points at.
  // The footer's views - settings, account, mobile, metrics - render
  // before Cloud's sign-in door: each carries its own signed-out state,
  // so its icon never lands somewhere else.
  const primaryContent = (
    view === 'settings' ? (
    <SettingsView onReplay={replayOnboarding} onOpenChat={openSession} />
  ) : view === 'account' ? (
    <AccountView onOpenMachines={openMachines} />
  ) : view === 'mobile' ? (
    <MobileView onOpenChat={openSession} />
  ) : view === 'metrics' ? (
    <MetricsView />
  ) : view === 'browser' ? (
    // The browser is this device's, in Local and Cloud alike.
    <Suspense fallback={null}>
      <BrowserView />
    </Suspense>
  ) : view === 'plugins' ? (
    // Plugins and automations are this computer's: no Cloud sign-in needed.
    <PluginsView />
  ) : view === 'automations' ? (
    <AutomationsView onOpenChat={openSession} />
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
          presetProject={presetProject}
          focused={primaryFocused}
          onOpenPlugins={() => goView('plugins')}
        />
      )}
      {view === 'machines' && <MachinesView onOpenChat={openSession} openDevice={openDevice} />}
      {!STATIC_VIEWS.includes(view) &&
        (chat ? (
          <ChatView key={chat.id} chat={chat} focused={primaryFocused} />
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
    if (leaf.view === BROWSER) {
      // The browser beside a chat: the same view the sidebar opens, lazy
      // the same way.
      return (
        <Suspense fallback={null}>
          <BrowserView />
        </Suspense>
      )
    }
    if (leaf.view === 'new') {
      return (
        <NewChat
          onOpen={(id) => setLayout((l) => setLeafView(l, leaf.id, id))}
          mode={mode}
          focused={leaf.id === layout.focus}
        />
      )
    }
    const paneChat = chats[leaf.view]
    return paneChat ? (
      <ChatView key={paneChat.id} chat={paneChat} focused={leaf.id === layout.focus} />
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
            active={popup ?? ((focused?.view ?? view) === 'new' ? null : (focused?.view ?? view))}
            mode={mode}
            onMode={switchMode}
            onSelect={(id) => (POPUP_VIEWS.includes(id) ? setPopup(id) : openInFocus(id))}
            onSplit={openBeside}
            onAddProject={addProject}
            onNewChatIn={newChatIn}
            onReveal={() => setSidebarOpen(true)}
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
          {palette && (
            <CommandPalette
              recentChatIds={recentChatIds}
              onClose={() => setPalette(false)}
              onOpenChat={openInFocus}
              onOpenProject={newChatIn}
              onOpenMachine={(id) => {
                setOpenDevice({ id, nonce: Date.now() })
                goView('machines')
              }}
            />
          )}
          {sheet && <ShortcutSheet onClose={() => setSheet(false)} />}
          {popup && (
            <ViewPopup
              label={{ settings: 'Settings', metrics: 'Metrics', mobile: 'Mobile' }[popup]}
              onClose={() => setPopup(null)}
            >
              {popup === 'settings' ? (
                <SettingsView
                  onReplay={() => {
                    setPopup(null)
                    replayOnboarding()
                  }}
                  onOpenChat={(id) => {
                    setPopup(null)
                    openSession(id)
                  }}
                />
              ) : popup === 'metrics' ? (
                <MetricsView />
              ) : (
                <MobileView
                  onOpenChat={(id) => {
                    setPopup(null)
                    openSession(id)
                  }}
                />
              )}
            </ViewPopup>
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
      <KeyboardProvider>
        <div className="app">
          <Shell />
        </div>
      </KeyboardProvider>
    </ConsoleProvider>
  )
}
