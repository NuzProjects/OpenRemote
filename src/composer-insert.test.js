import test from 'node:test'
import assert from 'node:assert/strict'
import { claimInserter, insertToComposer, resetInserter } from './composer-insert.js'

test('insert with no composer claimed returns false', () => {
  resetInserter()
  assert.equal(insertToComposer('hello'), false)
})

test('insert reaches the claiming composer', () => {
  resetInserter()
  const seen = []
  claimInserter((text) => seen.push(text))
  assert.equal(insertToComposer('hello'), true)
  assert.deepEqual(seen, ['hello'])
})

test('the latest claim wins', () => {
  resetInserter()
  const first = []
  const second = []
  claimInserter((text) => first.push(text))
  claimInserter((text) => second.push(text))
  insertToComposer('hi')
  assert.deepEqual(first, [])
  assert.deepEqual(second, ['hi'])
})

test('reset forgets the claim', () => {
  resetInserter()
  claimInserter(() => {
    throw new Error('should not be called')
  })
  resetInserter()
  assert.equal(insertToComposer('hi'), false)
})
