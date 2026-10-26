import assert from 'node:assert/strict'
import test from 'node:test'

// settings.js touches localStorage at import time? No - only inside its
// functions - but the storage itself must exist before any call.
const store = new Map()
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
  clear: () => store.clear(),
}

const {
  loadPrefs,
  savePrefs,
  applyReduceMotion,
  applyDensity,
  applyPrivacyMode,
  restoreBootPrefs,
  hashWriteReady,
  loadRecentWorkspaces,
  pushRecentWorkspace,
} = await import('./settings.js')

const stubDoc = () => {
  const attrs = new Map()
  return {
    attrs,
    documentElement: {
      setAttribute: (n, v) => attrs.set(n, v),
      removeAttribute: (n) => attrs.delete(n),
    },
  }
}

test('prefs round-trip through the single key', () => {
  localStorage.clear()
  savePrefs({ reduce_motion: true, density: 'compact', startup_view: 'last' })
  const p = loadPrefs()
  assert.equal(p.reduce_motion, true)
  assert.equal(p.density, 'compact')
  assert.equal(p.startup_view, 'last')
})

test('the old reduce-motion key migrates when the new key is absent', () => {
  localStorage.clear()
  localStorage.setItem('openremote-reduce-motion', '1')
  assert.equal(loadPrefs().reduce_motion, true)
  // And a save writes the new key, so the old one never matters again.
  savePrefs({ density: 'compact' })
  localStorage.removeItem('openremote-reduce-motion')
  assert.equal(loadPrefs().reduce_motion, true)
})

test('defaults fall back when storage holds garbage', () => {
  localStorage.clear()
  localStorage.setItem('openremote-prefs', '{not json')
  const p = loadPrefs()
  assert.equal(p.reduce_motion, false)
  assert.equal(p.density, 'comfortable')
  assert.equal(p.startup_view, 'new')
  // An unknown density value is dropped rather than trusted.
  localStorage.setItem('openremote-prefs', JSON.stringify({ density: 'cozy' }))
  assert.equal(loadPrefs().density, 'comfortable')
})

test('apply functions set and clear the html attributes', () => {
  const doc = stubDoc()
  applyReduceMotion(doc, true)
  assert.ok(doc.attrs.has('data-reduce-motion'))
  applyReduceMotion(doc, false)
  assert.ok(!doc.attrs.has('data-reduce-motion'))
  applyDensity(doc, 'compact')
  assert.equal(doc.attrs.get('data-density'), 'compact')
})

test('restoreBootPrefs applies the persisted look before first paint', () => {
  localStorage.clear()
  savePrefs({ reduce_motion: true, density: 'compact' })
  const doc = stubDoc()
  const loc = { hash: '' }
  restoreBootPrefs(doc, loc)
  assert.ok(doc.attrs.has('data-reduce-motion'))
  assert.equal(doc.attrs.get('data-density'), 'compact')
  // startup_view defaults to 'new' - the hash stays untouched.
  assert.equal(loc.hash, '')
})

test('privacy mode is off unless saved as exactly true, and survives a restart', () => {
  localStorage.clear()
  assert.equal(loadPrefs().privacy_mode, false)
  // Only a real boolean turns it on - a stray truthy value never blurs
  // the app by accident.
  localStorage.setItem('openremote-prefs', JSON.stringify({ privacy_mode: 'yes' }))
  assert.equal(loadPrefs().privacy_mode, false)
  localStorage.clear()
  savePrefs({ privacy_mode: true })
  // Saving another pref keeps it.
  savePrefs({ density: 'compact' })
  assert.equal(loadPrefs().privacy_mode, true)
  // Restored before first paint, so a stream that starts private never
  // shows one readable frame.
  const doc = stubDoc()
  restoreBootPrefs(doc, { hash: '' })
  assert.ok(doc.attrs.has('data-privacy'))
})

test('applyPrivacyMode sets and clears its html attribute', () => {
  const doc = stubDoc()
  applyPrivacyMode(doc, true)
  assert.ok(doc.attrs.has('data-privacy'))
  applyPrivacyMode(doc, false)
  assert.ok(!doc.attrs.has('data-privacy'))
})

