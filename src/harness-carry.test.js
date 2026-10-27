// The survival rule for a harness switch: a word the new harness lists, a
// model its catalog actually carries, and one sentence for whatever did not
// come along. The permission words in these tests are the daemon's own (its
// registry): claude offers default / acceptEdits / bypassPermissions / plan,
// grok offers those four plus auto and dontAsk, codex uses untrusted /
// on-failure / on-request / never, and the other three offer none.

import assert from 'node:assert/strict'
import test from 'node:test'
import { carrySetup, droppedLine, restoreFromCatalog } from './harness-carry.js'

const CLAUDE_WORDS = ['default', 'acceptEdits', 'bypassPermissions', 'plan']
const GROK_WORDS = ['default', 'acceptEdits', 'auto', 'dontAsk', 'bypassPermissions', 'plan']
const CODEX_WORDS = ['untrusted', 'on-failure', 'on-request', 'never']

const models = [
  { model: 'opus', display_name: 'Opus 5.5', resolved_model: 'claude-opus-5-5' },
  { model: 'sonnet', display_name: 'Sonnet 5', resolved_model: 'claude-sonnet-5' },
]

test('a model survives only where the new catalog lists it', () => {
  const kept = carrySetup({ model: 'opus' }, { models, permissionModes: [] })
  assert.equal(kept.kept.model, 'opus')
  // The same harness's catalog carries it by pick word or by resolved id.
  assert.equal(carrySetup({ model: 'claude-opus-5-5' }, { models, permissionModes: [] }).kept.model, 'claude-opus-5-5')
  // Another maker's catalog has no such row: dropped, not quietly switched.
  const dropped = carrySetup({ model: 'opus' }, { models: [], permissionModes: [] })
  assert.equal(dropped.kept.model, null)
  assert.deepEqual(dropped.dropped, ['model'])
})

test('a model with no catalog to check against yet is dropped, and can come back', () => {
  // The new harness's list is still in flight: an unknown catalog carries
  // nothing, and the answer puts it back if the row is there.
  const dropped = carrySetup({ model: 'opus' }, { models: null, permissionModes: [] })
  assert.deepEqual(dropped.dropped, ['model'])
  assert.equal(restoreFromCatalog('opus', models), 'opus')
  assert.equal(restoreFromCatalog('claude-opus-5-5', models), 'claude-opus-5-5')
  assert.equal(restoreFromCatalog('gpt-5', models), null)
  assert.equal(restoreFromCatalog(null, models), null)
})

test('a permission word survives exactly where the harness speaks it', () => {
  // claude -> grok: every claude word is one of grok's six.
  for (const word of CLAUDE_WORDS) {
    const out = carrySetup({ permission: word }, { models: [], permissionModes: GROK_WORDS })
    assert.equal(out.kept.permission, word, `${word} carries to grok`)
    assert.deepEqual(out.dropped, [])
  }
  // grok -> claude: two of grok's words are its own.
  for (const word of ['auto', 'dontAsk']) {
    const out = carrySetup({ permission: word }, { models: [], permissionModes: CLAUDE_WORDS })
    assert.equal(out.kept.permission, null)
    assert.deepEqual(out.dropped, ['permission'])
  }
  // claude -> codex: no word is shared, in either direction.
  assert.deepEqual(carrySetup({ permission: 'plan' }, { models: [], permissionModes: CODEX_WORDS }).dropped, ['permission'])
  // Any harness with no words at all cannot carry one.
  assert.deepEqual(carrySetup({ permission: 'plan' }, { models: [], permissionModes: [] }).dropped, ['permission'])
})

test('both fields can be named at once, in one sentence', () => {
  const out = carrySetup({ model: 'opus', permission: 'plan' }, { models: [], permissionModes: CODEX_WORDS })
  assert.deepEqual(out.dropped, ['model', 'permission'])
  assert.equal(
    droppedLine(out.dropped, 'Codex'),
    'Codex does not use that model and permission word: the switch cleared it, so pick again below.',
  )
})

test('nothing set, or everything carried, says nothing', () => {
  assert.deepEqual(carrySetup({}, { models, permissionModes: CLAUDE_WORDS }), { kept: { model: null, permission: null }, dropped: [] })
  assert.equal(droppedLine([], 'Claude'), null)
  assert.equal(droppedLine(undefined, 'Claude'), null)
  const carried = carrySetup({ model: 'opus', permission: 'plan' }, { models, permissionModes: CLAUDE_WORDS })
  assert.deepEqual(carried.dropped, [])
  assert.equal(carried.kept.model, 'opus')
  assert.equal(carried.kept.permission, 'plan')
})
