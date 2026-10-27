// A removal lock claims once per press, and the second press in the same frame
// is the one React state cannot stop: both presses read the pre-render state,
// so the claim, not the state, is what makes one request.

import assert from 'node:assert/strict'
import test from 'node:test'
import { createRemovalLock } from './removal-lock.js'

test('the second press in the same frame is refused, and the lock frees on release', () => {
  const lock = createRemovalLock()
  assert.equal(lock.claim('endpoint-a'), true, 'the first press claims')
  // Same frame: nothing has rendered, so state would still say "nothing
  // running"; the lock already knows better.
  assert.equal(lock.claim('endpoint-a'), false, 'a double click sends one request')
  assert.equal(lock.claim('endpoint-b'), false, 'and a different row cannot slip in either')
  assert.equal(lock.current(), 'endpoint-a')
  lock.release()
  assert.equal(lock.claim('endpoint-b'), true, 'the next removal after release is allowed')
})

test('a release with no claim is harmless, and a claim survives repeated reads', () => {
  const lock = createRemovalLock()
  lock.release()
  assert.equal(lock.current(), null)
  assert.equal(lock.claim('x'), true)
  assert.equal(lock.claim('x'), false)
  assert.equal(lock.current(), 'x')
})
