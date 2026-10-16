// What the daemon keeps for the browser on this device - its settings,
// the sites' remembered permissions, the bookmarks, the tabs to bring back
// - cached here for the app's lifetime. Settings > Browser and the browser
// itself share it, so a change in one shows in the other at once. It does
// nothing until one of them asks, so the app pays nothing for it at start
// (the browser's own code loads on first use).

import { useSyncExternalStore } from 'react'
import { sortBookmarks } from './browser-bookmarks.js'

// The settings this console names, and what each is until the user
// changes it (the daemon stores only changes):
//   search         a SEARCH_ENGINES key (browser-omnibox.js)
//   startup        'continue' (bring the tabs back) or 'new_tab'
//   bookmarks_bar  whether the bar shows on every page, not only new tabs
export const BROWSER_DEFAULTS = { search: 'google', startup: 'continue', bookmarks_bar: false }

let data = { loaded: false, settings: {}, permissions: {}, bookmarks: [], session: null, downloads: [] }
const listeners = new Set()

function set(change) {
  data = { ...data, ...change }
  for (const fn of listeners) fn()
}

export function getBrowserData() {
  return data
}

export function subscribeBrowserData(fn) {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

export function useBrowserData() {
  return useSyncExternalStore(subscribeBrowserData, getBrowserData)
}

export function browserSetting(settings, key) {
  const value = settings?.[key]
  return value === undefined || value === null ? BROWSER_DEFAULTS[key] : value
}

// Everything the daemon has for the browser, fetched again.
export async function loadBrowserData(api) {
  if (!api?.ready) return data
  try {
    const got = await api.call('GET', '/browser')
    set({
      loaded: true,
      settings: got?.settings ?? {},
      permissions: got?.permissions ?? {},
      bookmarks: sortBookmarks(got?.bookmarks ?? []),
      session: got?.session ?? null,
      downloads: Array.isArray(got?.downloads) ? got.downloads : [],
    })
  } catch {
    /* the cache stays as it was; the next ask tries again */
  }
  return data
}

// A setting changed: shown at once, then written (null puts it back to
// its default).
export async function setBrowserSetting(api, key, value) {
  set({ settings: { ...data.settings, [key]: value } })
  if (!api?.ready) return
  try {
    const settings = await api.call('POST', '/browser/settings', { [key]: value })
    if (settings && typeof settings === 'object') set({ settings })
  } catch {
    /* kept as shown; the next load says what the daemon holds */
  }
}

// A site's answer remembered (`allow` or `deny`), or forgotten (null), so
// the site asks again next time.
export async function setSitePermission(api, origin, kind, state) {
  const key = `${origin}|${kind}`
  const permissions = { ...data.permissions }
  if (state) permissions[key] = state
  else delete permissions[key]
  set({ permissions })
  if (!api?.ready) return
  try {
    const saved = await api.call('POST', '/browser/permissions', { origin, kind, state: state ?? null })
    if (saved && typeof saved === 'object') set({ permissions: saved })
  } catch {
    /* kept as shown */
  }
}

// A bookmark added or changed; answers the saved one (a new one gets its
// id and place from the daemon).
export async function saveBookmark(api, mark) {
  if (!api?.ready) return null
  try {
    const saved = await api.call('POST', '/browser/bookmarks', mark)
    if (saved?.id) set({ bookmarks: sortBookmarks([...data.bookmarks.filter((b) => b.id !== saved.id), saved]) })
    return saved ?? null
  } catch {
    return null
  }
}

export async function removeBookmark(api, id) {
  set({ bookmarks: data.bookmarks.filter((b) => b.id !== id) })
  if (!api?.ready) return
  try {
    await api.call('POST', `/browser/bookmarks/${encodeURIComponent(id)}/remove`, {})
  } catch {
    /* gone here; the next load says what the daemon holds */
  }
}

// The tabs open now, for the next start.
export async function saveBrowserSession(api, session) {
  if (!api?.ready) return
  set({ session })
  try {
    await api.call('POST', '/browser/session', session)
  } catch {
    /* the next change saves again */
  }
}

// "Clear browsing data": history from `since` on (all of it when null)
// lives in the daemon; cookies, site storage and the cache in the
// browser's own profile, which the shell clears whole.
export async function clearBrowsingData(api, { since = null, history = false, cookies = false, cache = false }) {
  const done = []
  if (history && api?.ready) {
    await api.call('POST', '/browser/history/clear', since == null ? {} : { since })
    done.push('history')
  }
  const kinds = [...(cookies ? ['cookies', 'storage'] : []), ...(cache ? ['cache'] : [])]
  if (kinds.length) {
    const { invoke } = await import('@tauri-apps/api/core')
    await invoke('browser_clear_data', { kinds })
    done.push(...kinds)
  }
  return done
}
