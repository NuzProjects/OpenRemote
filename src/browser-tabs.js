// The browser's tab list as the console keeps it: order, which tab is
// active, closing and reopening, what is saved for the next start and
// which pages to put away when too many are open. A tab is { key, native,
// url, title, loading, ... }: `native` is the shell's webview for it, null
// while the tab shows one of the browser's own pages or waits as an entry
// (restored, or put away) for its page to open. Pure: tested without a
// DOM.

import { internalPage } from './browser-omnibox.js'

let counter = 0

export function newTab(fields = {}) {
  counter += 1
  return { key: `t${Date.now().toString(36)}${counter}`, native: null, url: '', title: '', loading: false, ...fields }
}

// Close a tab: the one to its right becomes active (Chrome's way), else
// the one to its left. The last tab closing leaves a new tab page, so the
// browser is never empty.
export function closeTab(tabs, key, active) {
  const at = tabs.findIndex((t) => t.key === key)
  if (at === -1) return { tabs, active }
  const rest = tabs.filter((t) => t.key !== key)
  if (!rest.length) {
    const fresh = newTab()
    return { tabs: [fresh], active: fresh.key, closed: tabs[at] }
  }
  const next = active === key ? (rest[at] ?? rest[at - 1]).key : active
  return { tabs: rest, active: next, closed: tabs[at] }
}

// The next or previous tab, wrapping around.
export function cycle(tabs, active, step) {
  if (!tabs.length) return active
  const at = Math.max(0, tabs.findIndex((t) => t.key === active))
  return tabs[(at + step + tabs.length) % tabs.length].key
}

// Insert a tab right after another (a popup beside its opener), or at the
// end.
export function insertAfter(tabs, tab, afterKey) {
  const at = tabs.findIndex((t) => t.key === afterKey)
  if (at === -1) return [...tabs, tab]
  return [...tabs.slice(0, at + 1), tab, ...tabs.slice(at + 1)]
}

// The title a tab shows: the page's own, else its address, else "New tab".
export function tabTitle(tab) {
  if (tab.title) return tab.title
  if (tab.url && tab.url !== 'about:blank') return tab.url.replace(/^https?:\/\//, '')
  return 'New tab'
}

// A tab waiting for its page: it has a web address but no webview yet. (A
// tab showing another device's tab live has an address too, and no webview
// of its own to wait for.)
export function isDormant(tab) {
  return Boolean(tab?.url) && !tab.native && !tab.remote && !internalPage(tab.url)
}

// The tabs saved for the next start: every tab with an address, never a
// private one, and which of them was showing.
export function sessionOf(tabs, active) {
  const kept = tabs.filter((t) => !t.private && !t.remote && t.url && t.url !== 'about:blank')
  const at = kept.findIndex((t) => t.key === active)
  return { tabs: kept.map((t) => ({ url: t.url, title: t.title ?? '' })), active: Math.max(0, at) }
}

// A saved session as tabs again: entries with their address and title,
// which open their pages when first shown. Anything malformed is dropped.
export function restoredTabs(session) {
  const saved = Array.isArray(session?.tabs) ? session.tabs : []
  const tabs = saved
    .filter((t) => t && typeof t.url === 'string' && t.url && !/^javascript:/i.test(t.url))
    .map((t) => newTab({ url: t.url, title: typeof t.title === 'string' ? t.title : '' }))
  const at = Number.isInteger(session?.active) ? session.active : 0
  return { tabs, active: Math.min(Math.max(0, at), Math.max(0, tabs.length - 1)) }
}

// When more than `limit` pages are open, the ones to put away: the least
// recently shown first, never the tab on screen, one an agent holds, or a
// private one (putting it away would end its private session).
export function toDiscard(tabs, active, limit = 10) {
  const live = tabs.filter((t) => t.native)
  const extra = live.length - limit
  if (extra <= 0) return []
  return live
    .filter((t) => t.key !== active && !t.controller && !t.private)
    .sort((a, b) => (a.seen ?? 0) - (b.seen ?? 0))
    .slice(0, extra)
}
