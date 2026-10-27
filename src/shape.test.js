// The three coercions every daemon-shaped value goes through, and the one
// property that matters most: an encoded id cannot leave the path segment it
// was meant for, while a raw one can. The second half of that pair is the
// hazard this file exists to prevent, so it is asserted too.

import assert from 'node:assert/strict'
import test from 'node:test'
import { list, seg, text } from './shape.js'

test('an encoded id stays in its segment, where a raw one changes the route', () => {
  const hostile = '../automations/abc'
  // The hazard: a chat's delete aimed at a rule's delete.
  assert.equal(new URL(`http://daemon/sessions/${hostile}`).pathname, '/automations/abc')
  // The fix: the same id is one segment, so the route cannot move.
  assert.equal(
    new URL(`http://daemon/sessions/${seg(hostile)}`).pathname,
    '/sessions/..%2Fautomations%2Fabc',
  )
  // A plugin id is a name and a marketplace, and the @ survives as data.
  assert.equal(seg('clash@local'), 'clash%40local')
  assert.equal(new URL(`http://daemon/plugins/${seg('a/../b')}/enabled`).pathname, '/plugins/a%2F..%2Fb/enabled')
  assert.equal(seg(null), '')
  assert.equal(seg(7), '7')
})

test('text gives a string for anything, and empty for a shape that has none', () => {
  assert.equal(text('claude'), 'claude')
  assert.equal(text(7), '7')
  assert.equal(text(true), 'true')
  assert.equal(text(null), '')
  assert.equal(text(undefined), '')
  // An object is not "[object Object]" on screen: it is nothing.
  assert.equal(text({ name: 'x' }), '')
  assert.equal(text(['a']), '')
  // The point of the coercion: a name from the daemon can go to localeCompare.
  assert.doesNotThrow(() => text({}).localeCompare('x'))
})

test('list gives an array for anything, and empty for a shape that is not one', () => {
  assert.deepEqual(list([1, 2]), [1, 2])
  assert.deepEqual(list(null), [])
  assert.deepEqual(list(undefined), [])
  assert.deepEqual(list({}), [])
  assert.deepEqual(list('three'), [])
  // A malformed answer behaves like a server with nothing to say.
  assert.deepEqual(list({}).filter(() => true), [])
})
