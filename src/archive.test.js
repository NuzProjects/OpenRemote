import assert from 'node:assert/strict'
import test from 'node:test'

const store = new Map()
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
  clear: () => store.clear(),
}

const { loadArchived, saveArchived, withArchived, activeSessions, archivedSessions } = await import(
  './archive.js'
)

test('archived ids round-trip through storage', () => {
  store.clear()
  assert.equal(loadArchived().size, 0)
  assert.equal(saveArchived(new Set(['a', 'b'])), true, 'the write says it landed')
  assert.deepEqual([...loadArchived()].sort(), ['a', 'b'])
})

test('a refused write says it did not land, instead of failing silently', () => {
  // A profile that refuses storage used to leave Restore in Settings with the row
  // unchanged and nothing said, while the toggles in the same pane report the refusal.
  const real = localStorage.setItem
  localStorage.setItem = () => {
    throw new Error('QuotaExceededError')
  }
  try {
    assert.equal(saveArchived(new Set(['a'])), false)
  } finally {
    localStorage.setItem = real
  }
})

test('a damaged value reads as none', () => {
  store.set('openremote-archived-chats', '{nope')
  assert.equal(loadArchived().size, 0)
  store.set('openremote-archived-chats', '{"a":1}')
  assert.equal(loadArchived().size, 0)
  store.set('openremote-archived-chats', '["a", 3, null]')
  assert.deepEqual([...loadArchived()], ['a'])
})

test('withArchived adds and removes without mutating', () => {
  const base = new Set(['a'])
  const added = withArchived(base, 'b', true)
  assert.deepEqual([...base], ['a'])
  assert.deepEqual([...added].sort(), ['a', 'b'])
  assert.deepEqual([...withArchived(added, 'a', false)], ['b'])
})

test('the sidebar list drops archived chats; the archive keeps them newest first', () => {
  const sessions = [
    { id: 'a', updated_at: 1 },
    { id: 'b', updated_at: 5 },
    { id: 'c', updated_at: 3 },
  ]
  const archived = new Set(['a', 'c', 'gone'])
  assert.deepEqual(activeSessions(sessions, archived).map((s) => s.id), ['b'])
  assert.deepEqual(archivedSessions(sessions, archived).map((s) => s.id), ['c', 'a'])
})
