// A dragged chat is its own type, and only that type tints a pane: a text
// selection carries text/plain, so the old test could promise a drop that the
// release would refuse. The prefixed text/plain payload stays readable for
// anything older.

import assert from 'node:assert/strict'
import test from 'node:test'
import { CHAT_DRAG, CHAT_DRAG_TYPE, acceptsChatDrop, chatDragPayload, draggedChat } from './split.js'

const transfer = (data) => ({ getData: (type) => data[type] ?? '' })

test('only the private chat type is a chat drop', () => {
  assert.equal(CHAT_DRAG_TYPE, 'application/x-openremote-chat')
  assert.equal(acceptsChatDrop([CHAT_DRAG_TYPE]), true)
  assert.equal(acceptsChatDrop([CHAT_DRAG_TYPE, 'text/plain']), true)
  assert.equal(acceptsChatDrop(['text/plain']), false, 'a selected paragraph is not a chat')
  assert.equal(acceptsChatDrop(['Files', 'text/plain']), false, 'a file is not a chat')
  assert.equal(acceptsChatDrop(null), false)
  assert.equal(acceptsChatDrop([]), false)
})

test('the payload reads the private type first and the old prefix second', () => {
  assert.equal(draggedChat(transfer({ [CHAT_DRAG_TYPE]: 'chat-1' })), 'chat-1')
  assert.equal(draggedChat(transfer({ 'text/plain': chatDragPayload('chat-2') })), 'chat-2', 'an older writer')
  assert.equal(draggedChat(transfer({ 'text/plain': 'just a paragraph' })), '')
  assert.equal(draggedChat(transfer({})), '')
  assert.equal(draggedChat(null), '')
  // Both at once: the private type wins, because it is the one a chat source
  // wrote and a text selection cannot have written it.
  assert.equal(draggedChat(transfer({ [CHAT_DRAG_TYPE]: 'chat-3', 'text/plain': chatDragPayload('other') })), 'chat-3')
})
