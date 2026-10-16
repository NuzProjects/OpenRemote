// The sidebar's rules about what the list shows, kept pure so they are
// tested without a DOM.

/**
 * The one dot a chat wears: the thing the user most needs to know about
 * it. A copy of a chat whose device is away carries a stale status, so
 * only what this device saw itself ("done, not seen") outlives that;
 * otherwise the order is: waiting on you, failed, done and not seen,
 * then whatever the status says (running breathes, idle shows nothing).
 */
export function dotKind({ status, offline = false, unseen = false }) {
  if (offline) return unseen ? 'unseen' : 'offline'
  if (status === 'waiting' || status === 'failed') return status
  if (unseen) return 'unseen'
  return status
}

/** What a dot says in words: its tooltip and its label for a screen reader. */
export const DOT_WORDS = {
  waiting: 'Needs you',
  failed: 'Failed',
  unseen: 'Done, not seen',
  running: 'Running',
  starting: 'Starting',
}

// How urgent each dot is, for a project folded over its chats: the row
// shows the most urgent state inside it, so a folded tree still tells the
// truth. Waiting on you beats failed beats done-not-seen beats running
// (a boot counts as running).
const URGENCY = { waiting: 4, failed: 3, unseen: 2, running: 1, starting: 1 }

/**
 * The most urgent dot among a project's chats - 'waiting', 'failed',
 * 'unseen' or 'running' - or null when nothing in it needs a mark. Takes
 * the chats' dot kinds (see dotKind), so an away device's stale status
 * never counts.
 */
export function rollup(kinds) {
  let best = null
  for (const kind of kinds) if ((URGENCY[kind] ?? 0) > (URGENCY[best] ?? 0)) best = kind
  return best === 'starting' ? 'running' : best
}

/**
 * The pinned chats among `rows`, in the order they were pinned (not the
 * order of the list). A pin whose chat is not among the rows - deleted,
 * archived, or filtered out by a search - is skipped, never an empty row.
 */
export function pinnedRows(rows, pinned) {
  const byId = new Map(rows.map((row) => [row.id, row]))
  return pinned.map((id) => byId.get(id)).filter(Boolean)
}

/** How many chats a project shows before "Show more", and how many the flat Chats list does. */
export const PROJECT_PAGE = 5
export const CHATS_PAGE = 15

/**
 * The part of a list the sidebar shows. The rows come newest first: the
 * first `page` of them show, a further `page` for each time the user asked
 * for more (`pages`), and whichever rows `keep` names stay in view wherever
 * they sit (a chat that needs you; the one that is open). `rest` is what is
 * left out, and `next` how many rows the next "Show more" brings in -
 * counted exactly, since a kept row far down is already on screen.
 */
export function pageOf(items, { page, pages = 0, keep = () => false }) {
  const showing = (limit) => items.filter((item, i) => i < limit || keep(item))
  const shown = showing(page * (pages + 1))
  const inShown = new Set(shown)
  return {
    shown,
    rest: items.filter((item) => !inShown.has(item)),
    next: showing(page * (pages + 2)).length - shown.length,
  }
}
