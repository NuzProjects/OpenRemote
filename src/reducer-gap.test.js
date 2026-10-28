// An event the fold cannot read is a gap the transcript announces, not a pane that
// redials for ever and not a crash that takes the batch with it.
import test from 'node:test'
import assert from 'node:assert/strict'

import { foldEvents } from './state/reducer.js'

const chat = () => ({ id: 'c1', status: 'idle', timeline: [], foldedSeq: 0 })

test('a malformed event becomes a note and the cursor moves past it', () => {
  // 590b54f moved the cursor after a successful fold, which stopped an event being
  // consumed by a throw but made every retry re-deliver it: the batch threw, the pane
  // failed, the redial replayed the same event. The guard is per event.
  const record = chat()
  foldEvents(record, [
    { type: 'message.added', seq: 1, message: { role: 'user', text: 'hi', turn: 1 } },
    { type: 'session.created', seq: 2, session: undefined },
    { type: 'message.added', seq: 3, message: { role: 'user', text: 'after', turn: 1 } },
  ])
  assert.equal(record.timeline.length, 3, 'the good events either side still land')
  assert.ok(
    record.timeline.some((item) => item.role === 'note' && /could not be read/.test(item.text)),
    'and the unreadable one is announced',
  )
  assert.equal(record.foldedSeq, 3, 'the cursor moved past all three')
})
