// The chat-name rules: what the rename dialog accepts, what it does with the
// text around the name, and when there is nothing to save.
//
// The daemon trims the name and keeps its first 200 characters when it stores
// it (the `rename` call in the daemon's composer). The dialog applies the same
// two rules before it asks, so a name the console accepted is one the daemon
// stores unchanged, and the field shows exactly what the user will get.

export const MAX_NAME = 200

// The name as it will be saved: the ends trimmed, the spacing inside it as the
// user typed it, and cut to what the daemon keeps. Cut by character, not by
// UTF-16 unit, because the daemon cuts by character: a name ending in an emoji
// would otherwise lose half of it here and keep it there.
export function cleanName(text) {
  const trimmed = String(text ?? '').trim()
  const chars = Array.from(trimmed)
  return chars.length > MAX_NAME ? chars.slice(0, MAX_NAME).join('') : trimmed
}

// What the dialog should do with what is in the field.
//   'empty'     - nothing but whitespace: there is no name to save
//   'unchanged' - the name the chat already has: close, write nothing
//   'saveable'  - a new name, and `value` is what will be sent
//
// Comparison is on the cleaned form of both sides, so retyping the current
// name with a stray space is the same name, not a save.
export function renameState(current, next) {
  const value = cleanName(next)
  if (!value) return { state: 'empty', value }
  if (value === cleanName(current)) return { state: 'unchanged', value }
  return { state: 'saveable', value }
}

// The name a list row shows while the console's own record catches up: the
// name just saved, until the record agrees, and the record's own from then on
// (which is the truth, including a change another device made).
export function shownTitle(saved, current) {
  return saved && saved !== current ? saved : current
}

// Whether the one-beat overlay has done its job.
//
// Comparing names alone is not enough: a rename from another device can land
// while this one's save is in flight, so the record never equals the overlay's
// name and the row would keep the local name indefinitely. The rename call
// answers with the session it wrote, stamp included, so the overlay carries
// that stamp: once the console's own record is newer than the ack, the
// daemon has said something later than this save and the overlay is stale
// whatever the names say.
export function overlayStale(ack, record) {
  // No stamp on either side is not a comparison: null must not read as zero,
  // or "we never learned the ack's stamp" would clear the overlay at once.
  if (ack == null || ack === '' || record == null || record === '') return false
  const a = Number(ack)
  const r = Number(record)
  if (!Number.isFinite(a) || !Number.isFinite(r)) return false
  return r > a
}
