import assert from 'node:assert/strict'
import test from 'node:test'
import { keepNav, pruneNav, sameNav } from './nav.js'

const nav = (...history) => ({ history, hIndex: history.length - 1 })

test('a rebuilt navigation with the same views is the same navigation', () => {
  const a = nav('new')
  const b = nav('new')
  assert.notEqual(a, b, 'the two objects are different, which is what a beat makes')
  assert.equal(sameNav(a, b), true, 'and their value is the same, which is what the shell cares about')
  assert.equal(sameNav(a, a), true)
  assert.equal(keepNav(a, b), a, 'so the shell keeps the object it already had')
})

test('a different place in the same history is a change', () => {
  const a = { history: ['new', 'chat-1'], hIndex: 1 }
  const b = { history: ['new', 'chat-1'], hIndex: 0 }
  assert.equal(sameNav(a, b), false)
  const next = keepNav(a, b)
  assert.equal(next, b, 'the new place is stored')
})

test('a different view, a different history, and a missing view are changes', () => {
  assert.equal(sameNav(nav('new', 'chat-1'), nav('new', 'chat-2')), false, 'one id differs')
  assert.equal(sameNav(nav('new'), nav('new', 'chat-1')), false, 'a longer history')
  assert.equal(sameNav(nav('new', 'chat-1'), nav('new')), false, 'a shorter history')
  assert.equal(
    sameNav({ history: ['new', 'chat-1'], hIndex: 0 }, { history: ['new', 'chat-1'], hIndex: 0 }),
    true,
    'the same place in a two-step history',
  )
})

test('an empty or missing history never throws and never claims a change it cannot see', () => {
  assert.equal(sameNav({ history: [], hIndex: 0 }, { history: [], hIndex: 0 }), true)
  assert.equal(sameNav({ hIndex: 0 }, { hIndex: 0 }), true, 'no history on either side')
  assert.equal(sameNav({ history: ['new'], hIndex: 0 }, { hIndex: 0 }), false, 'one side has none')
  assert.equal(sameNav(null, nav('new')), false)
  assert.equal(sameNav(nav('new'), null), false)
  assert.equal(sameNav(null, null), true)
})

test('keepNav is identity-preserving exactly when the state is unchanged', () => {
  const a = nav('new', 'chat-1')
  const same = { history: ['new', 'chat-1'], hIndex: 1 }
  const moved = { history: ['new', 'chat-1'], hIndex: 0 }
  assert.equal(keepNav(a, same), a)
  assert.equal(keepNav(a, moved), moved)
  // The shell calls it as a state updater: an unchanged beat must hand back
  // the very object React already has.
  assert.equal(keepNav(keepNav(a, same), same), a)
})

// ---- pruning the steps whose chat is gone ----

test('nothing known gone leaves the very object, so a beat cannot re-render', () => {
  const a = nav('new', 'chat-1', 'chat-2')
  assert.equal(pruneNav(a, new Set()), a)
  assert.equal(pruneNav(a, new Set(['chat-9'])), a, 'a gone id that is not a step is not a change')
  assert.equal(pruneNav(a, null), a)
})

test('a chat gone from the middle keeps the user where they are', () => {
  // new > chat-1 > chat-2, standing on chat-2. chat-1 is deleted elsewhere:
  // the step goes, and chat-2 stays the current view.
  const pruned = pruneNav({ history: ['new', 'chat-1', 'chat-2'], hIndex: 2 }, new Set(['chat-1']))
  assert.deepEqual(pruned, { history: ['new', 'chat-2'], hIndex: 1 })
})

test('a chat gone under the user falls back to the previous step, not to the top', () => {
  const pruned = pruneNav({ history: ['new', 'chat-1', 'chat-2'], hIndex: 2 }, new Set(['chat-2']))
  assert.deepEqual(pruned, { history: ['new', 'chat-1'], hIndex: 1 }, 'the step before the deleted one')
  // The first step gone while the user is on it: the next remaining one.
  const head = pruneNav({ history: ['chat-1', 'new'], hIndex: 0 }, new Set(['chat-1']))
  assert.deepEqual(head, { history: ['new'], hIndex: 0 })
})

test('every step gone leaves nothing to stand on', () => {
  const pruned = pruneNav({ history: ['chat-1', 'chat-2'], hIndex: 1 }, new Set(['chat-1', 'chat-2']))
  assert.deepEqual(pruned, { history: [], hIndex: 0 })
})
