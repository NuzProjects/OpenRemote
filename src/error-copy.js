// What a caught error says on screen, in the console's own voice.
//
// The client's own failures (a timeout, a connection that never answered)
// already arrive as sentences this app wrote. The daemon's errors are the
// daemon's words, and they are quoted as such rather than adopted as the
// app's own: the reader should be able to tell which voice they are seeing.
// No line here is a bare status code, none says "something went wrong", and a
// cause the console does not know says so instead of inventing one.
//
// No line promises an action either. The control beside the line (a retry, a
// dismiss, the pane's own button) is what offers it, and a sentence that names
// an action the view does not draw would be a second lie on top of the first.

const TIMEOUT = 'The daemon did not answer in time'

export const UNREACHABLE = 'The console could not reach its daemon.'

const NETWORK = /failed to fetch|network ?error|load failed|err_connection/i

/// The sentence for a caught error: what failed, whose words are being shown,
/// and what a person can reasonably do about it.
export function errorCopy(err) {
  // A thrown string is somebody else's words, taken as a quote and no further.
  if (typeof err === 'string' && err.trim()) {
    return `Something outside the console answered: “${err.trim()}”.`
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
      ? `The daemon refused this: “${reason}”.`
      : `The daemon answered ${status} and gave no reason for it.`
  }
  // No status: the request never reached the daemon (a closed port, a socket
  // the webview dropped), or what was thrown was not an Error at all.
  if (err instanceof TypeError || NETWORK.test(said)) {
    return `${UNREACHABLE} Check that it is running, then try again.`
  }
  if (!said) return 'The console does not know why this failed. Try again.'
  // Words from somewhere else entirely: shown as a quote, never as ours.
  return `Something outside the console answered: “${said}”.`
}
