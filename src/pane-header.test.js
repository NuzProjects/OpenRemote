// What a pane's header says, as rules: which chat a pane is about, and the
// parts a header shows for a chat pane against a role pane. The rendering is
// pinned in pane-layouts-wiring.test.js.

import assert from 'node:assert/strict'
import test from 'node:test'
import { paneChatId, paneHeader } from './pane-header.js'

test('a leaf names its own chat, and the primary is told which chat is on screen', () => {
  // A split pane carries its own view.
  assert.equal(paneChatId('chat-7'), 'chat-7')
  // The primary pane keeps its view in the shell, so the leaf's null view means
  // "ask the shell", not "no chat".
  assert.equal(paneChatId(null, 'chat-2'), 'chat-2')
  assert.equal(paneChatId(undefined, 'chat-2'), 'chat-2')
  // A primary pane showing a page has no chat at all.
  assert.equal(paneChatId(null, null), null)
  // The composer's own view is not a chat record, so it falls through to the
  // role name at the call site.
  assert.equal(paneChatId('new', 'chat-2'), 'new')
})

test('a chat pane says its title, project, harness and status', () => {
  const chat = { id: 'chat-7', title: 'Fix the parser', harness: 'codex', status: 'running', workspace: 'C:\\work\\parser' }
  const project = { id: 'p1', folders: ['C:\\work\\parser'] }
  const head = paneHeader({ label: 'Fix the parser', chat, project })
  assert.deepEqual(head, {
    chat: true,
    title: 'Fix the parser',
    project: 'parser',
    harness: 'codex',
    status: 'running',
  })
})

test('the title is the shell label, and a chat with no project or harness says so', () => {
  const chat = { id: 'chat-7', title: 'A chat', harness: null, status: null }
  const head = paneHeader({ label: 'A chat', chat })
  assert.equal(head.title, 'A chat')
  assert.equal(head.project, null, 'a chat outside every project has no project part')
  assert.equal(head.harness, null, 'no harness means no mark')
  // A chat the console has no live status for reads as idle, the sidebar's own
  // fallback (its dot is hidden for idle).
  assert.equal(head.status, 'idle')
  // The label wins over a stale record title: one pane, one title.
  assert.equal(paneHeader({ label: 'Renamed', chat: { title: 'Old name' } }).title, 'Renamed')
})

test('a pane holding no chat keeps its role name and grows nothing', () => {
  for (const label of ['New chat', 'Plugins', 'Settings', 'Chat']) {
    assert.deepEqual(paneHeader({ label }), {
      chat: false,
      title: label,
      project: null,
      harness: null,
      status: null,
    })
  }
  assert.deepEqual(paneHeader({}), { chat: false, title: '', project: null, harness: null, status: null })
})

test('every status the console reports passes through untouched', () => {
  // The dot's language is the stylesheet's (running, waiting, idle); the header
  // is not allowed to keep a status list of its own, so anything the console
  // says travels and a status with no dot style draws nothing.
  for (const status of ['starting', 'running', 'waiting', 'idle', 'stopped', 'failed']) {
    assert.equal(paneHeader({ label: 'x', chat: { status } }).status, status)
  }
})
