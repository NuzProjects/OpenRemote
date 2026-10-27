import assert from 'node:assert/strict'
import test from 'node:test'
import {
  createdPerDay,
  harnessCounts,
  machinePresence,
  newChatsLine,
  presenceLine,
  statusCounts,
  statusSentence,
  syncSplit,
} from './metrics.js'

test('status counts fill every status, zero included, in the order the sentence reads', () => {
  const sessions = [
    { status: 'working' },
    { status: 'working' },
    { status: 'idle' },
    { status: 'stopped' },
    { status: 'not-a-status' },
    {},
  ]
  const counts = statusCounts(sessions)
  assert.deepEqual(counts, {
    starting: 0,
    working: 2,
    waiting: 0,
    idle: 1,
    stopped: 1,
    failed: 0,
  })
  assert.deepEqual(Object.keys(counts), [
    'starting',
    'working',
    'waiting',
    'idle',
    'stopped',
    'failed',
  ])
  assert.deepEqual(statusCounts(undefined), {
    starting: 0,
    working: 0,
    waiting: 0,
    idle: 0,
    stopped: 0,
    failed: 0,
  })
})

test('the status sentence names only the nonzero statuses', () => {
  assert.equal(
    statusSentence([{ status: 'working' }, { status: 'working' }, { status: 'waiting' }]),
    '2 running · 1 waiting',
  )
  assert.equal(statusSentence([]), '')
  assert.equal(statusSentence([{ status: 'starting' }]), '1 starting')
  assert.equal(statusSentence([{ status: 'failed' }, { status: 'idle' }]), '1 idle · 1 failed')
})

test('harness counts sort most used first, ties by name', () => {
  const sessions = [
    { harness: 'claude' },
    { harness: 'codex' },
    { harness: 'claude' },
    { harness: 'codex' },
    { harness: 'zarness' },
    { harness: 'codex' },
    {},
  ]
  assert.deepEqual(harnessCounts(sessions), [
    { harness: 'codex', count: 3 },
    { harness: 'claude', count: 2 },
    { harness: 'zarness', count: 1 },
  ])
  assert.deepEqual(harnessCounts([{ harness: 'a' }, { harness: 'a' }]), [
    { harness: 'a', count: 2 },
  ])
  assert.deepEqual(harnessCounts(undefined), [])
})

test('day bands are local days, oldest first, ending today; older chats stay out', () => {
  const noon = new Date(2026, 9, 15, 12, 0, 0).getTime()
  const day = 86400000
  const sessions = [
    { created_at: noon },
    { created_at: noon - day },
    { created_at: noon - day + 3600000 },
    { created_at: noon - 40 * day },
    {},
  ]
  const bands = createdPerDay(sessions, 4, noon)
  assert.deepEqual(bands.map((b) => b.count), [0, 0, 2, 1])
  assert.deepEqual(
    bands.map((b) => b.key),
    ['2026-10-12', '2026-10-13', '2026-10-14', '2026-10-15'],
  )
  assert.deepEqual(createdPerDay(undefined, 3, noon).map((b) => b.count), [0, 0, 0])
})

test('day bands cross a month rollover without losing the first of the month', () => {
  const now = new Date(2026, 0, 3, 9, 30, 0).getTime()
  const bands = createdPerDay([{ created_at: new Date(2026, 0, 1, 6, 0, 0).getTime() }], 5, now)
  assert.deepEqual(bands.map((b) => b.key), [
    '2025-12-30',
    '2025-12-31',
    '2026-01-01',
    '2026-01-02',
    '2026-01-03',
  ])
  assert.deepEqual(bands.map((b) => b.count), [0, 0, 1, 0, 0])
})

test('the synced split is private, runs here, runs elsewhere', () => {
  const me = 'dev-me'
  const sessions = [
    { id: 'a' },
    { id: 'b' },
    { id: 'c', executor: me },
    { id: 'd', executor: 'dev-box' },
    { id: 'e', executor: me },
    { id: 'f', executor: 'dev-mini' },
  ]
  assert.deepEqual(syncSplit(sessions, me), { private: 2, here: 2, elsewhere: 2 })
  assert.deepEqual(syncSplit(undefined, me), { private: 0, here: 0, elsewhere: 0 })
})

test('the presence band is this machine\'s, null until the poll answers', () => {
  const presence = Array.from({ length: 48 }, (_, i) => i % 2 === 0)
  const machines = [
    { machine: { id: 'm-1', this_machine: false }, presence: [true] },
    { machine: { id: 'm-2', this_machine: true }, presence },
  ]
  assert.equal(machinePresence(machines), presence)
  assert.equal(machinePresence([{ machine: { id: 'm-2', this_machine: true } }]), null)
  assert.equal(machinePresence(undefined), null)
  assert.equal(machinePresence([]), null)
})

// The strip and the band are bars with no numbers on them, so the caption is
// the only thing that says what a bar is. The date comes in as a labeller, so
// these sentences are pinned without depending on the machine's locale.
const label = (ms) => `day${ms}`

test('the strip\'s caption names the window and its busiest day', () => {
  const days = [
    { start: 1, count: 2 },
    { start: 2, count: 6 },
    { start: 3, count: 0 },
    { start: 4, count: 1 },
  ]
  assert.equal(newChatsLine(days, label), '4 days to day4, busiest 6 chats on day2')
})

test('one chat is not "chats", and a tie names the most recent busiest day', () => {
  assert.equal(
    newChatsLine([{ start: 1, count: 1 }], label),
    '1 day to day1, busiest 1 chat on day1',
  )
  assert.equal(
    newChatsLine(
      [
        { start: 10, count: 3 },
        { start: 20, count: 3 },
        { start: 30, count: 0 },
      ],
      label,
    ),
    '3 days to day30, busiest 3 chats on day20',
  )
})

test('a window with no chats in it still names its end', () => {
  assert.equal(newChatsLine([{ start: 7, count: 0 }], label), '1 day to day7')
  assert.equal(newChatsLine([], label), '')
  assert.equal(newChatsLine(undefined, label), '')
})

test('the band\'s caption counts the hours it was online', () => {
  const cells = (on) => Array.from({ length: 48 }, (_, i) => i < on)
  assert.equal(
    presenceLine(cells(19)),
    'online 9.5 hours of the last 24, each cell is half an hour',
  )
  assert.equal(presenceLine(cells(48)), 'online 24 hours of the last 24, each cell is half an hour')
  assert.equal(presenceLine(cells(2)), 'online 1 hour of the last 24, each cell is half an hour')
  assert.equal(presenceLine(cells(0)), 'online 0 hours of the last 24, each cell is half an hour')
  assert.equal(presenceLine(undefined), '')
  assert.equal(presenceLine([]), '')
})
