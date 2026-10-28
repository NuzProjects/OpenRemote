import assert from 'node:assert/strict'
import test from 'node:test'

import { markAllSeen, movedLine, sinceLastLook, whatHappened, whenLabel } from './since-last-look.js'
import { STATUSES, displayWord } from './status-words.js'

// The row shape the palette builds from the poll: the id, the title, the
// harness, when it last moved, and the status in the sidebar's vocabulary.
const row = (id, updatedAt, status = 'idle', extra = {}) => ({
  id,
  title: `chat ${id}`,
  harness: 'claude',
  updatedAt,
  status,
  ...extra,
})

test('only chats that moved since a look are on the page', () => {
  const seen = { a: 100, b: 200, d: 1, e: 50, f: 10 }
  const rows = [
    row('a', 300), // moved after the look
    row('b', 200), // looked at exactly this activity
    row('c', 400), // never looked at: seeded, not news
    row('d', 500, 'running'), // mid-turn: nothing to read yet
    row('e', 0), // no activity stamp at all
    row('f', 600, 'waiting'),
  ]
  assert.deepEqual(
    sinceLastLook(rows, seen).map((r) => r.id),
    ['f', 'a'],
    'moved since the look, and not the unsettled or the unknown',
  )
  assert.deepEqual(sinceLastLook(rows, {}).map((r) => r.id), [], 'no records, no news')
  assert.deepEqual(sinceLastLook([], seen), [])
  assert.deepEqual(sinceLastLook(undefined, seen), [])
})

test('newest activity first, ties by id, whatever order the poll came in', () => {
  const seen = { a: 10, b: 10, c: 10 }
  const rows = [row('a', 200), row('b', 300), row('c', 300)]
  assert.deepEqual(sinceLastLook(rows, seen).map((r) => r.id), ['b', 'c', 'a'])
  assert.deepEqual(
    sinceLastLook([...rows].reverse(), seen).map((r) => r.id),
    ['b', 'c', 'a'],
    'the same page whichever way the list arrived',
  )
})

test('each status says what happened last in the sidebar\'s words', () => {
  assert.equal(whatHappened('waiting'), 'Waiting on an answer')
  assert.equal(whatHappened('idle'), 'The last turn finished')
  assert.equal(whatHappened('stopped'), 'Stopped')
  assert.equal(whatHappened('failed'), 'The last turn failed')
  assert.equal(whatHappened('running'), 'A turn is running')
  assert.equal(whatHappened('working'), 'A turn is running', 'the daemon\'s word maps to the same line')
  assert.equal(whatHappened('starting'), 'Starting')
  assert.equal(whatHappened('something-new'), 'Moved', 'an unknown state still says something true')
  assert.equal(whatHappened(undefined), 'Moved')
})

test('every status has its own line, in either vocabulary', () => {
  // The map is keyed by the canonical words from status-words.js, so it must
  // be total over the six and say the same thing when handed the display word.
  // A hole here would fall through to "Moved", which would be true but wrong.
  for (const status of STATUSES) {
    assert.notEqual(whatHappened(status), 'Moved', `${status} has a line of its own`)
    assert.equal(whatHappened(displayWord(status)), whatHappened(status), `${displayWord(status)} says the same`)
  }
})

test('the time is written the console\'s way, and a chat with no stamp says nothing', () => {
  const format = (ms) => `at ${ms}`
  assert.equal(whenLabel(1700000000000, format), 'at 1700000000000')
  assert.equal(whenLabel(0, format), '')
  assert.equal(whenLabel(undefined, format), '')
  assert.equal(whenLabel(Number.NaN, format), '')
})

test('the header is a sentence with the count in it, never a badge', () => {
  assert.equal(movedLine(1), 'One chat moved while you were away.')
  assert.equal(movedLine(2), 'Two chats moved while you were away.')
  assert.equal(movedLine(10), 'Ten chats moved while you were away.')
  assert.equal(movedLine(12), '12 chats moved while you were away.', 'past ten the numeral is the honest word')
  assert.equal(movedLine(0), '', 'nothing moved, nothing to say')
  assert.equal(movedLine(undefined), '')
})

test('marking everything read records exactly the chats the page lists', () => {
  const seen = { a: 100, b: 200 }
  const rows = [
    row('a', 300), // unread
    row('b', 200), // already read at this activity
    row('c', 400), // no record: seedable, never news
    row('d', 0), // no activity stamp at all
  ]
  const before = sinceLastLook(rows, seen).map((r) => r.id)
  const { seen: after, count } = markAllSeen(rows, seen)
  assert.deepEqual(before, ['a'])
  assert.equal(count, 1, 'one chat was recorded')
  assert.equal(after.a, 300, 'recorded at its own activity, not at now')
  assert.deepEqual(sinceLastLook(rows, after), [], 'and the page is empty afterwards')
})

test('a chat with no activity stamp never gets a record', () => {
  const seen = { z: 5 }
  const { seen: after, count } = markAllSeen([row('z', 0)], seen)
  assert.equal(count, 0)
  assert.equal(after, seen, 'nothing written, the same map')
  assert.equal(Object.prototype.hasOwnProperty.call(after, 'z'), true)
  assert.equal(after.z, 5, 'and the record it had is untouched')
})

test('with nothing unread there is nothing to do', () => {
  const seen = { a: 300 }
  const rows = [row('a', 300)]
  const { seen: after, count } = markAllSeen(rows, seen)
  assert.equal(count, 0)
  assert.equal(after, seen, 'the caller can tell "nothing to write" from "wrote"')
  assert.deepEqual(markAllSeen([], {}), { seen: {}, count: 0 })
})