test('restoreBootPrefs seeds the hash only when asked and only when empty', () => {
  localStorage.clear()
  savePrefs({ startup_view: 'last' })
  localStorage.setItem('openremote-last-view', 'plugins')
  const doc = stubDoc()
  const loc = { hash: '' }
  restoreBootPrefs(doc, loc)
  assert.equal(loc.hash, '#plugins')

  // A hash the user deep-linked to wins over the pref.
  const loc2 = { hash: '#automations' }
  restoreBootPrefs(doc, loc2)
  assert.equal(loc2.hash, '#automations')

  // Pref 'new' never seeds.
  savePrefs({ startup_view: 'new' })
  const loc3 = { hash: '' }
  restoreBootPrefs(doc, loc3)
  assert.equal(loc3.hash, '')

  // A garbage last-view is left for the router's known-set, not a crash.
  savePrefs({ startup_view: 'last' })
  localStorage.setItem('openremote-last-view', 'nonsense-view')
  const loc4 = { hash: '' }
  restoreBootPrefs(doc, loc4)
  assert.equal(loc4.hash, '#nonsense-view')
})

test('hashWriteReady holds while a chat seed waits for its first session beat', () => {
  // The boot the fix exists for: a chat id is seeded, no poll has
  // answered yet - the write effect must not clobber the hash.
  assert.equal(hashWriteReady({ sessionsLoaded: false, seedConsumed: false }), false)

  // The first beat answers (even an empty list): the reconcile consumes
  // the seed on that beat, so the write effect may run again.
  assert.equal(hashWriteReady({ sessionsLoaded: true, seedConsumed: false }), true)

  // No seed pending - a static seed validates at mount, nothing was
  // planted, or the user navigated past it: immediate, as before the fix.
  assert.equal(hashWriteReady({ sessionsLoaded: false, seedConsumed: true }), true)
  assert.equal(hashWriteReady({ sessionsLoaded: true, seedConsumed: true }), true)

  // Bare defaults are the closed hold.
  assert.equal(hashWriteReady(), false)
})

test('recents parse garbage, filter non-strings, and cap at eight', () => {
  localStorage.clear()
  localStorage.setItem('openremote-recent-workspaces', '{oops')
  assert.deepEqual(loadRecentWorkspaces(), [])
  localStorage.setItem('openremote-recent-workspaces', JSON.stringify(['a', 3, null, 'b']))
  assert.deepEqual(loadRecentWorkspaces(), ['a', 'b'])
})

test('pushRecentWorkspace dedupes, fronts, and caps at eight', () => {
  localStorage.clear()
  pushRecentWorkspace('w1')
  pushRecentWorkspace('w2')
  pushRecentWorkspace('w1')
  assert.deepEqual(loadRecentWorkspaces(), ['w1', 'w2'])
  for (let i = 0; i < 10; i++) pushRecentWorkspace(`extra-${i}`)
  assert.equal(loadRecentWorkspaces().length, 8)
  assert.equal(loadRecentWorkspaces()[0], 'extra-9')
})

test('a storage that refuses to answer leaves the defaults, before first paint', () => {
  // The boot reads prefs at module scope (main.jsx) so the first frame is
  // never animated, spaced or readable by accident. Every read in here
  // has to fall through to the defaults when storage refuses: one that
  // sat outside its guard took the whole boot down instead.
  const real = globalThis.localStorage
  globalThis.localStorage = {
    getItem: () => {
      throw new Error('storage is not available')
    },
    setItem: () => {
      throw new Error('storage is not available')
    },
    removeItem: () => {
      throw new Error('storage is not available')
    },
    clear: () => {},
  }
  try {
    const p = loadPrefs()
    assert.equal(p.reduce_motion, false)
    assert.equal(p.density, 'comfortable')
    assert.equal(p.startup_view, 'new')
    assert.equal(p.privacy_mode, false)
    // Saving under the same storage is already a no-op, never a throw.
    savePrefs({ density: 'compact' })
  } finally {
    globalThis.localStorage = real
  }
})