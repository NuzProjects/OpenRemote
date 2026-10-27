// The two-step confirm the plugins, MCP servers and endpoint panes share.
// What matters is not that a row can be armed, it is that only one row is
// armed at a time: an armed row that is off screen is a button the user
// no longer remembers pressing.

import assert from 'node:assert/strict'
import test from 'node:test'
import { armRow, clearRow, rowIsArmed } from './row-confirm.js'

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
