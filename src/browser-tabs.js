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

// ---- the closed tabs a window remembers ----
//
// A closed tab leaves its address and title, never its shell page: that page
// went with the close. Five is a short memory on purpose - it is the tab you
// just lost, not a history - and the list lives in the browser's store, one
// per window, so it never travels to another device.
//
// A tab that had nowhere to be (the new tab page, about:blank) leaves nothing:
// reopening it would ask the browser to restore nothing. Closing the same
// address twice keeps one entry, so one reopen is enough to get back to it.

export const CLOSED_CAP = 5

/// What a closing tab leaves for the list, or null when there is nothing to
/// reopen.
export function closedEntry(tab) {
  if (!tab || !tab.url || tab.url === 'about:blank') return null
  return { url: tab.url, title: tab.title || tab.url }
}

/// The list after a tab closes: newest first, capped, no repeated address.
export function rememberClosed(closed, tab) {
  const entry = closedEntry(tab)
  if (!entry) return closed
  const rest = (closed ?? []).filter((e) => e.url !== entry.url)
  return [entry, ...rest].slice(0, CLOSED_CAP)
}

/// What reopening does to the list: the newest entry, and the list behind it.
/// `null` when the list is empty (the command has nothing to do).
export function takeClosed(closed) {
  if (!closed?.length) return null
  return { entry: closed[0], rest: closed.slice(1) }
}

// ---- closing several at once ----
//
// Both commands work on the tab list in strip order, not on the tabs that
// happen to be visible at this width: a close that did less after a window
// resize would be the same command doing two different things. The visible
// strip is where the menu is asked, not what it is allowed to touch.

/// Every tab but the one asked from. One tab closes nothing.
export function closeOthers(tabs, key) {
  if (!tabs.some((t) => t.key === key)) return []
  return tabs.filter((t) => t.key !== key).map((t) => t.key)
}

/// Every tab after this one in strip order. The last tab closes nothing.
export function closeToRight(tabs, key) {
  const at = tabs.findIndex((t) => t.key === key)
  if (at === -1) return []
  return tabs.slice(at + 1).map((t) => t.key)
}

// ---- how much of the strip fits ----
//
// A tab keeps its width and is never squeezed to a sliver: what does not fit
// moves behind one overflow control, and the control's own width is reserved
// before the count is decided so it is never the thing that pushes the last
// tab out. These numbers are the CSS's own (.bw-tab width, .bw-tabs-scroll
// gap, .bw-tabs-more width); a change there has to come here too.

export const TAB_WIDTH = 200
export const TAB_GAP = 2
export const OVERFLOW_WIDTH = 56
/// The new-tab button sits at the end of the same strip, so its width is
/// reserved with the tabs: without it the last tab could cover the button.
export const NEW_TAB_WIDTH = 30

/// Which tabs the strip draws: a window of `shown` tabs starting at `start`,
/// always containing the active one, with `hidden` behind the control. An
/// unmeasured strip (width 0, the first paint) shows everything.
export function stripPlan({ width = 0, count = 0, active = 0, tabWidth = TAB_WIDTH, gap = TAB_GAP, control = OVERFLOW_WIDTH } = {}) {
  if (count <= 0) return { start: 0, shown: 0, hidden: 0 }
  if (width <= 0) return { start: 0, shown: count, hidden: 0 }
  const room = (n) => n * tabWidth + Math.max(0, n - 1) * gap + NEW_TAB_WIDTH
  let shown = 0
  if (room(count) <= width) {
    shown = count
  } else {
    for (let n = count - 1; n >= 1; n -= 1) {
      if (room(n) + gap + control <= width) {
        shown = n
        break
      }
    }
    // A strip too narrow for one tab and the control still shows one tab: the
    // active page is the one thing that may never be hidden.
    shown = Math.max(1, shown)
  }
  const start = Math.min(Math.max(0, active - shown + 1), count - shown)
  return { start, shown, hidden: count - shown }
}
