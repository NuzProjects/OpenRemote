// Whether two daemon payloads carry the same values. A beat re-reads the
// same lists every 2.5 s; storing a fresh array each time would hand every
// consumer a new identity and re-render what did not change. The payloads
// are small JSON documents that arrived as text, so a serialisation compare
// costs no more than the parse the fetch already paid and cannot disagree
// with value equality. Key order comes from the daemon's own serialiser on
// both sides, which is why it is a comparison rather than a walk.
export function samePayload(a, b) {
  if (a === b) return true
  if (a == null || b == null) return false
  try {
    return JSON.stringify(a) === JSON.stringify(b)
  } catch {
    // A payload that cannot be serialised (a cycle, a BigInt) is never the
    // one on screen; treating it as different is the safe answer.
    return false
  }
}
