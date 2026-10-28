// The merge gate, on the stamp an event actually carries: a poll beat older than the
// newest folded event must not put the older answer back, and a newer one must win.
import test from 'node:test'
import assert from 'node:assert/strict'

import { foldEvent, mergeSessionIntoChat } from './state/reducer.js'

const chat = () => ({ id: 'c1', title: 'A chat', status: 'running', running: true, timeline: [], foldedSeq: 0 })

test('a beat older than the newest folded event does not put the old answer back', () => {
  // The daemon stamps every event with when it happened, in the same milliseconds its
  // session payload carries. A beat taken before that moment is the older answer.
  const record = chat()
  foldEvent(record, { type: 'session.status_changed', seq: 5, at: 3000, status: 'stopped', reason: 'the harness exited' })
  assert.equal(record.foldedAt, 3000, 'the fold remembers when the newest event happened')

  const stale = mergeSessionIntoChat(record, {
    id: 'c1',
    title: 'A chat',
    status: 'running',
    updated_at: 2000,
    workspace: null,
  })
  assert.equal(stale.status, 'stopped', 'the folded turn end stands against an older beat')
  assert.equal(stale.running, false)

  const fresh = mergeSessionIntoChat(record, {
    id: 'c1',
    title: 'A chat',
    status: 'running',
    updated_at: 4000,
    workspace: null,
  })
  assert.equal(fresh.status, 'running', 'a newer snapshot is still the authority')
  assert.equal(fresh.running, true)
  assert.equal(fresh.foldedAt, 3000, 'and the fold memory survives the merge')
})

test('a record with no fold behind it compares exactly as it always did', () => {
  // First paint and every fixture: no foldedAt, so the gate reduces to the old test.
  const plain = { id: 'c1', title: 'A chat', status: 'idle', running: false, timeline: [], updatedAt: 2000 }
  const beat = mergeSessionIntoChat(plain, {
    id: 'c1',
    title: 'A chat',
    status: 'running',
    updated_at: 2000,
    workspace: null,
  })
  assert.equal(beat.status, 'running', 'an equal stamp still goes to the beat')
})
