// The rules list's "ran ..." line.
//
// The stamp comes from storage: state.json, a record synced from another
// device, a daemon a version ahead. Intl.DateTimeFormat throws on an invalid
// date, which takes the whole rules list into the error boundary, and calling
// an unreadable stamp "never ran" would be a lie when the rule did run. So:
// no stamp (or a zero one) means never ran, a stamp that cannot be read says
// so, and a real one is formatted.
const RAN = new Intl.DateTimeFormat(undefined, {
  month: 'short',
  day: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
})

// Date's own ceiling in milliseconds.
const MAX_DATE = 8.64e15

export function ranLabel(rule) {
  const raw = rule?.last_run
  if (raw == null || raw === '') return 'never ran'
  const at = Number(raw)
  // NaN and Infinity are a stamp that exists and cannot be read: saying
  // "never ran" about them would deny a run that happened.
  if (!Number.isFinite(at)) return 'ran at an unknown time'
  if (at <= 0) return 'never ran'
  if (at > MAX_DATE) return 'ran at an unknown time'
  return `ran ${RAN.format(new Date(at))}`
}
