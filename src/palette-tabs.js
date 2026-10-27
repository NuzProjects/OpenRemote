// The palette's Browser group: the tabs that are open, as rows, ranked with
// the same ranker the palette uses for everything else so a half-typed name
// finds a tab exactly as it finds a chat.
//
// Pure: the palette supplies what the browser store holds and whether a
// browser view is mounted, and gets back rows or nothing. A browser that is not
// on screen contributes no rows at all, because a tab you cannot see is not a
// place Ctrl+K can send you.
import { rankMatches } from './shortcuts.js'

export const BROWSER_GROUP = 'Browser'

/// One tab as a row: its title as the name, its address as the sub line. A tab
/// with no title yet (a fresh tab page, or one still loading) says so with the
/// address when it has one and a plain fact when it does not, rather than an
/// empty sub line that reads as a rendering fault.
export function tabRow(tab) {
  const title = typeof tab?.title === 'string' ? tab.title.trim() : ''
  const url = typeof tab?.url === 'string' ? tab.url.trim() : ''
  return {
    key: tab?.key ?? null,
    name: title || 'New tab',
    sub: title ? url : url || 'No address yet',
    active: Boolean(tab?.active),
  }
}

/// The group's rows, or none. `mounted` is whether a browser view is on
/// screen; `tabs` is the store's own array. Ranked by the palette's ranker when
/// there is a query, in tab order when there is not (the strip's own order,
/// which is the order a person reads it in).
export function browserTabs({ tabs = null, mounted = false, query = '' } = {}) {
  if (!mounted) return []
  const rows = (Array.isArray(tabs) ? tabs : [])
    .filter((tab) => tab && tab.key != null)
    .map((tab) => tabRow(tab))
  if (!query.trim()) return rows
  return rankMatches(query, rows, (row) => row.name)
}
