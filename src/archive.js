// Archived chats: hidden from the sidebar, kept in Settings, restorable.
// Console-side and per computer, like the other view preferences - the
// daemon's chats are untouched, so archiving never loses a transcript and
// a synced chat stays live on its other devices. Pure helpers over a Set
// of chat ids; tests run without a DOM.

const ARCHIVE_KEY = 'openremote-archived-chats'

/** The archived chat ids; a damaged value reads as none. */
export function loadArchived() {
  try {
    const raw = JSON.parse(localStorage.getItem(ARCHIVE_KEY) ?? '[]')
    return new Set(Array.isArray(raw) ? raw.filter((id) => typeof id === 'string') : [])
  } catch {
    return new Set()
  }
}

/// Whether the set reached storage. A profile that refuses writes used to swallow the
/// failure here, so Restore in Settings left the row exactly where it was with nothing
/// said, while the Appearance toggles further up report the identical refusal.
export function saveArchived(ids) {
  try {
    localStorage.setItem(ARCHIVE_KEY, JSON.stringify([...ids]))
    return true
  } catch {
    return false
  }
}

/** A new set with the id archived (or restored); the input is untouched. */
export function withArchived(ids, id, archived) {
  const next = new Set(ids)
  if (archived) next.add(id)
  else next.delete(id)
  return next
}

/** The sessions the sidebar lists: everything not archived. */
export function activeSessions(sessions, archived) {
  return (sessions ?? []).filter((s) => !archived.has(s.id))
}

/** The archived sessions that still exist, most recently active first. */
export function archivedSessions(sessions, archived) {
  return (sessions ?? [])
    .filter((s) => archived.has(s.id))
    .sort((a, b) => (b.updated_at ?? 0) - (a.updated_at ?? 0))
}
