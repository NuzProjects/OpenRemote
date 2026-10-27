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
  PRESET_LIMIT,
  PRESET_REFUSALS,
  defaultPreset,
  loadPresets,
  markDefault,
  newPresetId,
  normalizePreset,
  normalizePresets,
  onPresetsChanged,
  presetFromChat,
  presetFromState,
  presetSummary,
  removePreset,
  replacePreset,
  saveChatPreset,
  savePreset,
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
  // Fast belonged to the harness that is gone: it must not land on Codex,
  // which may have no fast mode at all.
  assert.equal(slots.fast, false)
  assert.equal(notes.length, 1)
  assert.match(notes[0], /stays on Codex/)
})

test('fast rides the harness it was saved on, and its fast mode where the caller knows it', () => {
  // The harness is installed and still offers fast: the flag applies.
  assert.equal(settlePreset(chip({ fast: true }), WORLD).slots.fast, true)
  // The harness is installed but its fast mode is not usable today.
  assert.equal(
    settlePreset(chip({ fast: true }), { ...WORLD, fastSupported: ['codex'] }).slots.fast,
    false,
  )
  // A caller with the list, and the harness on it.
  assert.equal(
    settlePreset(chip({ fast: true }), { ...WORLD, fastSupported: ['claude'] }).slots.fast,
    true,
  )
  // A preset that never asked for fast asks for nothing.
  assert.equal(
    settlePreset(chip({ fast: false }), { ...WORLD, fastSupported: ['codex'] }).slots.fast,
    false,
  )
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

// ---- a chat's setup as a preset ----

// A chat record as the console holds it (state/reducer.js): the six choices a
// preset also holds, the folder it ran in, and the device that ran it.
const chatOf = (over = {}) => ({
  id: 's1',
  harness: 'claude',
  model: 'opus',
  effort: 'high',
  permissionMode: 'acceptEdits',
  workspace: 'C:\\work\\this repo',
  fast: false,
  executor: null,
  ...over,
})

const CHAT_WORLD = {
  harnesses: [
    {
      id: 'claude',
      name: 'Claude Code',
      available: true,
      permission_modes: ['default', 'acceptEdits'],
      fast_supported: true,
    },
  ],
  projects: [{ id: 'proj-1', folders: ['C:\\work\\this repo'] }],
  thisDevice: 'me',
}

test('a chat carries the six choices a preset holds', () => {
  const plan = presetFromChat(chatOf({ fast: true }), CHAT_WORLD)
  assert.equal(plan.offer, true)
  assert.equal(plan.reason, null)
  assert.deepEqual(plan.carried, ['harness', 'model', 'effort', 'permission', 'project', 'fast'])
  assert.deepEqual(plan.leftOut, [])
  assert.equal(plan.preset.harness, 'claude')
  assert.equal(plan.preset.model, 'opus')
  assert.equal(plan.preset.effort, 'high')
  assert.equal(plan.preset.permission, 'acceptEdits')
  assert.equal(plan.preset.projectId, 'proj-1')
  assert.equal(plan.preset.fast, true)
  assert.equal(plan.preset.default, false)
  // The row is named as it will be shown, before the person renames it.
  assert.equal(plan.preset.name, plan.suggestedName)
})

test('the suggested name is the setup described, in the console own words', () => {
  const plan = presetFromChat(chatOf(), CHAT_WORLD)
  assert.equal(plan.suggestedName, 'opus high, this repo')
  // A caller that knows the display label passes it and the name uses it.
  const labelled = presetFromChat(chatOf(), { ...CHAT_WORLD, labels: { modelLabel: 'Opus 5.5' } })
  assert.equal(labelled.suggestedName, 'Opus 5.5 high, this repo')
  // No model: the harness names the setup, and the effort goes with the model.
  const bare = presetFromChat(chatOf({ model: null, effort: null, permissionMode: null }), CHAT_WORLD)
  assert.equal(bare.suggestedName, 'Claude Code, this repo')
  // No project either: no trailing comma and nothing invented for the place.
  const nowhere = presetFromChat(chatOf({ workspace: null, model: null, effort: null }), CHAT_WORLD)
  assert.equal(nowhere.suggestedName, 'Claude Code')
})

test('a field the chat cannot supply is left unset rather than guessed', () => {
  // No model: the effort goes too, because a tier belongs to its model.
  const noModel = presetFromChat(chatOf({ model: null, effort: 'high' }), CHAT_WORLD)
  assert.equal(noModel.preset.model, null)
  assert.equal(noModel.preset.effort, null)
  assert.deepEqual(noModel.leftOut, ['model', 'effort'])
  assert.deepEqual(noModel.carried, ['harness', 'permission', 'project', 'fast'], 'the rest still carries')

  // No workspace, or one no project holds: no project id, never the nearest.
  const noFolder = presetFromChat(chatOf({ workspace: null }), CHAT_WORLD)
  assert.equal(noFolder.preset.projectId, null)
  const strayFolder = presetFromChat(chatOf({ workspace: 'C:\\elsewhere' }), CHAT_WORLD)
  assert.equal(strayFolder.preset.projectId, null)
  assert.equal(strayFolder.preset.model, 'opus', 'the rest still carries')

  // An approval word the harness has dropped is not carried.
  const droppedWord = presetFromChat(chatOf({ permissionMode: 'anOldWord' }), CHAT_WORLD)
  assert.equal(droppedWord.preset.permission, null)

  // Fast only where the harness has a fast mode at all.
  const noFast = presetFromChat(chatOf({ fast: true }), {
    ...CHAT_WORLD,
    harnesses: [{ ...CHAT_WORLD.harnesses[0], fast_supported: false }],
  })
  assert.equal(noFast.preset.fast, false)
})

test('a project is carried only for a chat that ran on this computer', () => {
  const here = presetFromChat(chatOf({ executor: 'me' }), CHAT_WORLD)
  assert.equal(here.preset.projectId, 'proj-1')
  // The same folder on another computer is that computer's project, not one of
  // ours, so the preset is saved without a workspace rather than with a
  // project id that means nothing here.
  const there = presetFromChat(chatOf({ executor: 'box' }), CHAT_WORLD)
  assert.equal(there.preset.projectId, null)
  assert.equal(there.offer, true, 'the chat still becomes a preset')
  assert.equal(there.preset.model, 'opus')
})

test('a chat that cannot become a preset is refused with a plain sentence', () => {
  const cases = [
    [null, 'no-chat'],
    [chatOf({ harness: null }), 'no-harness'],
    [chatOf({ harness: '' }), 'no-harness'],
    [chatOf({ harness: 'grok' }), 'not-installed'],
    [
      chatOf(),
      'not-installed',
      { ...CHAT_WORLD, harnesses: [{ ...CHAT_WORLD.harnesses[0], available: false }] },
    ],
  ]
  for (const [chat, reason, world = CHAT_WORLD] of cases) {
    const plan = presetFromChat(chat, world)
    assert.equal(plan.offer, false, `${reason} is not offered`)
    assert.equal(plan.reason, reason)
    assert.equal(plan.preset, null)
    assert.equal(plan.suggestedName, null)
    assert.match(PRESET_REFUSALS[reason], /\.$/, 'the sentence ends like a sentence')
  }
  // A harness switched off in Plugins is still installed: the switch is the
  // fix, and the preset can be saved for when it is on again.
  const off = presetFromChat(chatOf(), {
    ...CHAT_WORLD,
    harnesses: [{ ...CHAT_WORLD.harnesses[0], enabled: false }],
  })
  assert.equal(off.offer, true)
})

test('saving writes the row through the same storage every preset uses, and says so', () => {
  store.clear()
  const seen = []
  const undo = onPresetsChanged((list) => seen.push(list))
  const { preset, presets, error } = saveChatPreset(chatOf(), CHAT_WORLD)
  assert.equal(error, null)
  assert.equal(presets.length, 1)
  assert.equal(preset.harness, 'claude')
  // The stored list is the truth, not just the returned value.
  assert.deepEqual(loadPresets().map((p) => p.id), [preset.id])
  assert.equal(seen.length, 1, 'the chips on screen hear about it')
  assert.equal(seen[0][0].id, preset.id)
  undo()
  saveChatPreset(chatOf({ model: 'sonnet' }), CHAT_WORLD)
  assert.equal(seen.length, 1, 'an unsubscribed listener hears nothing')
  assert.equal(loadPresets().length, 2)
})

test('a refused save writes nothing, and a full list says its number', () => {
  store.clear()
  const refused = saveChatPreset(null, CHAT_WORLD)
  assert.equal(refused.error, PRESET_REFUSALS['no-chat'])
  assert.equal(loadPresets().length, 0)

  // Fill the shelf: the twelfth fits, the thirteenth is refused rather than
  // silently dropped by the repair rules.
  const rows = Array.from({ length: PRESET_LIMIT }, (_, i) => chip({ id: `p-${i}`, name: `Setup ${i}` }))
  storePresets(rows)
  const full = saveChatPreset(chatOf(), CHAT_WORLD)
  assert.equal(full.error, PRESET_REFUSALS.full)
  assert.match(full.error, new RegExp(`${PRESET_LIMIT} setups`))
  assert.equal(loadPresets().length, PRESET_LIMIT)
  assert.equal(loadPresets().some((p) => p.id === 'p-0'), true, 'nothing was dropped for the new row')
})

test('the name a person types is the name stored, repaired to the chip limit', () => {
  store.clear()
  const plan = presetFromChat(chatOf(), CHAT_WORLD)
  const saved = savePreset({ ...plan.preset, name: '  Mornings  ' })
  assert.equal(saved.error, null)
  assert.equal(saved.preset.name, 'Mornings')
  assert.equal(loadPresets()[0].name, 'Mornings')
  // Past the chip's limit the stored name is cut, not wrapped.
  store.clear()
  savePreset({ ...plan.preset, name: 'x'.repeat(NAME_LIMIT + 20) })
  assert.equal(loadPresets()[0].name.length, NAME_LIMIT)
  // A row with no harness cannot be a preset, whoever hands it over.
  const bad = savePreset({ name: 'Nowhere', harness: '' })
  assert.equal(bad.error, PRESET_REFUSALS['no-harness'])
  assert.equal(loadPresets().length, 1, 'nothing was written for it')
})
