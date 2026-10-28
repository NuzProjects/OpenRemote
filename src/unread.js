// Since you last looked: one quiet mark on a chat whose work advanced while
// nobody was reading it.
//
// The sidebar's poll already carries each chat's last activity
// (`updated_at`), so the console only has to remember what the person has
// actually seen. That is a map of chat id to the last activity a looked-at
// window showed, stored on this computer under its own key. It never
// travels: a second console, or the phone, keeps its own.
//
// The rules live here so the component only renders them. The one piece of
// judgement worth stating: a chat that is still working has not produced
// anything to read yet. `updated_at` moves on every event of a turn, so
// without that exclusion a long turn would mark itself unread on every
// poll; the completion that follows bumps the stamp again and the mark
// lands then. The status dot already says the chat is running.

import { loadStoredChatSeen, saveStoredChatSeen } from './settings.js'
import { isBusy as busyStatus } from './status-words.js'

// How many chats keep a record. A console that has seen thousands of chats
// does not need all of them, and local storage is not a database: the
// newest records are the only ones that can still answer "did this move?".
export const SEEN_CAP = 200

/** The chat's last activity, as the poll reports it. */
export function activityAt(row) {
  const stamp = row?.updatedAt
  return typeof stamp === 'number' && Number.isFinite(stamp) && stamp > 0 ? stamp : 0
}

/**
 * Whether a harness is mid-turn on this chat, so nothing has arrived yet.
 *
 * The live field comes first: a chat on screen carries `liveStatus`, and the
 * sidebar's `status` is that field with 'idle' filled in for a chat with no
 * record yet, so reading `status` first would call a poll-only `working` chat
 * idle on the first paint after a load (Sidebar.jsx sets all three). The
 * poll's own word is next, and `status` stays as the fallback for a row built
 * without either. The words themselves are status-words.js, which answers the
 * same for the sidebar's `running` and the daemon's `working`.
 */
export function isBusy(row) {
  const status = row?.liveStatus ?? row?.polledStatus ?? row?.status
  return busyStatus(status)
}

/**
 * A stored map, repaired: string keys, finite positive stamps, newest
 * `SEEN_CAP` kept. Anything else reads as no record at all, which is the
 * same as this console never having looked - a chat with no record is not
 * marked, so damage can lose marks but can never invent them.
 */
export function normalizeSeen(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const entries = []
  for (const [id, stamp] of Object.entries(raw)) {
    if (!id) continue
    if (typeof stamp !== 'number' || !Number.isFinite(stamp) || stamp <= 0) continue
    entries.push([String(id), stamp])
  }
  entries.sort((a, b) => b[1] - a[1])
  return Object.fromEntries(entries.slice(0, SEEN_CAP))
}

/**
 * First sight of a chat is not news: for every chat this console has no
 * record of, the record starts at what the chat had right now. A backlog
 * from before the feature existed, or a chat another device created, does
 * not arrive as unread - only what moves after this point does. Returns the
 * same map when there is nothing to add, so callers can skip a write.
 */
export function seedSeen(seen, rows) {
  const current = seen ?? {}
  let next = null
  for (const row of rows ?? []) {
    const id = row?.id
    if (!id || Object.prototype.hasOwnProperty.call(current, id)) continue
    const stamp = activityAt(row)
    if (!stamp) continue
    next ??= { ...current }
    next[id] = stamp
  }
  return next ?? current
}

/**
 * A chat was looked at: remember the activity that was on screen. A stamp
 * never goes backwards - a stale window, or a poll that arrived out of
 * order, cannot un-read what a newer look already read.
 */
export function recordSeen(seen, id, stamp) {
  const current = seen ?? {}
  if (!id || typeof stamp !== 'number' || !Number.isFinite(stamp) || stamp <= 0) return current
  const last = current[id]
  if (typeof last === 'number' && last >= stamp) return current
  return normalizeSeen({ ...current, [id]: stamp })
}

/**
 * Whether this row should carry the quiet mark: it has a record, has moved
 * since that record, and nothing is still running on it.
 *
 * A chat with no record is not marked: it was never "seen then changed", and
 * `seedSeen` gives it a record the moment this console lists it. A busy chat
 * is not marked either: nothing has arrived to read yet, and its stamp moves
 * on every event of the turn (see isBusy).
 */
export function isUnread(seen, row) {
  if (!row?.id) return false
  if (isBusy(row)) return false
  const stamp = activityAt(row)
  if (!stamp) return false
  const last = (seen ?? {})[row.id]
  if (typeof last !== 'number') return false
  return stamp > last
}

/**
 * The seen map after a person marks one chat by hand: `direction` is 'read' or
 * 'unread'.
 *
 * Reading is the same act as looking at the chat, so it goes through
 * `recordSeen` and keeps its rule that a stamp never goes backwards (a stale
 * window cannot un-read what a newer look already read). Marking unread is the
 * one place where the record moves under the activity on purpose, and the
 * smallest honest value is one millisecond before it: the map means "the last
 * activity a window showed", and that value says this console has seen nothing
 * of the latest change. A chat with no activity to sit behind (a missing stamp,
 * a zero) is left alone, because there is nothing for the mark to say.
 *
 * One function with a direction rather than two named ones: the two answers
 * share their inputs and their output, and the caller chooses by the state the
 * row is already drawn in. Keeping them together also keeps "never goes
 * backwards" next to the single deliberate exception to it, which is the pair a
 * future reader has to hold at once.
 */
export function markSeen(seen, id, stamp, direction) {
  if (direction === 'read') return recordSeen(seen, id, stamp)
  const current = seen ?? {}
  if (!id) return current
  if (typeof stamp !== 'number' || !Number.isFinite(stamp) || stamp <= 1) return current
  const last = current[id]
  // Already under the activity: the row is unread, and a second mark is not a
  // change (the caller keeps the same map and skips its write).
  if (typeof last === 'number' && last < stamp) return current
  return normalizeSeen({ ...current, [id]: stamp - 1 })
}

/** The ids that should carry the mark, as a Set for the render. */
export function unreadIds(seen, rows) {
  const ids = new Set()
  for (const row of rows ?? []) {
    if (isUnread(seen, row)) ids.add(row.id)
  }
  return ids
}

/**
 * Whether a list (a project, the flat Chats list) holds anything unread.
 * The header of a list says "there is something in here", not how many:
 * a count would be the badge the design does not want.
 */
export function listHasUnread(rows, unread) {
  if (!unread) return false
  for (const row of rows ?? []) {
    if (row?.id && unread.has(row.id)) return true
  }
  return false
}

/** This computer's records, repaired. */
export function loadSeen() {
  return normalizeSeen(loadStoredChatSeen())
}

/** Store the map as repaired, and answer what was stored. */
export function storeSeen(seen) {
  const clean = normalizeSeen(seen)
  saveStoredChatSeen(clean)
  return clean
}
