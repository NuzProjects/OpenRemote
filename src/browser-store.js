// The built-in browser's tabs, downloads and find results, kept for the
// app's lifetime in a plain module (not the view's), so the view can come
// and go - and be edited in development - without losing them. The shell
// owns the pages; this keeps what the console knows about them and hears
// the shell's `browser:*` events.

import { hasTauri } from './platform.js'
import { closeTab, insertAfter, newTab } from './browser-tabs.js'

// `asks` are sites' permission requests waiting for an answer; `pending` is
// an address something outside the browser asked it to open.
let state = (() => {
  const first = newTab()
  return { tabs: [first], active: first.key, closed: [], downloads: [], finds: {}, asks: [], pending: null }
})()
const listeners = new Set()
const keyHandlers = new Set()
// What the shell said about a page before its tab knew its id.
const early = new Map()

export function getState() {
  return state
}

export function setState(change) {
  state = { ...state, ...change(state) }
  for (const fn of listeners) fn()
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

// Give a console tab its page, with anything the page already said.
export function adopt(key, native) {
  const said = early.get(native) ?? {}
  early.delete(native)
  patchTab(key, { native, ...said })
}

// What a shell may say about a tab beyond the basics (the phone's shell
// says all of these): copied only when said, so a shell that says less
// never blanks what the console keeps.
const EXTRA = ['progress', 'opener', 'controller', 'private', 'shared', 'fullscreen', 'desktop', 'crashed', 'live', 'problem', 'isolated']

function fieldsOf(p) {
  const fields = {
    url: p.url,
    title: p.title,
    loading: p.loading,
    favicon: p.favicon,
    canBack: p.can_back,
    canForward: p.can_forward,
  }
  for (const key of EXTRA) if (p[key] !== undefined) fields[key] = p[key]
  return fields
}

// Something outside the browser (a link in a chat) wants an address opened
// in it: the browser's view opens it in a new tab when it shows.
export function openInBrowser(url) {
  setState(() => ({ pending: url }))
}

// The tab showing the shell's page `native`, made the one the browser shows.
export function focusNative(native) {
  setState((s) => {
    const tab = s.tabs.find((t) => t.native === native)
    return tab ? { active: tab.key } : {}
  })
}

async function wire() {
  const { listen } = await import('@tauri-apps/api/event')
  listen('browser:tab', ({ payload: p }) => {
    setState((s) => {
      const fields = fieldsOf(p)
      if (s.tabs.some((t) => t.native === p.id)) {
        return { tabs: s.tabs.map((t) => (t.native === p.id ? { ...t, ...fields } : t)) }
      }
      // A page opened a window: a new tab beside its opener, shown.
      const opener = s.tabs.find((t) => t.native && t.native === p.opener)
      if (!opener && p.controller) {
        // An agent opened it: it joins the tabs without taking the view.
        return { tabs: [...s.tabs, newTab({ native: p.id, ...fields })] }
      }
      if (!opener) {
        // A tab still opening: a fast page can finish loading before the
        // console hears which tab it is. Kept until it does (adopt).
        early.set(p.id, fields)
        return {}
      }
      const tab = newTab({ native: p.id, ...fields })
      return { tabs: insertAfter(s.tabs, tab, opener.key), active: tab.key }
    })
  })
  listen('browser:download', ({ payload: d }) => {
    setState((s) => {
      const known = s.downloads.find((x) => x.id === d.id)
      const rest = s.downloads.filter((x) => x.id !== d.id)
      return { downloads: [{ ...known, ...d, path: d.path ?? known?.path }, ...rest].slice(0, 50) }
    })
  })
  listen('browser:find', ({ payload: f }) => {
    setState((s) => ({ finds: { ...s.finds, [f.tab]: { count: f.count, active: f.active } } }))
  })
  listen('browser:key', ({ payload }) => {
    for (const fn of keyHandlers) fn(payload.chord)
  })
  // The shell closed a tab itself (a page closed its window, an agent
  // closed it): its place goes the way a closed tab's does.
  listen('browser:closed', ({ payload }) => {
    early.delete(payload.id)
    setState((s) => {
      const tab = s.tabs.find((t) => t.native === payload.id)
      if (!tab) return {}
      const next = closeTab(s.tabs, tab.key, s.active)
      const url = next.closed?.private ? null : next.closed?.url
      return {
        tabs: next.tabs,
        active: next.active,
        closed: url ? [url, ...s.closed].slice(0, 25) : s.closed,
        asks: s.asks.filter((a) => a.tab !== payload.id),
      }
    })
  })
  // An agent asked for one of its tabs to be the one shown.
  listen('browser:select', ({ payload }) => focusNative(payload.id))
  // A site's request (camera, location...), or its end.
  listen('browser:permission', ({ payload: a }) => {
    setState((s) => {
      const rest = s.asks.filter((x) => x.id !== a.id)
      return { asks: a.gone ? rest : [...rest, a] }
    })
  })
  // The console reloaded while the shell kept its pages (a development
  // reload, a crash of the console's page): take them back, hidden until
  // the view shows one, rather than leave them on screen, orphaned.
  const open = await call('browser_tabs')
  if (open?.length) {
    for (const t of open) await call('browser_hide', { tab: t.id })
    const tabs = open.map((t) => newTab({ native: t.id, ...fieldsOf(t) }))
    setState(() => ({ tabs, active: tabs[0].key }))
  }
}

if (hasTauri) wire()

// Editing this module in development reloads the console (the restore
// above then takes the pages back) instead of starting a second tab list.
if (import.meta.hot) import.meta.hot.decline()
