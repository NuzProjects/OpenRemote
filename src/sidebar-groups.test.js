import assert from 'node:assert/strict'
import test from 'node:test'

import { dotKind } from './sidebar-groups.js'

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
