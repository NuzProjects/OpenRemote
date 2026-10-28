// The two places a chat record could hold the wrong answer: a beat taken before an
// event the stream already folded, and a cursor that moved past an event that never
// reached the timeline.
import test from 'node:test'
import assert from 'node:assert/strict'

import { foldEvent, mergeSessionIntoChat } from './state/reducer.js'

const session = (over = {}) => ({
  id: 'c1',
  title: 'A chat',
  status: 'running',
  workspace: null,
  updated_at: 2000,
  ...over,
})

test('a beat older than a folded event does not put the old status back', () => {
  // The poll runs every few seconds; the stream can fold a turn end in between. The
  // title was gated on the snapshot's stamp and the status was not, so finishing a turn
  // flickered back to running for one beat, and an error line vanished the same way.
  const folded = {
    id: 'c1',
    title: 'A chat',
    status: 'idle',
    running: false,
    lastError: 'the harness exited',
    queue: [{ id: 'q1' }],
    updatedAt: 3000,
    timeline: [],
  }
  const stale = mergeSessionIntoChat(folded, session({ status: 'running', updated_at: 2000 }))
  assert.equal(stale.status, 'idle', 'the folded turn end stands')
  assert.equal(stale.running, false)
  assert.equal(stale.lastError, 'the harness exited')
  assert.deepEqual(stale.queue, [{ id: 'q1' }])

  // A newer snapshot is still the authority.
  const fresh = mergeSessionIntoChat(folded, session({ status: 'running', updated_at: 4000 }))
  assert.equal(fresh.status, 'running')
  assert.equal(fresh.running, true)
})

test('the fold cursor moves only past an event the timeline took', () => {
  // A payload that throws while folding used to consume its own seq, so every replay
  // from that cursor skipped the event and the transcript kept a hole.
  const chat = { id: 'c1', status: 'idle', timeline: [], foldedSeq: null }
  foldEvent(chat, { type: 'message.added', seq: 1, message: { role: 'user', text: 'hi', turn: 1 } })
  assert.equal(chat.foldedSeq, 1, 'a folded event advances the cursor')

  // A malformed payload throws and leaves the cursor where it was.
  const broken = { id: 'c1', status: 'idle', timeline: [], foldedSeq: 1 }
  assert.throws(() => foldEvent(broken, { type: 'session.created', seq: 2, session: undefined }))
  assert.equal(broken.foldedSeq, 1, 'the replay retries the event it never folded')
})
