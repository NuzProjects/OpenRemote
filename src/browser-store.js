// The built-in browser's tabs, downloads, find results and the sites'
// open requests, kept for the app's lifetime in a plain module (not the
// view's), so the view can come and go - and be edited in development -
// without losing them. The shell owns the pages; this keeps what the
// console knows about them and hears the shell's `browser:*` events. It
// also brings the last session's tabs back, saves the open ones for the
// next start, and puts pages away when too many are open.

import { hasTauri, isMobile } from './platform.js'
import { closeTab, insertAfter, newTab, restoredTabs, sessionOf, toDiscard } from './browser-tabs.js'
import { originOf } from './browser-chrome.js'
import { elementAttachment } from './browser-attach.js'
import { addAttachment, focusedComposer } from './attachments.js'
import {
  browserSetting,
  getBrowserData,
  loadBrowserData,
  saveBrowserSession,
  setSitePermission,
} from './browser-data.js'
import { recordFrame, startRecording, stopRecording, tabClosed } from './browser-record.js'

// Pages kept open at once. Past this the least recently shown are put away
// to entries that open again when shown: each open page holds memory, an
// entry holds an address.
const LIVE_LIMIT = 10
// A page the shell opened that no console tab claims within this long (an
// agent's, before its hold was marked) joins the strip in the background.
const ORPHAN_MS = 8000
const ICONS_KEY = 'openremote-browser-icons'
const ICONS_KEPT = 150
// Per run of the app (it survives development reloads, not restarts): the
// last session comes back once.
const RESTORED_KEY = 'openremote-browser-restored'

let state = (() => {
  const first = newTab()
  return {
    tabs: [first],
    active: first.key,
    closed: [],
    downloads: [],
    finds: {},
    prompts: [],
    picking: null,
    fullscreen: null,
    notice: null,
    icons: loadIcons(),
  }
})()
const listeners = new Set()
const keyHandlers = new Set()
// What the shell said about a page before its tab knew its id.
const early = new Map()
const orphans = new Map()
// Pages the console closed: a late event about one never brings it back.
const gone = new Set()

let api = null
// Nothing is saved until the last session has been brought back (or
// passed over), so a fresh start never writes over it.
let restoring = true
let lastSaved = ''
let saveTimer = 0
let iconsTimer = 0

export function getState() {
  return state
}

export function setState(change) {
  const before = state
  state = { ...state, ...change(state) }
  // The tab shown last is the one kept longest when pages are put away.
  if (state.active !== before.active) {
    const now = Date.now()
    state = { ...state, tabs: state.tabs.map((t) => (t.key === state.active ? { ...t, seen: now } : t)) }
  }
  for (const fn of listeners) fn()
  if (state.tabs !== before.tabs || state.active !== before.active) scheduleSave()
  if (state.icons !== before.icons) scheduleIcons()
}

