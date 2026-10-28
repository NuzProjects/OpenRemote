// Since your last look: the chats that moved while nobody was reading them,
// newest activity first, with one line each about what happened last.
//
// unread.js owns the mark - which chats are unseen, how a look is recorded, and
// what is stored on this computer. This module only turns that mark into a
// page: which rows it lists, the order it lists them in, and the sentences each
// row reads. Nothing here ranks by importance, because nothing here can know
// it: `updated_at` moves on any event, so the page says what moved and when,
// and never implies that the newest thing matters most.

import { activityAt, isUnread, recordSeen } from './unread.js'
import { canonical } from './status-words.js'

// The one timestamp format the console writes - the same options the
// automations list uses for "last ran", so a time on screen looks the same
// wherever it is on screen.
export const TIME_FORMAT = { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }

// What last happened, in the sidebar's own status words, one line per daemon
// status. The keys are status-words.js's canonical words, so the console's
// "running" reaches the working line without a second entry here; a busy chat
// cannot be unread (unread.js says why), but the sentence exists for it so the
// mapping is total rather than full of holes.
const STATUS_LINE = {
  starting: 'Starting',
  working: 'A turn is running',
  waiting: 'Waiting on an answer',
  idle: 'The last turn finished',
  stopped: 'Stopped',
  failed: 'The last turn failed',
}

/** The line that says what happened last, from the chat's status in either vocabulary. */
export function whatHappened(status) {
  return STATUS_LINE[canonical(status)] ?? 'Moved'
}

/** The activity stamp as the console writes a time, or '' when there is none. */
export function whenLabel(stamp, format = (ms) => new Intl.DateTimeFormat(undefined, TIME_FORMAT).format(ms)) {
  if (typeof stamp !== 'number' || !Number.isFinite(stamp) || stamp <= 0) return ''
  return format(stamp)
}

/**
 * The unread chats, newest activity first.
 *
 * Oldest-first would be the order of the debt, but this page is a record of
 * what happened, not a queue: the newest is the one a person just missed. Ties
 * break by id so two polls that arrive in different orders cannot reorder the
 * page under the cursor. A chat with no activity stamp is never listed: there
 * is no time to show and nothing to have missed.
 */
export function sinceLastLook(rows, seen) {
  return (rows ?? [])
    .filter((row) => isUnread(seen, row))
    .slice()
    .sort((a, b) => activityAt(b) - activityAt(a) || String(a.id).localeCompare(String(b.id)))
}

/**
 * Every chat the page would list, recorded as looked at, in one pass.
 *
 * The same rows, in the same order, so "what the page shows" and "what marking
 * all reads" cannot drift apart: the map that comes back is the map the page
 * would have shown as empty. A chat with no activity stamp is never given a
 * record - there is no stamp to record, and a record at zero would read as
 * "looked at, when nothing happened" for every later beat.
 *
 * `{ seen, count }` where count is how many chats were recorded. With nothing
 * moved the input map comes back as the same object and the count is zero, so
 * the caller can tell "nothing to write" from "wrote" without comparing maps.
 */
export function markAllSeen(rows, seen) {
  const moved = sinceLastLook(rows, seen)
  if (moved.length === 0) return { seen, count: 0 }
  let next = seen ?? {}
  let count = 0
  for (const row of moved) {
    const stamp = activityAt(row)
    if (!stamp) continue
    const after = recordSeen(next, row.id, stamp)
    if (after !== next) {
      next = after
      count += 1
    }
  }
  return { seen: next, count }
}

// The count in words, because the page's header is a sentence and a badge is
// the thing this console does not use to say "there is something here".
const WORDS = ['none', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten']

/** "Two chats moved while you were away." - the page's header. */
export function movedLine(count) {
  const n = Number(count)
  if (!(n > 0)) return ''
  const word = n <= 10 ? WORDS[n] : String(n)
  return `${word} ${n === 1 ? 'chat' : 'chats'} moved while you were away.`
}
