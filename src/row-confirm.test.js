// The two-step confirm the plugins, MCP servers and endpoint panes share.
// What matters is not that a row can be armed, it is that only one row is
// armed at a time: an armed row that is off screen is a button the user
// no longer remembers pressing.

import assert from 'node:assert/strict'
import test from 'node:test'
import { armAfter, armRow, clearRow, rowIsArmed } from './row-confirm.js'

test('arming a second row replaces the first, so one row is armed at a time', () => {
  const first = armRow(null, 'alpha')
  assert.equal(first, 'alpha')
  const second = armRow(first, 'beta')
  assert.equal(second, 'beta')
  assert.equal(rowIsArmed(second, 'alpha'), false)
  assert.equal(rowIsArmed(second, 'beta'), true)
})

test('arming the row that is already armed leaves it armed', () => {
  assert.equal(armRow('beta', 'beta'), 'beta')
})

test('a row with no id cannot arm, so a record mid-load never arms something else', () => {
  assert.equal(armRow('beta', null), 'beta')
  assert.equal(armRow(null, undefined), null)
})

test('clearing arms nothing', () => {
  assert.equal(clearRow(), null)
  assert.equal(rowIsArmed(null, 'beta'), false)
})

test('the predicates never treat a missing id as a match', () => {
  assert.equal(rowIsArmed('beta', null), false)
  assert.equal(rowIsArmed(undefined, 'beta'), false)
  assert.equal(rowIsArmed(null, null), false)
})

test('an armed row stands while it is in view and focused', () => {
  assert.equal(armAfter('beta', 'beta', { visible: true, focused: true }), 'beta')
  // No news about either is news about neither: the arm stands.
  assert.equal(armAfter('beta', 'beta'), 'beta')
})

test('scrolling the armed row out of view ends the arm', () => {
  // The user pressed Remove, scrolled on, and now means something else.
  assert.equal(armAfter('beta', 'beta', { visible: false, focused: true }), null)
})

test('losing focus ends the arm', () => {
  assert.equal(armAfter('beta', 'beta', { visible: true, focused: false }), null)
})

test('an event about another row never disarms the armed one', () => {
  // A stale observer or blur from the row above must not lift beta's arm.
  assert.equal(armAfter('beta', 'alpha', { visible: false, focused: false }), 'beta')
  assert.equal(armAfter(null, 'beta', { visible: false, focused: false }), null)
})

