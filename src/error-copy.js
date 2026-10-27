// What a caught error says on screen, in the console's own voice.
//
// The client's own failures (a timeout, a connection that never answered)
// already arrive as sentences this app wrote. The daemon's errors are the
// daemon's words, and they are quoted as such rather than adopted as the
// app's own: the reader should be able to tell which voice they are seeing.
// No line here is a bare status code, none says "something went wrong", and a
// cause the console does not know says so instead of inventing one.
//
// The third voice is the console's own check (`consoleError`): a sentence the
// app wrote and must not hand to another mouth. It is repeated without quotes
// and without a culprit. An error that carries neither a status nor that mark
// gets the neutral sentence below - the console could not do the thing, and
// the words it was handed are quoted, with no claim about who said them.
//
// No line promises an action either. The control beside the line (a retry, a
// dismiss, the pane's own button) is what offers it, and a sentence that names
// an action the view does not draw would be a second lie on top of the first.

const TIMEOUT = 'The daemon did not answer in time'

export const UNREACHABLE = 'The console could not reach its daemon.'

const NETWORK = /failed to fetch|network ?error|load failed|err_connection/i

const trimDot = (said) => said.replace(/[.!?]+$/, '')

/// An error the console raised itself: a check it made, a shape it refused.
/// The mark is what lets `errorCopy` repeat the sentence as the app's own
/// rather than quoting it as somebody else's.
export function consoleError(message) {
  const error = new Error(String(message ?? ''))
  error.voice = 'console'
  return error
}

/// The sentence for a caught error: what failed, whose words are being shown,
/// and what a person can reasonably do about it.
export function errorCopy(err) {
  // A thrown string is somebody else's words, taken as a quote and no further.
  if (typeof err === 'string' && err.trim()) {
    return `The console could not do this: \u201c${trimDot(err.trim())}\u201d.`
  }
  const status = typeof err?.status === 'number' ? err.status : null
  const said = typeof err?.message === 'string' ? err.message.trim() : ''
  // The console wrote this one itself, so it is repeated rather than quoted.
  if (said.startsWith(TIMEOUT)) return `${TIMEOUT}. Try again.`
  // The stream's own close line: a status with no words around it.
  if (/^SSE HTTP \d+$/.test(said)) {
    return 'The live stream to the daemon dropped. The console is reconnecting on its own.'
  }
  if (status != null) {
    // `call()` puts the daemon's own sentence in the message and keeps the
    // status beside it. A message that is only the status means the daemon
    // answered with nothing to read.
    const reason = said && !/^HTTP \d+$/.test(said) ? said : ''
    return reason
      ? `The daemon refused this: \u201c${reason}\u201d.`
      : `The daemon answered ${status} and gave no reason for it.`
  }
  // No status: the request never reached the daemon (a closed port, a socket
  // the webview dropped), or what was thrown was not an Error at all.
  if (err instanceof TypeError || NETWORK.test(said)) {
    return `${UNREACHABLE} Check that it is running, then try again.`
  }
  if (!said) return 'The console does not know why this failed. Try again.'
  // The console's own check: our words, so no quotes and no other mouth.
  if (err?.voice === 'console') return `The console could not do this: ${trimDot(said)}.`
  // Words from somewhere else entirely: quoted, and with no claim about who
  // said them.
  return `The console could not do this: \u201c${trimDot(said)}\u201d.`
}
