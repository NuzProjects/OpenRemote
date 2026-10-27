import assert from 'node:assert/strict'
import test from 'node:test'

import { BASE_TITLE, attentionTitle, isWaiting, needsYou } from './needs-you.js'

// The rows the sidebar builds: the live status of a chat on screen, the status
// the poll carried for it, and when it last said anything.
const row = (id, liveStatus, polledStatus, updatedAt, extra = {}) => ({
  id,
  liveStatus,
  polledStatus,
  updatedAt,
  ...extra,
})

test('a chat is waiting when either the live status or the poll says so', () => {
  assert.equal(isWaiting('waiting', 'waiting'), true)
  assert.equal(isWaiting('waiting', 'running'), true, 'the fresher live status answers')
  assert.equal(isWaiting(null, 'waiting'), true, 'an unopened chat is only in the poll')
  assert.equal(isWaiting(undefined, 'waiting'), true)
})

test('a running or stopped chat is not waiting, even when the poll lags', () => {
  assert.equal(isWaiting('running', 'waiting'), false, 'answered, so the poll beat is stale')
  assert.equal(isWaiting('stopped', 'waiting'), false)
  assert.equal(isWaiting('idle', 'idle'), false)
  assert.equal(isWaiting(null, null), false)
  assert.equal(isWaiting(undefined, undefined), false)
})

test('only waiting chats are listed, oldest wait first', () => {
  const rows = [
    row('c', null, 'waiting', 3000),
    row('a', 'waiting', 'waiting', 1000),
    row('b', 'running', 'running', 2000),
    row('d', null, 'waiting', 2000),
  ]
  const needs = needsYou(rows)
  assert.deepEqual(
    needs.chats.map((c) => c.id),
    ['a', 'd', 'c'],
    'the first question asked is the one starving',
  )
  assert.equal(needs.count, 3)
})

test('two waits on the same beat keep a stable order', () => {
  const rows = [row('z', null, 'waiting', 4000), row('m', null, 'waiting', 4000)]
  assert.deepEqual(
    needsYou(rows).chats.map((c) => c.id),
    ['m', 'z'],
    'ties break by id, never by poll order',
  )
  assert.deepEqual(
    needsYou([...rows].reverse()).chats.map((c) => c.id),
    ['m', 'z'],
    'the same answer whichever way the poll listed them',
  )
})

test('a copy whose device is away is left out', () => {
  const rows = [
    row('copy', null, 'waiting', 1000, { offline: true }),
    row('here', null, 'waiting', 2000),
  ]
  const needs = needsYou(rows)
  assert.deepEqual(needs.chats.map((c) => c.id), ['here'])
  assert.equal(needs.count, 1)
})

test('a waiting chat on another device that is still reachable stays in', () => {
  // Its harness is holding a question open right now, and the console
  // forwards the answer to the device running the chat, so a person here can
  // settle it. Only a row whose device is away is dropped.
  const rows = [
    row('remote', null, 'waiting', 1000, { offline: false, executor: 'dev-box' }),
    row('here', null, 'waiting', 2000),
  ]
  const needs = needsYou(rows)
  assert.deepEqual(needs.chats.map((c) => c.id), ['remote', 'here'], 'oldest wait first, both of them')
  assert.equal(needs.count, 2)
})

test('nothing waiting is an empty list, not a header', () => {
  assert.deepEqual(needsYou([]), { chats: [], count: 0 })
  assert.deepEqual(needsYou(undefined), { chats: [], count: 0 })
  assert.deepEqual(needsYou([row('a', 'running', 'running', 10)]), { chats: [], count: 0 })
})

test('a malformed row cannot break the list', () => {
  const rows = [null, undefined, {}, row('a', null, 'waiting', undefined)]
  const needs = needsYou(rows)
  assert.deepEqual(needs.chats.map((c) => c.id), ['a'])
  assert.equal(needs.count, 1)
})

test('the title carries the count only while the window is not looked at', () => {
  assert.equal(attentionTitle('OpenRemote', 0, false), 'OpenRemote')
  assert.equal(attentionTitle('OpenRemote', 2, true), 'OpenRemote', 'looking clears it')
  assert.equal(attentionTitle('OpenRemote', 2, false), '2 waiting - OpenRemote')
  assert.equal(attentionTitle('OpenRemote', 1, false), '1 waiting - OpenRemote')
})

test('the title is never invented when the document has none', () => {
  assert.equal(attentionTitle('', 0, true), '', 'nothing to say, nothing touched')
  assert.equal(attentionTitle('', 2, false), `2 waiting - ${BASE_TITLE}`)
  assert.equal(attentionTitle(undefined, 0, false), '')
  assert.equal(attentionTitle(null, 1, false), `1 waiting - ${BASE_TITLE}`)
})

test('a count that is not a number reads as nothing waiting', () => {
  assert.equal(attentionTitle('OpenRemote', undefined, false), 'OpenRemote')
  assert.equal(attentionTitle('OpenRemote', Number.NaN, false), 'OpenRemote')
  assert.equal(attentionTitle('OpenRemote', -1, false), 'OpenRemote')
})