export function subscribe(fn) {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

export function patchTab(key, change) {
  setState((s) => ({ tabs: s.tabs.map((t) => (t.key === key ? { ...t, ...change } : t)) }))
}

export async function call(command, args) {
  const { invoke } = await import('@tauri-apps/api/core')
  return invoke(command, args).catch(() => null)
}

// Browser keys pressed while a page had focus, for whoever handles them.
export function onKey(fn) {
  keyHandlers.add(fn)
  return () => keyHandlers.delete(fn)
}

// The daemon client, from the view (the store has no React of its own).
// The first one that can answer brings the last session back.
export function setApi(next) {
  api = next?.ready ? next : null
  if (api) startBrowser()
}

// ---- tabs ----

// Give a console tab its page, with anything the page already said. A tab
// added for that page meanwhile gives way to the one that opened it.
export function adopt(key, native) {
  const said = early.get(native) ?? {}
  early.delete(native)
  clearTimeout(orphans.get(native))
  orphans.delete(native)
  setState((s) => {
    const tabs = s.tabs
      .filter((t) => t.key === key || t.native !== native)
      .map((t) => (t.key === key ? { ...t, native, ...said } : t))
    return { tabs, active: tabs.some((t) => t.key === s.active) ? s.active : key }
  })
  enforceMemory()
}

// Show the console tab holding a page of the shell's ("tab-3"). For the
// app deciding to bring a tab forward, such as an agent's beside its chat.
export function focusTab(native) {
  const tab = state.tabs.find((t) => t.native === native)
  if (tab && state.active !== tab.key) setState(() => ({ active: tab.key }))
  return Boolean(tab)
}

// Close a tab (its page with it). Answers the page that closed, if any.
export function removeTab(key) {
  const tab = state.tabs.find((t) => t.key === key)
  if (!tab) return null
  if (tab.native) {
    gone.add(tab.native)
    call('browser_close', { tab: tab.native })
    tabClosed(tab.native)
  }
  setState((s) => {
    const next = closeTab(s.tabs, key, s.active)
    const last = next.closed
    // Private tabs leave no trace, the reopen list included.
    const closed =
      last?.url && !last.private ? [{ url: last.url, title: last.title ?? '' }, ...s.closed].slice(0, 25) : s.closed
    return {
      tabs: next.tabs,
      active: next.active,
      closed,
      prompts: tab.native ? s.prompts.filter((p) => p.tab !== tab.native) : s.prompts,
    }
  })
  return tab.native
}

// Over the limit of open pages: the least recently shown go back to
// entries (an agent's tab, a private one and the tab on screen never do).
export function enforceMemory() {
  const doomed = toDiscard(state.tabs, state.active, LIVE_LIMIT)
  if (!doomed.length) return
  for (const t of doomed) {
    gone.add(t.native)
    call('browser_close', { tab: t.native })
    tabClosed(t.native)
  }
  const keys = new Set(doomed.map((t) => t.key))
  setState((s) => ({
    tabs: s.tabs.map((t) =>
      keys.has(t.key) ? { ...t, native: null, loading: false, canBack: false, canForward: false, find: null } : t,
    ),
  }))
}

// ---- downloads, notices ----

export function addDownload(download) {
  setState((s) => ({ downloads: [download, ...s.downloads.filter((d) => d.id !== download.id)].slice(0, 50) }))
}

// The finished and failed ones leave the list; running ones stay.
export function clearDownloads() {
  setState((s) => ({ downloads: s.downloads.filter((d) => d.state === 'started') }))
}

let noticeTimer = 0
let noticeSeq = 0

// A short note in the toolbar ("Added to <chat>", "Saved to Downloads"),
// gone after a moment.
export function notify(notice) {
  noticeSeq += 1
  const id = noticeSeq
  setState(() => ({ notice: { ...notice, id } }))
  clearTimeout(noticeTimer)
  noticeTimer = setTimeout(
    () => setState((s) => (s.notice?.id === id ? { notice: null } : {})),
    notice.kind === 'error' ? 4500 : 2800,
  )
}

// ---- site permissions ----

export function dropPrompt(tab, id) {
  setState((s) => ({ prompts: s.prompts.filter((p) => !(p.tab === tab && p.id === id)) }))
}

// The user's answer to a site's request; remembered for the site when
// they asked for that.
export function answerPrompt(prompt, allow, remember) {
  call('browser_permission', { tab: prompt.tab, id: prompt.id, allow })
  dropPrompt(prompt.tab, prompt.id)
  if (remember) setSitePermission(api, prompt.origin, prompt.kind, allow ? 'allow' : 'deny')
}

async function onPermission(p) {
  // A private tab always asks, and nothing it answers is remembered.
  const isPrivate = state.tabs.some((t) => t.native === p.tab && t.private)
  if (!isPrivate) {
    if (!getBrowserData().loaded && api) await loadBrowserData(api)
    const remembered = getBrowserData().permissions[`${p.origin}|${p.kind}`]
    if (remembered === 'allow' || remembered === 'deny') {
      call('browser_permission', { tab: p.tab, id: p.id, allow: remembered === 'allow' })
      return
    }
  }
  setState((s) => ({
    prompts: [...s.prompts.filter((q) => !(q.tab === p.tab && q.id === p.id)), { ...p, private: isPrivate }],
  }))
  // The shell turns an unanswered request down after a minute; its bar
  // goes then too.
  setTimeout(() => dropPrompt(p.tab, p.id), 60_000)
}

// ---- recording ----

export function recordTab(native) {
  return startRecording(native, call, (result) => {
    if (result.error) {
      notify({ kind: 'error', text: result.error })
      return
    }
    addDownload({ id: `rec-${Date.now()}`, tab: native, url: '', path: result.path, state: 'done' })
    notify({ kind: 'saved', text: 'Recording saved to Downloads' })
  })
}

export { stopRecording }

// ---- the shell's events ----

// Only what the event says: a field the shell leaves out keeps what the
// console knows (a private tab stays private on a shell that doesn't say).
function fieldsOf(p) {
  return {
    url: p.url,
    title: p.title,
    loading: p.loading,
    favicon: p.favicon,
    canBack: p.can_back,
    canForward: p.can_forward,
    ...(p.controller !== undefined ? { controller: p.controller ?? null } : {}),
    ...(p.private !== undefined ? { private: Boolean(p.private) } : {}),
    ...(p.shared !== undefined ? { shared: Boolean(p.shared) } : {}),
  }
}

function withIcon(icons, url, icon) {
  const origin = originOf(url)
  if (!origin || !icon || icons[origin] === icon) return icons
  const next = { ...icons }
  delete next[origin]
  next[origin] = icon
  const keys = Object.keys(next)
  for (const old of keys.slice(0, Math.max(0, keys.length - ICONS_KEPT))) delete next[old]
  return next
}

function onTab(p) {
  if (gone.has(p.id)) return
  // A tab that joins the strip here, and whether it is the one shown.
  let joined = null
  setState((s) => {
    const fields = fieldsOf(p)
    const icons = withIcon(s.icons, p.url, p.favicon)
    let fullscreen = s.fullscreen
    if (p.fullscreen === true) fullscreen = p.id
    else if (p.fullscreen === false && s.fullscreen === p.id) fullscreen = null
    if (s.tabs.some((t) => t.native === p.id)) {
      return { tabs: s.tabs.map((t) => (t.native === p.id ? { ...t, ...fields } : t)), icons, fullscreen }
    }
    const opener = s.tabs.find((t) => t.native && t.native === p.opener)
    if (opener) {
      // A page opened a window: a new tab beside its opener, shown when
      // the user's own page opened it (an agent's popup never takes the
      // view).
      const tab = newTab({ native: p.id, ...fields })
      const show = opener.key === s.active && !p.controller
      joined = { show }
      return { tabs: insertAfter(s.tabs, tab, opener.key), active: show ? tab.key : s.active, icons }
    }
    if (p.controller && !p.opener) {
      // A tab an agent opened: in the strip, the user's view unmoved.
      const said = early.get(p.id)
      early.delete(p.id)
      clearTimeout(orphans.get(p.id))
      orphans.delete(p.id)
      joined = { show: false }
      return { tabs: [...s.tabs, newTab({ native: p.id, ...said, ...fields })], icons }
    }
    // A tab still opening: a fast page can finish loading before the
    // console hears which tab it is. Kept until it does (adopt).
    early.set(p.id, { ...early.get(p.id), ...fields })
    if (!orphans.has(p.id)) orphans.set(p.id, setTimeout(() => claimOrphan(p.id), ORPHAN_MS))
    return { icons, fullscreen }
  })
  if (joined) {
    // One that isn't shown stays out of sight until the user picks it.
    if (!joined.show) call('browser_hide', { tab: p.id })
    enforceMemory()
  }
}

// A page nobody claimed joins the strip in the background, if the shell
// still has it.
async function claimOrphan(id) {
  orphans.delete(id)
  if (!early.has(id) || gone.has(id) || state.tabs.some((t) => t.native === id)) return
  const open = await call('browser_tabs')
  const fields = early.get(id)
  early.delete(id)
  if (!fields || !open?.some((t) => t.id === id) || state.tabs.some((t) => t.native === id)) return
  setState((s) => ({ tabs: [...s.tabs, newTab({ native: id, ...fields })] }))
  call('browser_hide', { tab: id })
  enforceMemory()
}

function onPicked(p) {
  const item = elementAttachment(p.element, p.image)
  const composer = focusedComposer()
  addAttachment(item, composer)
  notify({ kind: 'attached', composer })
}

async function wire() {
  const { listen } = await import('@tauri-apps/api/event')
  listen('browser:tab', ({ payload }) => onTab(payload))
  listen('browser:download', ({ payload: d }) => {
    setState((s) => {
      const known = s.downloads.find((x) => String(x.id) === String(d.id))
      const rest = s.downloads.filter((x) => String(x.id) !== String(d.id))
      return { downloads: [{ ...known, ...d, path: d.path ?? known?.path }, ...rest].slice(0, 50) }
    })
  })
  listen('browser:find', ({ payload: f }) => {
    setState((s) => ({ finds: { ...s.finds, [f.tab]: { count: f.count, active: f.active } } }))
  })
  listen('browser:key', ({ payload }) => {
    for (const fn of keyHandlers) fn(payload.chord, payload.tab)
  })
  listen('browser:permission', ({ payload }) => onPermission(payload))
  listen('browser:fullscreen', ({ payload: p }) => {
    setState((s) => ({ fullscreen: p.on ? p.tab : s.fullscreen === p.tab ? null : s.fullscreen }))
  })
  listen('browser:picked', ({ payload }) => onPicked(payload))
  listen('browser:picking', ({ payload: p }) => {
    setState((s) => ({ picking: p.on ? p.tab : s.picking === p.tab ? null : s.picking }))
  })
  listen('browser:frame', ({ payload }) => recordFrame(payload))
  // The console reloaded while the shell kept its pages (a development
  // reload, a crash of the console's page): take them back, hidden until
  // the view shows one, rather than leave them on screen, orphaned.
  const open = await call('browser_tabs')
  if (open?.length) {
    tookBack = true
    for (const t of open) await call('browser_hide', { tab: t.id })
    const tabs = open.map((t) => newTab({ native: t.id, ...fieldsOf(t) }))
    setState(() => ({ tabs, active: tabs[0].key }))
  }
}

let tookBack = false
const wired = hasTauri && !isMobile ? wire() : Promise.resolve()

// ---- the session: brought back once, saved as it changes ----

let started = null

function startBrowser() {
  started ??= (async () => {
    await wired
    const data = await loadBrowserData(api)
    if (!data.loaded) {
      // The daemon didn't answer: nothing is restored or saved over yet;
      // the next client tries again.
      started = null
      return
    }
    mergeDownloads(data.downloads)
    let first = true
    try {
      first = sessionStorage.getItem(RESTORED_KEY) !== '1'
      sessionStorage.setItem(RESTORED_KEY, '1')
    } catch {
      /* storage unavailable: restore, as a fresh start would */
    }
    if (first && !tookBack && browserSetting(data.settings, 'startup') === 'continue') {
      const { tabs, active } = restoredTabs(data.session)
      if (tabs.length) {
        setState((s) => {
          // The empty tab the browser started with gives way; tabs that
          // opened meanwhile (an agent's, one the user is already in) stay.
          const kept = s.tabs.filter((t) => t.native || t.url)
          const busy = kept.some((t) => t.key === s.active)
          return { tabs: [...tabs, ...kept], active: busy ? s.active : tabs[active].key }
        })
      }
    }
    lastSaved = JSON.stringify(data.session ?? null)
    restoring = false
    scheduleSave()
  })()
  return started
}

function scheduleSave() {
  if (restoring || !api) return
  const session = sessionOf(state.tabs, state.active)
  const json = JSON.stringify(session)
  if (json === lastSaved) return
  clearTimeout(saveTimer)
  saveTimer = setTimeout(() => {
    lastSaved = json
    saveBrowserSession(api, session)
  }, 1000)
}

// The daemon's own list of this run's downloads (it outlives a console
// reload), joined with the console's.
function mergeDownloads(list) {
  const known = new Set(state.downloads.map((d) => String(d.id)))
  const missing = (list ?? []).filter((d) => d && !known.has(String(d.id)))
  if (missing.length) setState((s) => ({ downloads: [...s.downloads, ...missing].slice(0, 50) }))
}

// ---- site icons, kept across restarts ----

function loadIcons() {
  try {
    const raw = JSON.parse(localStorage.getItem(ICONS_KEY) ?? '{}')
    return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  } catch {
    return {}
  }
}

function scheduleIcons() {
  clearTimeout(iconsTimer)
  iconsTimer = setTimeout(() => {
    // A large icon stays for this run only; the small ones are kept.
    const small = Object.fromEntries(Object.entries(state.icons).filter(([, icon]) => icon.length <= 12000))
    try {
      localStorage.setItem(ICONS_KEY, JSON.stringify(small))
    } catch {
      /* storage full or unavailable: icons come back as pages load */
    }
  }, 2000)
}

// Editing this module in development reloads the console (the restore
// above then takes the pages back) instead of starting a second tab list.
if (import.meta.hot) import.meta.hot.decline()
