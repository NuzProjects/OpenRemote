// What the sidebar remembers about this device's own view of the list:
// which projects are folded, which chats are pinned, which chats finished
// while nobody was looking. Console-side and per device, like archiving -
// the daemon's chats are untouched, so another device keeps its own marks.
// Pure helpers over lists of ids, so the rules are tested without a DOM;
// storage never throws (a blocked or full store just forgets).

export const KEYS = {
  collapsed: 'openremote-sidebar-collapsed',
  pinned: 'openremote-pinned-chats',
  unseen: 'openremote-unseen-chats',
}

/** The ids stored under a key; a damaged value reads as none. */
export function loadList(key) {
  try {
    const raw = JSON.parse(localStorage.getItem(key) ?? '[]')
    return Array.isArray(raw) ? [...new Set(raw.filter((id) => typeof id === 'string'))] : []
  } catch {
    return []
  }
}

export function saveList(key, list) {
  try {
    localStorage.setItem(key, JSON.stringify(list))
  } catch {
    /* storage unavailable */
  }
}

/**
 * The list with `id` in or out. An id goes in at the end, so a list keeps
 * the order things were added in (the pinned chats read that way). The
 * same array comes back when nothing changes, so a state setter given it
 * does not render again.
 */
export function toggled(list, id, on) {
  const has = list.includes(id)
  if (on) return has ? list : [...list, id]
  return has ? list.filter((x) => x !== id) : list
}

/**
 * Only the ids that still exist (`alive`, a Set). The same array comes
 * back when none were dropped. Callers hold off until the real list of
 * chats has loaded: an empty list at start-up must not wipe the marks.
 */
export function pruned(list, alive) {
  const kept = list.filter((id) => alive.has(id))
  return kept.length === list.length ? list : kept
}

// A chat that is working, or waiting on the user, is mid-turn.
const MID_TURN = new Set(['running', 'waiting'])

/**
 * Whether a chat's turn ended or failed between two looks at it: it was
 * mid-turn, and now it is idle (done) or failed. A chat stopped by hand,
 * or one that was never mid-turn (a first look, a boot settling), is not
 * news - counting those would mark every chat each time the daemon
 * restarts.
 */
export function endedTurn(before, after) {
  return MID_TURN.has(before) && (after === 'idle' || after === 'failed')
}
