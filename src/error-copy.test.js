// The error copy's rules, pinned: no bare status code, no "something went
// wrong", the daemon's words quoted as its own, and an unknown cause saying so.

import assert from 'node:assert/strict'
import test from 'node:test'
import { UNREACHABLE, consoleError, errorCopy } from './error-copy.js'

const failed = (status, message) => Object.assign(new Error(message), { status })

test('a daemon refusal quotes the daemon, and names the status only when it has no words', () => {
  const refused = errorCopy(failed(409, 'this chat runs on another device'))
  assert.equal(refused, 'The daemon refused this: “this chat runs on another device”.')
  // No words: the number is inside a sentence, never the whole message.
  assert.equal(errorCopy(failed(500, 'HTTP 500')), 'The daemon answered 500 and gave no reason for it.')
  assert.equal(errorCopy(failed(404, '')), 'The daemon answered 404 and gave no reason for it.')
  for (const line of [refused, errorCopy(failed(500, 'HTTP 500'))]) {
    assert.doesNotMatch(line, /^HTTP \d+$/, 'never a bare status code')
    assert.doesNotMatch(line, /something went wrong/i)
  }
})

test('a request that never landed says the daemon was not reached, and what to do', () => {
  const closed = new TypeError('Failed to fetch')
  assert.equal(errorCopy(closed), `${UNREACHABLE} Check that it is running, then try again.`)
  assert.equal(errorCopy(new Error('Load failed')), `${UNREACHABLE} Check that it is running, then try again.`)
})

test('the console repeats its own sentence instead of quoting it', () => {
  assert.equal(errorCopy(new Error('The daemon did not answer in time')), 'The daemon did not answer in time. Try again.')
  assert.equal(
    errorCopy(failed(504, 'SSE HTTP 504')),
    'The live stream to the daemon dropped. The console is reconnecting on its own.',
  )
})

test('an unknown cause says so, and a stranger\'s words are quoted', () => {
  assert.equal(errorCopy(null), 'The console does not know why this failed. Try again.')
  assert.equal(errorCopy(new Error('')), 'The console does not know why this failed. Try again.')
  assert.equal(errorCopy('a string was thrown'), 'The console could not do this: “a string was thrown”.')
})

test('a field-naming validation sentence survives being quoted', () => {
  // The daemon's 422 names the field; quoting must not shorten or replace it.
  const line = errorCopy(failed(422, 'workspace must be an absolute path'))
  assert.equal(line, 'The daemon refused this: “workspace must be an absolute path”.')
})

test("the console's own check is repeated without quotes, and blamed on nobody", () => {
  const line = errorCopy(consoleError('An archive needs a .zip, .tar.gz or .tgz name.'))
  assert.equal(line, 'The console could not do this: An archive needs a .zip, .tar.gz or .tgz name.')
  assert.doesNotMatch(line, /“/)
  assert.doesNotMatch(line, /something outside/i)
})

test('an unmarked error from nowhere in particular names no culprit', () => {
  const line = errorCopy(new Error('the disk is full'))
  assert.equal(line, 'The console could not do this: “the disk is full”.')
  assert.doesNotMatch(line, /something outside/i)
})
