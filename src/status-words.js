// One vocabulary for a chat's status.
//
// The daemon has exactly six session statuses - starting, working, waiting,
// idle, stopped, failed - and the console shows the word "running" for the
// working one. That is the whole of the drift: two vocabularies for one fact,
// so a module handed the daemon's word and a module handed the display word
// could not agree, and five modules restated the mapping by hand and drifted
// from it. The one that bit: the stop command compared against daemon words
// only, so a chat handed in as "running" read as not running, and the chat
// most likely to be burning the meter stayed out of the count.
//
// Everything here takes a status and folds it to its canonical (daemon) word
// first, so the predicates answer the same thing for either vocabulary:
// "running" and "working" are one input, not two. That choice, rather than
// making every caller canonicalise first, is deliberate: the two callers that
// can hand in a display word are a view reading a chat record and the stop
// lane reading a session row built from one, and a forgotten normalisation at
// one of them is exactly the bug this module exists to prevent. `canonical()`
// is exported for the callers that need the key itself (a counter, a sentence
// map), and `displayWord()` is the one place the console's own word is
// written down.
//
// A status this console does not know answers null, false, or "idle" in the
// display word - never a guess.

/** The daemon's six session statuses, in the order the console reads them. */
export const STATUSES = ['starting', 'working', 'waiting', 'idle', 'stopped', 'failed']

/**
 * The console's word for each status. Only `working` differs: the dot and the
 * sentences say "running" for it, and every other status is its own word.
 */
export const STATUS_WORD = {
  starting: 'starting',
  working: 'running',
  waiting: 'waiting',
  idle: 'idle',
  stopped: 'stopped',
  failed: 'failed',
}

// The display words that are not also daemon words. Kept spelled out rather
// than derived: a second entry here means the two vocabularies are drifting
// again, and that should be a deliberate edit in one place.
const DISPLAY_ONLY = { running: 'working' }

/**
 * The daemon's word for a status, given either vocabulary, or null for a
 * status this console does not know. Case and surrounding space are folded: a
 * status that arrives spelled differently is the same status, not a new one.
 */
export function canonical(status) {
  const word = typeof status === 'string' ? status.trim().toLowerCase() : ''
  if (!word) return null
  if (STATUS_WORD[word] !== undefined) return word
  return DISPLAY_ONLY[word] ?? null
}

/** The console's word for a status, given either vocabulary; "idle" if unknown. */
export function displayWord(status) {
  const word = canonical(status)
  return word == null ? 'idle' : STATUS_WORD[word]
}

/**
 * A turn is executing right now. This is the single state the console prints
 * as "running": the daemon's `working`. `starting` is not this one - the
 * process exists, the first turn has not said anything yet.
 */
export function isRunning(status) {
  return canonical(status) === 'working'
}

/** Waiting on a person's answer to the question the turn asked. */
export function isWaiting(status) {
  return canonical(status) === 'waiting'
}

/**
 * A harness holds the turn and nothing has arrived to read yet: starting, or
 * working. `waiting` is not busy - the question is the thing to read, so a
 * chat that asks one is not "still working" to the unread mark.
 */
export function isBusy(status) {
  const word = canonical(status)
  return word === 'starting' || word === 'working'
}

/**
 * A turn is live: starting, working, or waiting on an answer. This is the
 * chat record's `running` flag - the process is up and the turn has not
 * finished - and it is not `isRunning`, which is the one state the console
 * prints as "running".
 */
export function isActive(status) {
  const word = canonical(status)
  return word === 'starting' || word === 'working' || word === 'waiting'
}
