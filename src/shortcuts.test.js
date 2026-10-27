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
  blocksWhileTyping,
  captureRefusal,
  clearStaleOverrides,
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
  defaultKey,
  staleOverrides,
  typesIn,
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

test('overrides round-trip, a removed action keeps its key, and garbage is dropped', () => {
  localStorage.clear()
  saveOverrides({ archive: 'Mod+N', 'new-chat': null })
  assert.deepEqual(loadOverrides(), { archive: 'Mod+N', 'new-chat': null })
  // An id this build no longer has is the user's saved key: kept so the
  // settings page can show it and clear it (see the stale-row test).
  localStorage.setItem('openremote-shortcuts', JSON.stringify({ archive: 42, nope: 'Mod+Q', stop: 'Mod++' }))
  assert.deepEqual(loadOverrides(), { nope: 'Mod+Q' })
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

test('macOS keeps its own Cmd+H, Cmd+M and Cmd+W: those defaults move to Option+Cmd', () => {
  const mac = effectiveBindings({}, true)
  assert.equal(mac['pick-harness'], 'Mod+Alt+H')
  assert.equal(mac['pick-model'], 'Mod+Alt+M')
  assert.equal(mac['close-pane'], 'Mod+Alt+W')
  // Everywhere else they stay where they were.
  assert.equal(effectiveBindings({}, false)['pick-model'], 'Mod+M')
  // No two mac defaults collide either.
  const keys = Object.values(mac).filter(Boolean)
  assert.equal(new Set(keys).size, keys.length)
  // A reset on a Mac lands on the Mac default.
  assert.equal(defaultKey('close-pane', true), 'Mod+Alt+W')
  const moved = rebind({}, 'stop', 'Mod+Alt+W', true).overrides
  assert.equal(effectiveBindings(resetOne(moved, 'close-pane', true), true)['close-pane'], 'Mod+Alt+W')
})

// ---- a shortcut that leaves a chat does not fire while typing ----

test('typing is a field, not a button', () => {
  assert.equal(typesIn({ tagName: 'TEXTAREA' }), true, 'the composer')
  assert.equal(typesIn({ tagName: 'INPUT' }), true, 'a search or rename field')
  assert.equal(typesIn({ tagName: 'DIV', isContentEditable: true }), true, 'a rich field')
  assert.equal(typesIn({ tagName: 'BUTTON' }), false)
  assert.equal(typesIn({ tagName: 'DIV' }), false)
  assert.equal(typesIn(null), false)
})

test('only the actions that leave the chat stand down while typing', () => {
  // The draft lives in the composer's view, so a navigation fired from a field
  // unmounts text the shell cannot save. Everything that keeps the composer
  // mounted keeps working while the user types.
  for (const id of ['new-chat', 'archive', 'close-pane', 'view-settings', 'view-metrics', 'toggle-mode']) {
    assert.equal(blocksWhileTyping(id), true, `${id} navigates away from the chat`)
  }
  for (const id of ['steer', 'interrupt', 'stop', 'palette', 'cheat-sheet', 'focus-composer', 'split-right', 'focus-pane-1']) {
    assert.equal(blocksWhileTyping(id), false, `${id} keeps the composer where it is`)
  }
  assert.equal(blocksWhileTyping('no-such-action'), false, 'an unknown id has no policy')
})

// ---- a rebind capture refuses a key the dispatcher cannot deliver ----

test('a capture refuses the keys that would only ever be typed into a box', () => {
  assert.match(captureRefusal('N'), /no modifier|typed/)
  assert.match(captureRefusal('Shift+A'), /no modifier|typed/)
  assert.match(captureRefusal('Backspace'), /no modifier|typed/)
  assert.match(captureRefusal(''), /not a key/)
  assert.equal(captureRefusal(null), 'That is not a key OpenRemote can bind.')
})

test('a capture takes the keys the dispatcher delivers, Esc and the function keys included', () => {
  assert.equal(captureRefusal('Mod+N'), null)
  assert.equal(captureRefusal('Ctrl+Shift+J'), null)
  assert.equal(captureRefusal('Alt+Up'), null)
  assert.equal(captureRefusal('Esc'), null, 'the interrupt key is delivered while typing, so it can be bound')
  assert.equal(captureRefusal('F5'), null)
  assert.equal(captureRefusal('Mod+Shift+\\'), null)
})

// ---- a saved key whose action is gone is shown, not dropped ----

test('a stored binding for a removed action survives the load and is listed as stale', () => {
  localStorage.clear()
  localStorage.setItem(
    'openremote-shortcuts',
    JSON.stringify({ 'gone-action': 'Mod+G', 'new-chat': 'Mod+J', broken: 'Nope+Nope' }),
  )
  const loaded = loadOverrides()
  assert.equal(loaded['gone-action'], 'Mod+G', 'the key is the user\'s, so it is kept')
  assert.equal(loaded['new-chat'], 'Mod+J')
  assert.equal(Object.hasOwn(loaded, 'broken'), false, 'a malformed combo is still dropped')
  // It never takes a key: the live map walks the catalog only.
  assert.equal(effectiveBindings(loaded, false)['gone-action'], undefined)
  assert.deepEqual(staleOverrides(loaded), [{ id: 'gone-action', combo: 'Mod+G' }])
  // Clearing forgets the stale one and leaves the real overrides alone.
  assert.deepEqual(clearStaleOverrides(loaded), { 'new-chat': 'Mod+J' })
  assert.deepEqual(clearStaleOverrides({}), {})
  assert.deepEqual(staleOverrides({}), [])
})

// ---- the catalog and the window stay in step ----

test('every action in the catalog is wired to the window', async () => {
  // A key that fires nothing is worse than no key: the cheat sheet and the
  // settings list would advertise it, and a person would press it. The
  // dispatcher lives in the views, so the check reads them. Model switches are
  // the one generated family: their ids come from useModelSwitches, so the
  // source cannot name them one by one.
  const { readdirSync, readFileSync } = await import('node:fs')
  const dir = new URL('./', import.meta.url)
  const files = readdirSync(dir).filter((name) => name.endsWith('.jsx'))
  const sources = files.map((name) => readFileSync(new URL(name, dir), 'utf8'))
  const wired = new Set()
  for (const text of sources) {
    for (const match of text.matchAll(/useShortcut\(\s*'([a-z0-9-]+)'/g)) wired.add(match[1])
  }
  const missing = ACTIONS.filter((a) => !wired.has(a.id) && !/^model-\d+$/.test(a.id)).map((a) => a.id)
  assert.deepEqual(missing, [], `actions a key cannot reach: ${missing.join(', ')}`)
  // And the generated family has its one wire, in the views that own pickers.
  assert.ok(
    sources.some((text) => text.includes('useModelSwitches(')),
    'the model switches keep their generated wire',
  )
})