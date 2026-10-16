// The sidebar's rules about what the list shows, kept pure so they are
// tested without a DOM.

/**
 * The one dot a chat wears: the thing the user most needs to know about
 * it. A copy of a chat whose device is away carries a stale status, so
 * only what this device saw itself ("done, not seen") outlives that;
 * otherwise the order is: waiting on you, failed, done and not seen,
 * then whatever the status says (running breathes, idle shows nothing).
 */
export function dotKind({ status, offline = false, unseen = false }) {
  if (offline) return unseen ? 'unseen' : 'offline'
  if (status === 'waiting' || status === 'failed') return status
  if (unseen) return 'unseen'
  return status
}

/** What a dot says in words: its tooltip and its label for a screen reader. */
export const DOT_WORDS = {
  waiting: 'Needs you',
  failed: 'Failed',
  unseen: 'Done, not seen',
  running: 'Running',
  starting: 'Starting',
}
