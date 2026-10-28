// The one status vocabulary: the daemon's six session statuses, the console's
// words for them, and the predicates the rest of the console asks of them.
//
// The property worth pinning is that a status answers the same in either
// vocabulary: a module handed "running" (the console's display word) and one
// handed "working" (the daemon's) must not disagree, which is the drift this
// module ended.

import assert from 'node:assert/strict'
import test from 'node:test'
import {
  STATUSES,
  STATUS_WORD,
  canonical,
  displayWord,
  isActive,
  isBusy,
  isRunning,
  isWaiting,
} from './status-words.js'

test('the six statuses, in the order the console reads them', () => {
  assert.deepEqual(STATUSES, ['starting', 'working', 'waiting', 'idle', 'stopped', 'failed'])
  for (const status of STATUSES) {
    assert.equal(typeof STATUS_WORD[status], 'string', `${status} has a word`)
  }
  // Only working differs: the console prints "running" for it, and every other
  // status reads as its own word. A second entry here is the drift returning.
  assert.deepEqual(
    STATUSES.filter((status) => STATUS_WORD[status] !== status),
    ['working'],
  )
  assert.equal(STATUS_WORD.working, 'running')
})

test('a status folds to its daemon word from either vocabulary', () => {
  for (const status of STATUSES) {
    assert.equal(canonical(status), status)
    assert.equal(canonical(displayWord(status)), status, `${displayWord(status)} is ${status}`)
    assert.equal(displayWord(status), STATUS_WORD[status])
  }
  // The one display word the daemon never sends.
  assert.equal(canonical('running'), 'working')
  // Spelling noise is the same status, not a new one.
  assert.equal(canonical(' Working '), 'working')
  assert.equal(canonical('RUNNING'), 'working')
  // Anything else is unknown, and says so rather than guessing.
  for (const unknown of ['processing', '', '   ', null, undefined, 7, {}]) {
    assert.equal(canonical(unknown), null, String(unknown))
    assert.equal(displayWord(unknown), 'idle', 'the console never shows a status it does not know')
  }
})

test('every predicate answers the same for both vocabularies', () => {
  const predicates = { isRunning, isWaiting, isBusy, isActive }
  const expected = {
    isRunning: ['working'],
    isWaiting: ['waiting'],
    isBusy: ['starting', 'working'],
    isActive: ['starting', 'working', 'waiting'],
  }
  for (const [name, yes] of Object.entries(expected)) {
    for (const status of STATUSES) {
      const want = yes.includes(status)
      assert.equal(predicates[name](status), want, `${name}(${status})`)
      assert.equal(predicates[name](displayWord(status)), want, `${name}(${displayWord(status)})`)
    }
    // An unknown status is never any of them, in either spelling.
    assert.equal(predicates[name]('not-a-status'), false, name)
    assert.equal(predicates[name](undefined), false, name)
  }
  // The display word the daemon never sends, spelled out once more: a live
  // turn, not a wait, and a harness that holds the turn.
  assert.equal(isRunning('running'), true)
  assert.equal(isBusy('running'), true)
  assert.equal(isActive('running'), true)
  assert.equal(isWaiting('running'), false)
})
