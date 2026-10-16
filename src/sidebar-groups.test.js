import assert from 'node:assert/strict'
import test from 'node:test'

import { dotKind, pageOf, pinnedRows, rollup } from './sidebar-groups.js'

test('a chat wears the dot that matters most: waiting, failed, done-not-seen, then its status', () => {
  assert.equal(dotKind({ status: 'waiting', unseen: true }), 'waiting')
  assert.equal(dotKind({ status: 'failed', unseen: true }), 'failed')
  assert.equal(dotKind({ status: 'idle', unseen: true }), 'unseen')
  assert.equal(dotKind({ status: 'running', unseen: true }), 'unseen')
  assert.equal(dotKind({ status: 'running' }), 'running')
  assert.equal(dotKind({ status: 'idle' }), 'idle')
})

test('a copy on an away device shows a ring, not its stale status - but still what this device saw', () => {
  assert.equal(dotKind({ status: 'running', offline: true }), 'offline')
  assert.equal(dotKind({ status: 'waiting', offline: true }), 'offline')
  assert.equal(dotKind({ status: 'idle', offline: true, unseen: true }), 'unseen')
})

test('a folded project shows the most urgent state inside it', () => {
  assert.equal(rollup(['running', 'idle', 'waiting', 'failed']), 'waiting')
  assert.equal(rollup(['running', 'failed', 'unseen']), 'failed')
  assert.equal(rollup(['running', 'unseen', 'idle']), 'unseen')
  assert.equal(rollup(['idle', 'running']), 'running')
  assert.equal(rollup(['starting', 'idle']), 'running')
})

test('a project with nothing to say rolls up to no mark at all', () => {
  assert.equal(rollup([]), null)
  assert.equal(rollup(['idle', 'stopped', 'offline']), null)
})

test('pinned chats keep the order they were pinned in, and a pin without a chat is skipped', () => {
  const rows = [{ id: 'a' }, { id: 'b' }, { id: 'c' }]
  assert.deepEqual(pinnedRows(rows, ['c', 'gone', 'a']).map((r) => r.id), ['c', 'a'])
  assert.deepEqual(pinnedRows(rows, []), [])
})

const chats = (n) => Array.from({ length: n }, (_, i) => ({ id: `c${i}` }))

test('a project shows its five most recent chats, and says how many more it can bring', () => {
  const out = pageOf(chats(12), { page: 5 })
  assert.deepEqual(out.shown.map((c) => c.id), ['c0', 'c1', 'c2', 'c3', 'c4'])
  assert.equal(out.rest.length, 7)
  assert.equal(out.next, 5)
  // Asking again brings the next five, then what is left.
  assert.equal(pageOf(chats(12), { page: 5, pages: 1 }).shown.length, 10)
  assert.equal(pageOf(chats(12), { page: 5, pages: 1 }).next, 2)
  assert.equal(pageOf(chats(12), { page: 5, pages: 2 }).rest.length, 0)
})

test('a short list shows whole, with nothing to ask for', () => {
  const out = pageOf(chats(3), { page: 5 })
  assert.equal(out.shown.length, 3)
  assert.equal(out.rest.length, 0)
  assert.equal(out.next, 0)
})

test('a chat that needs you, or is open, stays in view wherever it sits - and is not counted twice', () => {
  const keep = (c) => c.id === 'c8'
  const out = pageOf(chats(12), { page: 5, keep })
  assert.deepEqual(out.shown.map((c) => c.id), ['c0', 'c1', 'c2', 'c3', 'c4', 'c8'])
  assert.equal(out.rest.length, 6)
  // The next five are c5..c9 - but c8 is already on screen, so four are new.
  assert.equal(out.next, 4)
})
