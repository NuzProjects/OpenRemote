// Presets for New chat: the shape of a stored row, how a damaged list is
// repaired, and how a preset settles against what a harness offers today.
// The storage stub follows settings.test.js: the module reads
// localStorage only inside its functions, so the stub has to exist before
// the import.

import assert from 'node:assert/strict'
import test from 'node:test'

const store = new Map()
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
  clear: () => store.clear(),
}

const {
  NAME_LIMIT,
  defaultPreset,
  loadPresets,
  markDefault,
  newPresetId,
  normalizePreset,
  normalizePresets,
  presetFromState,
  presetSummary,
  removePreset,
  replacePreset,
  settlePreset,
  storePresets,
  suggestedPresetName,
} = await import('./presets.js')

const chip = (over = {}) => ({
  id: 'p-1',
  name: 'Opus high, this repo',
  harness: 'claude',
  model: 'claude-opus-4-1',
  effort: 'high',
  permission: 'acceptEdits',
  projectId: 'proj-1',
  fast: false,
  ...over,
})

const WORLD = {
  harnesses: ['claude', 'codex'],
  models: [{ model: 'claude-opus-4-1', reasoning_efforts: ['low', 'medium', 'high'] }],
  permissions: [{ w: 'default', l: 'Ask' }, { w: 'acceptEdits', l: 'Accept edits' }],
  projects: ['proj-1'],
  labels: { harnessLabel: 'Claude', modelLabel: 'Opus', effortLabel: 'high', projectLabel: 'this repo' },
}

test('a saved row keeps the six choices and gets an id', () => {
  const preset = normalizePreset({ harness: 'claude', model: 'opus', effort: 'high', permission: 'acceptEdits', projectId: 'p1', fast: true, name: ' Mine ' })
  assert.equal(preset.name, 'Mine')
  assert.equal(preset.harness, 'claude')
  assert.equal(preset.model, 'opus')
  assert.equal(preset.effort, 'high')
  assert.equal(preset.permission, 'acceptEdits')
  assert.equal(preset.projectId, 'p1')
  assert.equal(preset.fast, true)
  assert.match(preset.id, /^p-/)
})

test('a name too long for one chip is cut, not wrapped', () => {
  const preset = normalizePreset({ harness: 'claude', name: 'x'.repeat(200) })
  assert.equal(preset.name.length, NAME_LIMIT)
})

test('junk in a row becomes the unset slot, and no harness means no preset', () => {
  const preset = normalizePreset({ harness: 'claude', model: 42, effort: [], permission: {}, projectId: false, fast: 'yes', default: 1 })
  assert.equal(preset.model, null)
  assert.equal(preset.effort, null)
  assert.equal(preset.permission, null)
  assert.equal(preset.projectId, null)
  assert.equal(preset.fast, false)
  assert.equal(preset.default, false)
  assert.equal(normalizePreset({ name: 'no harness', model: 'opus' }), null)
  assert.equal(normalizePreset('a string'), null)
  assert.equal(normalizePreset(null), null)
})

test('a damaged list keeps what can be a preset and drops what cannot', () => {
  const list = normalizePresets([chip(), 'junk', null, { name: 'no harness' }, chip({ id: 'p-2' })])
  assert.deepEqual(list.map((p) => p.id), ['p-1', 'p-2'])
})

test('at most one row stays the default, and the first one wins', () => {
  const list = normalizePresets([chip({ id: 'a' }), chip({ id: 'b', default: true }), chip({ id: 'c', default: true })])
  assert.equal(list.filter((p) => p.default).length, 1)
  assert.equal(defaultPreset(list).id, 'b')
})

test('two rows with the same id are made distinct, so a delete removes one row', () => {
  const list = normalizePresets([chip({ id: 'same' }), chip({ id: 'same' })])
  assert.notEqual(list[0].id, list[1].id)
})

test('presets round-trip through their own storage key, and a save repairs', () => {
  localStorage.clear()
  storePresets([{ harness: 'claude', name: 'Mine', fast: 'yes' }])
  assert.ok(localStorage.getItem('openremote-presets'))
  const loaded = loadPresets()
  assert.equal(loaded.length, 1)
  assert.equal(loaded[0].name, 'Mine')
  assert.equal(loaded[0].fast, false)
})

test('a damaged stored value reads as no presets and never throws', () => {
  for (const raw of ['{not json', '{"a":1}', '"a string"', '[1, "two", null]']) {
    localStorage.clear()
    localStorage.setItem('openremote-presets', raw)
    assert.deepEqual(loadPresets(), [], raw)
  }
})

test('a current setup becomes a preset, and saving it twice does not duplicate', () => {
  const state = { harness: 'claude', model: 'claude-opus-4-1', effort: 'high', permission: 'acceptEdits', projectId: 'proj-1', fast: true }
  const first = presetFromState(state)
  assert.equal(first.harness, 'claude')
  assert.equal(first.fast, true)
  assert.equal(first.name, null)
  assert.notEqual(presetFromState(state).id, first.id)
})

