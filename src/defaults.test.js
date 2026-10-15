import assert from 'node:assert/strict'
import test from 'node:test'

const store = new Map()
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
  clear: () => store.clear(),
}

const { loadDefaults, saveDefaults } = await import('./defaults.js')

test('defaults round-trip harness and model', () => {
  localStorage.clear()
  saveDefaults({ harness: 'claude', model: 'opus' })
  const d = loadDefaults()
  assert.equal(d.harness, 'claude')
  assert.equal(d.model, 'opus')
})

test('a partial save keeps the untouched fields', () => {
  localStorage.clear()
  saveDefaults({ harness: 'codex', model: 'o4' })
  saveDefaults({ model: 'o3' })
  const d = loadDefaults()
  assert.equal(d.harness, 'codex')
  assert.equal(d.model, 'o3')
})

test('the per-harness effort map survives partial saves', () => {
  localStorage.clear()
  saveDefaults({ efforts: { claude: 'high', codex: 'high' } })
  saveDefaults({ model: 'opus' })
  const d = loadDefaults()
  assert.deepEqual(d.efforts, { claude: 'high', codex: 'high' })
  // Writing one harness's tier keeps the other's.
  saveDefaults({ efforts: { ...d.efforts, claude: 'low' } })
  assert.deepEqual(loadDefaults().efforts, { claude: 'low', codex: 'high' })
})

test('garbage storage falls back to empty, non-string efforts dropped', () => {
  localStorage.clear()
  localStorage.setItem('openremote-defaults', 'nope{')
  const d = loadDefaults()
  assert.equal(d.harness, null)
  assert.deepEqual(d.efforts, {})
  assert.deepEqual(d.permissions, {})
  localStorage.setItem(
    'openremote-defaults',
    JSON.stringify({ efforts: { claude: 'high', bad: 3, 'x y': null } }),
  )
  assert.deepEqual(loadDefaults().efforts, { claude: 'high' })
})

test('the per-harness permission map survives partial saves', () => {
  localStorage.clear()
  saveDefaults({ permissions: { claude: 'bypassPermissions', codex: 'never' } })
  saveDefaults({ model: 'opus' })
  const d = loadDefaults()
  assert.deepEqual(d.permissions, {
    claude: 'bypassPermissions',
    codex: 'never',
  })
  // Writing one harness's word keeps the other's.
  saveDefaults({ permissions: { ...d.permissions, claude: 'plan' } })
  assert.deepEqual(loadDefaults().permissions, {
    claude: 'plan',
    codex: 'never',
  })
  // A non-string word is dropped on load, like the effort map's tiers.
  localStorage.setItem(
    'openremote-defaults',
    JSON.stringify({ permissions: { claude: 'default', bad: 3 } }),
  )
  assert.deepEqual(loadDefaults().permissions, { claude: 'default' })
})
