// The two numbers that could not be true: a stamp from a clock that is ahead, and a
// total that quietly left a row out.
import test from 'node:test'
import assert from 'node:assert/strict'

import { statusSentence, unknownStatusCount } from './metrics.js'
import { ranLabel } from './ran-label.js'

test('a row with a state this console does not know is named, not dropped', () => {
  // A newer daemon can add a status. The sentence used to describe four chats as
  // three, with nothing saying a row had been left out.
  const rows = [
    { id: 'a', status: 'working' },
    { id: 'b', status: 'stopped' },
    { id: 'c', status: 'hibernating' },
  ]
  assert.equal(unknownStatusCount(rows), 1)
  const sentence = statusSentence(rows)
  assert.match(sentence, /1 running/)
  assert.match(sentence, /1 stopped/)
  assert.match(sentence, /1 with a state this console does not know/)
  // A list this console fully understands says nothing extra.
  assert.doesNotMatch(statusSentence([{ id: 'a', status: 'idle' }]), /does not know/)
  assert.equal(unknownStatusCount([]), 0)
  assert.equal(unknownStatusCount(null), 0)
})

test('a stamp the computer reads as the future is not printed as a past run', () => {
  const now = Date.UTC(2026, 9, 28, 12, 0, 0)
  const hour = 3_600_000
  // An hour ahead: the machine's clock is ahead of this one, so the run is real and
  // its time is not knowable here.
  assert.match(ranLabel({ last_run: now + hour }, now), /reads as the future/)
  // A run a minute ago, and one with a little clock drift, are ordinary.
  assert.match(ranLabel({ last_run: now - hour }, now), /^ran /)
  assert.match(ranLabel({ last_run: now + 1000 }, now), /^ran /)
  // And the older answers are unchanged.
  assert.equal(ranLabel({ last_run: 0 }, now), 'never ran')
  assert.equal(ranLabel({ last_run: Number.NaN }, now), 'ran at an unknown time')
  assert.equal(ranLabel({ last_run: 1e18 }, now), 'ran at an unknown time')
})