test('renaming keeps the row, its default mark and its place', () => {
  const list = markDefault([chip({ id: 'a' }), chip({ id: 'b' })], 'b')
  const renamed = replacePreset(list, { ...list[0], name: 'Mornings' })
  assert.equal(renamed[0].name, 'Mornings')
  assert.equal(renamed[0].default, false)
  assert.equal(defaultPreset(renamed).id, 'b')
  assert.equal(renamed.length, 2)
})

test('deleting removes one row and leaves the default alone', () => {
  const list = markDefault([chip({ id: 'a' }), chip({ id: 'b' })], 'b')
  const left = removePreset(list, 'a')
  assert.deepEqual(left.map((p) => p.id), ['b'])
  assert.equal(defaultPreset(left).id, 'b')
})

test('the name says what the preset is, in the words the console shows', () => {
  assert.equal(suggestedPresetName({ modelLabel: 'Opus', effort: 'high', projectLabel: 'this repo' }), 'Opus high, this repo')
  assert.equal(suggestedPresetName({ modelLabel: 'Opus', effort: 'high' }), 'Opus high')
  assert.equal(suggestedPresetName({ harnessLabel: 'Codex', effort: 'medium' }), 'Codex medium')
  assert.equal(suggestedPresetName({}), 'Chat')
})

test('a chip title lists the whole setup', () => {
  const text = presetSummary(chip({ fast: true }), WORLD.labels)
  assert.match(text, /Claude/)
  assert.match(text, /Opus/)
  assert.match(text, /high effort/)
  assert.match(text, /Accept edits|acceptEdits/)
  assert.match(text, /fast/)
  assert.match(text, /this repo/)
})

test('a preset that still fits applies every slot', () => {
  const { slots, notes } = settlePreset(chip(), WORLD)
  assert.deepEqual(notes, [])
  assert.equal(slots.harness, 'claude')
  assert.equal(slots.model, 'claude-opus-4-1')
  assert.equal(slots.effort, 'high')
  assert.equal(slots.permission, 'acceptEdits')
  assert.equal(slots.projectId, 'proj-1')
  assert.equal(slots.fast, false)
})

test('a model the harness no longer lists is dropped, said once, and the rest applies', () => {
  const world = { ...WORLD, models: [{ model: 'claude-sonnet-5', reasoning_efforts: ['low'] }] }
  const { slots, notes } = settlePreset(chip(), world)
  assert.equal(slots.model, null)
  // The effort belongs to the model that is gone: one note is enough.
  assert.equal(slots.effort, null)
  assert.equal(notes.length, 1)
  assert.match(notes[0], /Opus is not one Claude lists any more/)
  assert.equal(slots.permission, 'acceptEdits')
  assert.equal(slots.projectId, 'proj-1')
})

test('an effort tier that model no longer offers is dropped and said', () => {
  const world = { ...WORLD, models: [{ model: 'claude-opus-4-1', reasoning_efforts: ['low'] }] }
  const { slots, notes } = settlePreset(chip(), world)
  assert.equal(slots.model, 'claude-opus-4-1')
  assert.equal(slots.effort, null)
  assert.equal(notes.length, 1)
  assert.match(notes[0], /high effort is not one that model offers any more/)
})

test('an approval word the harness dropped is not sent, and the harness default holds', () => {
  const world = { ...WORLD, permissions: [{ w: 'default', l: 'Ask' }] }
  const { slots, notes } = settlePreset(chip(), world)
  assert.equal(slots.permission, null)
  assert.equal(notes.length, 1)
  assert.match(notes[0], /not one Claude offers any more/)
})

test('a preset whose harness is gone keeps the project, fast and honesty', () => {
  const world = { ...WORLD, harnesses: ['codex'], labels: { ...WORLD.labels, currentHarnessLabel: 'Codex' } }
  const { slots, notes } = settlePreset(chip({ fast: true }), world)
  assert.equal(slots.harness, null)
  assert.equal(slots.model, null)
  assert.equal(slots.effort, null)
  assert.equal(slots.permission, null)
  assert.equal(slots.projectId, 'proj-1')
  assert.equal(slots.fast, true)
  assert.equal(notes.length, 1)
  assert.match(notes[0], /stays on Codex/)
})

test('a project that is gone leaves the rest of the preset in place', () => {
  const world = { ...WORLD, projects: [] }
  const { slots, notes } = settlePreset(chip(), world)
  assert.equal(slots.projectId, null)
  assert.equal(slots.model, 'claude-opus-4-1')
  assert.equal(notes.length, 1)
  assert.match(notes[0], /project is not on this machine any more/)
})

test('nothing to settle settles to nothing', () => {
  assert.deepEqual(settlePreset(null, WORLD), { slots: null, notes: [] })
})

test('new ids do not collide', () => {
  assert.notEqual(newPresetId(), newPresetId())
})
