// The one composer an attachment lands in: every composer (a new chat,
// a running chat) claims the bus when it mounts and when it is focused,
// and the browser pane's "attach to chat" inserts through whoever claimed
// last - where the user is typing. Plain module, no DOM: tested.

let current = null

// Claim the bus for an inserter. Stays claimed until someone else claims.
export function claimInserter(fn) {
  current = fn
}

// Insert text into the claiming composer. False when no composer has
// claimed yet (no chat open), so the caller can say so instead.
export function insertToComposer(text) {
  if (!current) return false
  current(text)
  return true
}

// Test-only: forget the claim.
export function resetInserter() {
  current = null
}
