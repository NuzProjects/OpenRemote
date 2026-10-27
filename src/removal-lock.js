// One removal at a time, even when the second press lands in the same frame.
//
// The guard cannot live in React state: state read inside a click handler is
// the render's state, so a double click or a held Enter can pass the check
// twice before the first `setRemoving` is rendered, and the daemon gets two
// deletes for one record. This holds the claim in a plain object that the
// press mutates immediately, with the state beside it only so the row can draw
// itself as busy.

/// A claim slot: `claim` succeeds once until `release`. Pure, so the
/// same-frame double press is a unit test rather than a renderer test.
export function createRemovalLock() {
  let owner = null
  return {
    claim(id) {
      if (owner != null) return false
      owner = id
      return true
    },
    release() {
      owner = null
    },
    current() {
      return owner
    },
  }
}
