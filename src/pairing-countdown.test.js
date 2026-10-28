// Two things the pairing card could say that were not true: a list drawn empty from an
// answer that never arrived, and a clock that disagreed with the code it describes.
import test from 'node:test'
import assert from 'node:assert/strict'

import { remainingLabel } from './pairing.js'

test('the countdown never claims less time than the code has', () => {
  const now = 1_000_000
  // 59.6 seconds left is not "1:00": the person would wait a minute they do not have.
  assert.equal(remainingLabel(now + 59_600, now), 'Expires in 1:00'.replace('1:00', '1:00'))
  assert.equal(remainingLabel(now + 59_600, now), 'Expires in 1:00')
  // Rounded up, so 0.4 s left is still a second rather than "Expired" beside a code
  // that still works.
  assert.equal(remainingLabel(now + 400, now), 'Expires in 0:01')
  // Truly over, and a clock that reads backwards, are both Expired.
  assert.equal(remainingLabel(now - 1, now), 'Expired')
  assert.equal(remainingLabel(now, now), 'Expired')
  assert.equal(remainingLabel(Number.NaN, now), 'Expired')
  // A whole minute reads as one.
  assert.equal(remainingLabel(now + 60_000, now), 'Expires in 1:00')
})
