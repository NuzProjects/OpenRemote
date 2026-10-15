import assert from 'node:assert/strict'
import test from 'node:test'
import {
  createdPerDay,
  harnessCounts,
  machinePresence,
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
