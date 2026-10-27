// The send bound: what a message may carry, and the two sentences that say
// so. The daemon refuses an oversized body with 413 and an empty payload, so
// the composer has to know the number before it sends and the client has to
// say the same number after a refusal.

import assert from 'node:assert/strict'
import test from 'node:test'
import {
  MAX_MESSAGE_BYTES,
  TOO_LONG_SENTENCE,
  messageBound,
  messageBytes,
  tooLongMessage,
} from './send-bound.js'

test('the size counted is the wire size, not the character count', () => {
  assert.equal(messageBytes('hello'), 5)
  // An emoji is four bytes: a character count would pass a message the
  // daemon would refuse.
  assert.equal(messageBytes('🙂'), 4)
  assert.equal(messageBytes(''), 0)
  assert.equal(messageBytes(null), 0)
})

test('a message that fits has no sentence, one over it names both numbers', () => {
  assert.equal(messageBound('a short note'), null)
  assert.equal(messageBound('x'.repeat(MAX_MESSAGE_BYTES)), null, 'exactly at the limit still fits')
  const over = messageBound('x'.repeat(MAX_MESSAGE_BYTES + 1))
  assert.match(over, /That message is 2\.0 MB/)
  assert.match(over, /at most 2\.0 MB/)
  assert.match(over, /Split it, or attach it as a file/)
  // The sentence a refusal gets names the limit without pretending to know
  // the size that was refused.
  assert.match(TOO_LONG_SENTENCE, /too long/)
  assert.match(TOO_LONG_SENTENCE, /at most 2\.0 MB/)
})

test('the over-limit sentence reports the real size of the message', () => {
  const bytes = MAX_MESSAGE_BYTES + 900_000
  assert.match(tooLongMessage(bytes), /That message is 2\.9 MB\./)
})
