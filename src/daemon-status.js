// What the app says while it has no daemon. Pure, so the copy can be held
// to what the shell actually reports: the shell sends a reason only when
// it has one (desktop.rs clears it the moment a daemon says READY, and
// never sets one over a live address), so the rule only has to tell
// "there is a reason" from "there is none".

// A reason is a Rust error string. It is honest and it is the only
// diagnostic the app has, so it is shown, cleaned and capped rather than
// hidden behind a generic line.
const MAX_DETAIL = 240

export function detailOf(error) {
  if (typeof error !== 'string') return null
  const line = error.replace(/\s+/g, ' ').trim()
  if (!line) return null
  return line.length > MAX_DETAIL ? `${line.slice(0, MAX_DETAIL - 3)}...` : line
}

/**
 * The waiting screen's whole content. `info` is the shell's DaemonInfo,
 * or null before the first answer. `action` is 'try-now' exactly where a
 * person can act: on the desktop, where daemon_restart exists. Android
 * runs the daemon in-process and has no such command, so it is told to
 * reopen the app instead of being offered a button that would do nothing.
 */
export function daemonStatus(info) {
  const detail = detailOf(info?.error)
  const mobile = !!info?.mobile
  if (detail) {
    return {
      tone: 'failed',
      title: 'The daemon did not start',
      detail,
      note: mobile
        ? 'Close OpenRemote and open it again.'
        : 'It keeps trying on its own, every half minute at worst. Try now skips the wait.',
      action: mobile ? null : 'try-now',
    }
  }
  return {
    tone: 'starting',
    title: 'Waiting for the daemon',
    detail: null,
    note: mobile
      ? 'It starts with the app and usually takes a moment.'
      : 'It starts with the app and usually takes a moment. If nothing appears, try starting it again.',
    action: mobile ? null : 'try-now',
  }
}
