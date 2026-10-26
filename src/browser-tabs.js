// The browser's tab list as the console keeps it: order, which tab is
// active, closing and reopening. A tab is { key, native, url, title,
// loading }: `native` is the shell's webview for it, null while the tab
// shows the new tab page. Pure: tested without a DOM.

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

// Whether a page that has just finished opening still has somewhere to be:
// a tab in the list that points at it and a browser pane still on screen.
// Both can go while the shell builds the page (a close, Ctrl+W, the pane's
// X). A page that lands anyway has no tab strip to close it with and floats
// over the console, so it is closed instead of shown.
export function openBelongs(tabs, key, mounted) {
  return Boolean(mounted) && tabs.some((t) => t.key === key)
}

// Whether a page a tab opened (a popup, from a link with target=_blank or
// window.open) belongs to a tab this console has. The tab that opened it is
// what places the new one, so a popup whose opener is not in the list has
// nowhere to land: it would stay in the shell's tab list with no console tab,
// and come back as a stray tab on the next console load.
export function popupBelongs(tabs, opener) {
  return tabs.some((t) => t.native && t.native === opener)
}
