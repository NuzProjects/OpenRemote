// The setup a chat implies, and the corners that decide it: what a full record
// carries, what a thin one leaves out, and the two cases where the console
// must not offer what the record names (a harness it cannot start, a folder
// from another computer).

import assert from 'node:assert/strict'
import test from 'node:test'
import { canSeedChat, chatSetup } from './chat-setup.js'

const HARNESSES = [
  {
    id: 'claude',
    available: true,
    permission_modes: [
      { w: 'default', l: 'Ask' },
      { w: 'acceptEdits', l: 'Accept edits' },
    ],
  },
  { id: 'codex', available: true, permission_modes: [{ w: 'never', l: 'Auto' }] },
]
const PROJECTS = [
  { id: 'p1', name: 'parser', folders: ['C:\\work\\parser'] },
  { id: 'p2', name: 'site', folders: ['C:\\work\\site'] },
]

const fullChat = {
  id: 'c1',
  harness: 'claude',
  model: 'opus-4.5',
  effort: 'high',
  permissionMode: 'acceptEdits',
  workspace: 'C:\\work\\parser',
  fast: true,
}

test('a full record seeds every field New chat can take', () => {
  assert.deepEqual(chatSetup(fullChat, { harnesses: HARNESSES, projects: PROJECTS, thisDevice: 'here' }), {
    harness: 'claude',
    model: 'opus-4.5',
    effort: 'high',
    permission: 'acceptEdits',
    projectId: 'p1',
  })
})

test('a record that carries less seeds less, never a default', () => {
  // The polled session record: a harness and a folder, no model or effort yet.
  const session = { id: 'c2', harness: 'codex', workspace: 'C:\\work\\site', status: 'idle' }
  assert.deepEqual(chatSetup(session, { harnesses: HARNESSES, projects: PROJECTS }), {
    harness: 'codex',
    projectId: 'p2',
  })
  // A record with no harness at all seeds only the folder's project.
  assert.deepEqual(chatSetup({ workspace: 'C:\\work\\site' }, { harnesses: HARNESSES, projects: PROJECTS }), {
    projectId: 'p2',
  })
  // Nothing at all is an empty setup, not a set of defaults.
  assert.deepEqual(chatSetup({}, { harnesses: HARNESSES, projects: PROJECTS }), {})
  assert.deepEqual(chatSetup(null), {})
})

test('a harness the console cannot offer seeds no harness and none of its words', () => {
  const gone = { ...fullChat, harness: 'agy' }
  // agy is not in this console's offerable list, so its model, effort and
  // permission word would all be another agent's vocabulary. The folder still
  // travels: where the chat lived is true whichever harness ran it.
  assert.deepEqual(chatSetup(gone, { harnesses: HARNESSES, projects: PROJECTS }), { projectId: 'p1' })
  assert.equal(canSeedChat(chatSetup(gone, { harnesses: HARNESSES, projects: PROJECTS })), false)
})

test('effort rides the model, and the approval word must still be listed', () => {
  // No model, no effort: a tier means nothing without the model it was picked on.
  assert.deepEqual(
    chatSetup({ ...fullChat, model: null }, { harnesses: HARNESSES, projects: PROJECTS }),
    { harness: 'claude', permission: 'acceptEdits', projectId: 'p1' },
  )
  // A word the harness no longer offers is left out rather than carried to a
  // picker that would show nothing.
  assert.deepEqual(
    chatSetup({ ...fullChat, permissionMode: 'bypassEverything' }, { harnesses: HARNESSES, projects: PROJECTS }),
    { harness: 'claude', model: 'opus-4.5', effort: 'high', projectId: 'p1' },
  )
  // codex's record arrives with the poll's snake_case spelling; same word.
  assert.equal(
    chatSetup({ harness: 'codex', permission_mode: 'never' }, { harnesses: HARNESSES }).permission,
    'never',
  )
})

test('a folder from another computer does not seed this one', () => {
  const elsewhere = { ...fullChat, executor: 'laptop' }
  assert.deepEqual(chatSetup(elsewhere, { harnesses: HARNESSES, projects: PROJECTS, thisDevice: 'here' }), {
    harness: 'claude',
    model: 'opus-4.5',
    effort: 'high',
    permission: 'acceptEdits',
  })
  // A folder no project holds is not invented into one.
  assert.deepEqual(
    chatSetup({ ...fullChat, workspace: 'C:\\elsewhere' }, { harnesses: HARNESSES, projects: PROJECTS, thisDevice: 'here' }),
    { harness: 'claude', model: 'opus-4.5', effort: 'high', permission: 'acceptEdits' },
  )
})

test('the row is offered on the same answer the seed is built from', () => {
  assert.equal(canSeedChat(chatSetup(fullChat, { harnesses: HARNESSES })), true)
  assert.equal(canSeedChat({}) , false)
  assert.equal(canSeedChat(null), false)
})
