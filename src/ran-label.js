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

// A stamp a little in the future is a clock a little fast, and inventing a time for
// it would be a guess; a minute is slack no wall clock should drift by between a run
// and the poll that reports it.
const FUTURE_SLACK_MS = 60_000

/// The "ran ..." line. `now` is injectable so the future case is tested without
/// waiting for a clock to drift.
export function ranLabel(rule, now = Date.now()) {
  const raw = rule?.last_run
  if (raw == null || raw === '') return 'never ran'
  const at = Number(raw)
  // NaN and Infinity are a stamp that exists and cannot be read: saying
  // "never ran" about them would deny a run that happened.
  if (!Number.isFinite(at)) return 'ran at an unknown time'
  if (at <= 0) return 'never ran'
  if (at > MAX_DATE) return 'ran at an unknown time'
  // A future stamp used to be formatted as an ordinary past run ("ran 30 Oct" on the
  // 28th), which reads as a fact about when it ran and is not one: that machine's
  // clock is ahead of this one, so the run is real and its time is not knowable here.
  if (at > now + FUTURE_SLACK_MS) return 'ran, at a time this computer reads as the future'
  return `ran ${RAN.format(new Date(at))}`
}
