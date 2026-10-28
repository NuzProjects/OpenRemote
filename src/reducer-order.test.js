// The fold cursor moved past an event the timeline never took. (A second fix in the same
// commit, gating the merge on `beatIsNewer`, was reverted: a fold carries no stamp of its
// own, so comparing a payload against the record's `updatedAt` compared it against the
// last beat and the stale beat still won. Removing that half is deliberate.)
import test from 'node:test'
import assert from 'node:assert/strict'

import { foldEvent } from './state/reducer.js'

test('the fold cursor moves only past an event the timeline took', () => {
  // A payload that throws while folding used to consume its own seq, so every replay from
  // that cursor (a reopen, a reconnect) skipped the event and the transcript kept a hole.
  const chat = { id: 'c1', status: 'idle', timeline: [], foldedSeq: null }
  foldEvent(chat, { type: 'message.added', seq: 1, message: { role: 'user', text: 'hi', turn: 1 } })
  assert.equal(chat.foldedSeq, 1, 'a folded event advances the cursor')

  // A malformed payload throws and leaves the cursor where it was.
  const broken = { id: 'c1', status: 'idle', timeline: [], foldedSeq: 1 }
  assert.throws(() => foldEvent(broken, { type: 'session.created', seq: 2, session: undefined }))
  assert.equal(broken.foldedSeq, 1, 'the replay retries the event it never folded')

  // And a replayed event is still a duplicate, not a second fold.
  const again = { id: 'c1', status: 'idle', timeline: [], foldedSeq: 2 }
  const before = again.timeline.length
  foldEvent(again, { type: 'message.added', seq: 2, message: { role: 'user', text: 'hi', turn: 1 } })
  assert.equal(again.timeline.length, before, 'the cursor still de-duplicates')
})
