import assert from 'node:assert/strict'
import test from 'node:test'

import { dotKind, rollup } from './sidebar-groups.js'

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
