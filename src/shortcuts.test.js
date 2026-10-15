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
  ACTIONS,
  comboFromEvent,
  comboLabel,
  firesWhileTyping,
  loadOverrides,
  saveOverrides,
  effectiveBindings,
  actionForCombo,
  rebind,
  unbind,
  resetOne,
  fuzzyScore,
  rankMatches,
} = await import('./shortcuts.js')

const key = (code, mods = {}) => ({
  code,
  key: '',
  ctrlKey: false,
  metaKey: false,
  altKey: false,
  shiftKey: false,
  ...mods,
})

test('the default map has no two actions on one key', () => {
  const seen = new Map()
  for (const a of ACTIONS) {
    if (!a.keys) continue
    assert.ok(!seen.has(a.keys), `${a.keys} is both ${seen.get(a.keys)} and ${a.id}`)
    seen.set(a.keys, a.id)
  }
})

test('Ctrl is the primary modifier off macOS, Cmd on it', () => {
  assert.equal(comboFromEvent(key('KeyN', { ctrlKey: true }), false), 'Mod+N')
  assert.equal(comboFromEvent(key('KeyN', { metaKey: true }), true), 'Mod+N')
  // On macOS the literal Control key is its own modifier.
  assert.equal(comboFromEvent(key('KeyN', { ctrlKey: true }), true), 'Ctrl+N')
  // The Windows key is never ours to take.
  assert.equal(comboFromEvent(key('KeyN', { metaKey: true }), false), null)
})

test('the physical key is read, so Shift and layouts never change it', () => {
  // Shift+\ prints `|`, but the binding is Mod+Shift+\.
  assert.equal(comboFromEvent(key('Backslash', { ctrlKey: true, shiftKey: true, key: '|' }), false), 'Mod+Shift+\\')
  assert.equal(comboFromEvent(key('Digit3', { ctrlKey: true, altKey: true, key: '£' }), false), 'Mod+Alt+3')
  assert.equal(comboFromEvent(key('ArrowDown', { altKey: true }), false), 'Alt+Down')
  assert.equal(comboFromEvent(key('Escape'), false), 'Esc')
  assert.equal(comboFromEvent(key('Comma', { ctrlKey: true }), false), 'Mod+,')
})

test('a lone modifier or an unknown key is no combo', () => {
  assert.equal(comboFromEvent(key('ShiftLeft', { shiftKey: true }), false), null)
  assert.equal(comboFromEvent(key('ControlRight', { ctrlKey: true }), false), null)
  assert.equal(comboFromEvent(key('Lang1'), false), null)
})

test('labels follow the platform', () => {
  assert.equal(comboLabel('Mod+Shift+A', false), 'Ctrl+Shift+A')
  assert.equal(comboLabel('Alt+Down', false), 'Alt+↓')
  assert.equal(comboLabel('Mod+Shift+A', true), '⌘⇧A')
  assert.equal(comboLabel(null, false), '')
})

test('only modifier combos, Esc and function keys fire while typing', () => {
  assert.ok(firesWhileTyping('Mod+N'))
  assert.ok(firesWhileTyping('Alt+Down'))
  assert.ok(firesWhileTyping('Esc'))
  assert.ok(firesWhileTyping('F2'))
  assert.ok(!firesWhileTyping('N'))
  assert.ok(!firesWhileTyping('Shift+N'))
})

test('taking a used key moves it and leaves the other action unbound', () => {
  const { overrides, displaced } = rebind({}, 'archive', 'Mod+N')
  assert.deepEqual(displaced, ['new-chat'])
  const live = effectiveBindings(overrides)
  assert.equal(live.archive, 'Mod+N')
  assert.equal(live['new-chat'], null)
  assert.equal(actionForCombo(live, 'Mod+N'), 'archive')
  // Archive's old key is free now.
  assert.equal(actionForCombo(live, 'Mod+Shift+A'), null)
})

test('a free key moves nothing', () => {
  const { overrides, displaced } = rebind({}, 'view-plugins', 'Mod+Shift+P')
  assert.deepEqual(displaced, [])
  assert.equal(effectiveBindings(overrides)['view-plugins'], 'Mod+Shift+P')
})

test('a user key shadows a default that would collide, never the other way', () => {
  // A stored override on a default's key - the default gives way.
  const live = effectiveBindings({ stop: 'Mod+N' })
  assert.equal(live.stop, 'Mod+N')
  assert.equal(live['new-chat'], null)
})

test('reset brings the default back and takes it from whoever holds it', () => {
  const moved = rebind({}, 'archive', 'Mod+N').overrides
  const back = resetOne(moved, 'new-chat')
  const live = effectiveBindings(back)
  assert.equal(live['new-chat'], 'Mod+N')
  assert.equal(live.archive, null)
  // Resetting archive then restores its own default too.
  assert.equal(effectiveBindings(resetOne(back, 'archive')).archive, 'Mod+Shift+A')
})

test('unbind leaves an action with no key', () => {
  assert.equal(effectiveBindings(unbind({}, 'interrupt')).interrupt, null)
})

test('overrides round-trip and garbage is dropped', () => {
  localStorage.clear()
  saveOverrides({ archive: 'Mod+N', 'new-chat': null })
  assert.deepEqual(loadOverrides(), { archive: 'Mod+N', 'new-chat': null })
  localStorage.setItem('openremote-shortcuts', JSON.stringify({ archive: 42, nope: 'Mod+Q', stop: 'Mod++' }))
  assert.deepEqual(loadOverrides(), {})
  localStorage.setItem('openremote-shortcuts', '{not json')
  assert.deepEqual(loadOverrides(), {})
})

test('fuzzy ranking: whole words beat scattered letters, misses drop', () => {
  assert.equal(fuzzyScore('xyz', 'New chat'), null)
  assert.ok(fuzzyScore('chat', 'New chat') > fuzzyScore('nct', 'New chat'))
  assert.ok(fuzzyScore('set', 'Settings') > fuzzyScore('set', 'Reset all'))
  const ranked = rankMatches('opus', ['Haiku 5.5', 'Switch to Opus 5.5', 'Open plugins'], (s) => s)
  assert.equal(ranked[0], 'Switch to Opus 5.5')
  // `op` as letters still finds Open plugins; Haiku has no o-p in order.
  assert.deepEqual(rankMatches('op', ['Haiku 5.5', 'Open plugins'], (s) => s), ['Open plugins'])
})
