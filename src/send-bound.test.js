// The send bound: what a message may carry, and the two sentences that say
// so. The daemon refuses an oversized body with 413 and an empty payload, so
// the composer has to know the number before it sends and the client has to
// say the same number after a refusal.

import assert from 'node:assert/strict'
import test from 'node:test'
import {
  ENVELOPE_RESERVE_BYTES,
  MAX_MESSAGE_BYTES,
  TOO_LONG_SENTENCE,
  messageBound,
  messageBytes,
  tooLongMessage,
  wireBytes,
} from './send-bound.js'

// The longest text that fits: the serialised string (that is the two quotes
// JSON adds) plus the envelope reserve has to stay at or under the bound.
const FITS = MAX_MESSAGE_BYTES - ENVELOPE_RESERVE_BYTES - 2

test('the size counted is the wire size, not the character count', () => {
  assert.equal(messageBytes('hello'), 5)
  // An emoji is four bytes: a character count would pass a message the
  // daemon would refuse.
  assert.equal(messageBytes('🙂'), 4)
  assert.equal(messageBytes(''), 0)
  assert.equal(messageBytes(null), 0)
})

test('the body size is the escaped text plus the envelope reserve', () => {
  // A short text: the JSON quotes, then the reserve for the rest of the
  // request.
  assert.equal(wireBytes('hello'), 7 + ENVELOPE_RESERVE_BYTES)
  assert.equal(wireBytes(''), 2 + ENVELOPE_RESERVE_BYTES)
  assert.equal(wireBytes(null), 0)
  // A newline is one byte in the text and two in the body.
  assert.equal(messageBytes('\n\n'), 2)
  assert.equal(wireBytes('\n\n'), 6 + ENVELOPE_RESERVE_BYTES)
  // A quote too: the escaping is the same one the fetch body carries.
  assert.equal(wireBytes('"'), 4 + ENVELOPE_RESERVE_BYTES)
})

test('a message that fits has no sentence, one over it names both numbers', () => {
  assert.equal(messageBound('a short note'), null)
  assert.equal(messageBound('x'.repeat(FITS)), null, 'the longest message that fits still fits')
  const over = messageBound('x'.repeat(FITS + 1))
  assert.match(over, /That message is 2\.0 MB/)
  assert.match(over, /at most 2\.0 MB/)
  assert.match(over, /Split it, or attach it as a file/)
  // The sentence a refusal gets names the limit without pretending to know
  // the size that was refused.
  assert.match(TOO_LONG_SENTENCE, /too long/)
  assert.match(TOO_LONG_SENTENCE, /at most 2\.0 MB/)
})

test('a newline-heavy message is caught by the body count, not the text count', () => {
  // This is the case the bare-text bound used to let through: the text is
  // under the limit on its own, and its body is over it once every newline is
  // escaped to two bytes.
  const text = '\n'.repeat(MAX_MESSAGE_BYTES / 2 + 1)
  assert.equal(messageBytes(text) <= MAX_MESSAGE_BYTES, true, 'the text alone would pass')
  assert.match(messageBound(text), /That message is 2\.0 MB/, 'the body count refuses it')
})

test('the over-limit sentence reports the real size of the message', () => {
  const bytes = MAX_MESSAGE_BYTES + 900_000
  assert.match(tooLongMessage(bytes), /That message is 2\.9 MB\./)
})
