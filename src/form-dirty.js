// The one dirty test every dialog's form shares. A dialog that closes on the
// same click or key as a viewer throws away half-typed input by accident, so
// each editor snapshots its fields when it opens and asks this whether there
// is anything to lose. Compared key by key over the snapshot, so a field added
// later is covered by adding it to the snapshot rather than by remembering a
// second place that also needs changing.

/**
 * Whether a form's fields differ from what it opened with. No snapshot means
 * nothing to compare, and nothing to lose.
 */
export function formDiffers(current, initial) {
  if (!initial || !current) return false
  return Object.keys(initial).some((key) => current[key] !== initial[key])
}
