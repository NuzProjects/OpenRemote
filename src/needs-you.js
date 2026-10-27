// Needs you: the chats whose harness is blocked on a person.
//
// The sidebar polls `GET /sessions`, which carries each chat's status, and a
// chat on screen also has a live status from its stream; both say `waiting`
// while the harness is holding a question open. Nothing here asks the daemon
// anything: the rules - which chats qualify, in what order, the count, and the
// document title a window that cannot be looked at should wear - live here so
// the component only renders them and the rules can be tested without a DOM.

/// The name a title falls back to when the document carries none.
export const BASE_TITLE = 'OpenRemote'

/// Whether one chat is waiting on a person.
///
/// A chat that is on screen has a live status, which is fresher than the
/// poll's: it answers first, so a question already answered does not linger in
/// the group for a poll beat. The poll covers every chat that is not on screen,
/// which is most of them.
export function isWaiting(liveStatus, polledStatus) {
  return (liveStatus ?? polledStatus) === 'waiting'
}

/// The waiting chats, oldest wait first, and the count.
///
/// `updatedAt` is the chat's last event. A harness that is waiting has no later
/// event, because the question is the last thing it said, so the smallest
/// `updatedAt` is the wait that has been starving longest. Ties break by id so
/// the order never depends on how the poll happened to order its list.
///
/// A copy of a chat that runs on another device is left out: its status is the
/// last thing that device said, so it can read `waiting` long after the
/// question was answered there, and sending the user across to it on that
/// evidence would be a guess.
export function needsYou(rows) {
  const chats = (rows ?? [])
    .filter((row) => row && !row.offline && isWaiting(row.liveStatus, row.polledStatus))
    .slice()
    .sort(
      (a, b) =>
        (a.updatedAt ?? 0) - (b.updatedAt ?? 0) || String(a.id).localeCompare(String(b.id)),
    )
  return { chats, count: chats.length }
}

/// The document title for one beat.
///
/// The console's own title is left exactly as it was while the window is being
/// looked at, and while nothing is waiting. Only a window that cannot be
/// looked at wears the count, prefixed, because a title is read from the end
/// when it is cut short.
export function attentionTitle(base, count, visible) {
  const title = String(base ?? '')
  if (visible || !(count > 0)) return title
  return `${count} waiting - ${title.trim() || BASE_TITLE}`
}
