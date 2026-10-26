// The one composer an attachment lands in: every composer (a new chat,
// a running chat) claims the bus when it mounts and when it is focused,
// and the browser pane's "attach to chat" inserts through whoever claimed
// last - where the user is typing. Plain module, no DOM: tested.

let current = null

// Claim the bus for an inserter, and hand back the release that ends the
// claim. The claim belongs to the composer that made it: releasing it is what
// a composer's unmount does, so a claim cannot outlive the surface it types
// into and the browser pane never reports a delivery that went nowhere.
export function claimInserter(fn) {
  const mine = { fn }
  current = mine
  return function release() {
    // A later claim is not this one's to clear: the composer that took the bus
    // after this one still owns it, and only its own unmount ends that.
    if (current === mine) current = null
  }
}

// Insert text into the claiming composer. False when no live composer holds
// the bus (no chat open, or the one that claimed has gone away), so the
// caller can say so instead of claiming it was delivered.
export function insertToComposer(text) {
  if (!current) return false
  current.fn(text)
  return true
}

// Test-only: forget the claim.
export function resetInserter() {
  current = null
}
