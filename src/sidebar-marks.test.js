import assert from 'node:assert/strict'
import test from 'node:test'

const store = new Map()
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
  clear: () => store.clear(),
}

const { KEYS, loadList, saveList, toggled, pruned } = await import('./sidebar-marks.js')

test('a list of ids round-trips, and a damaged value reads as none', () => {
  store.clear()
  assert.deepEqual(loadList(KEYS.pinned), [])
  saveList(KEYS.pinned, ['b', 'a'])
  assert.deepEqual(loadList(KEYS.pinned), ['b', 'a'], 'the order is kept')
  store.set(KEYS.pinned, '{nope')
  assert.deepEqual(loadList(KEYS.pinned), [])
  store.set(KEYS.pinned, '{"a":1}')
  assert.deepEqual(loadList(KEYS.pinned), [])
  store.set(KEYS.pinned, '["a", 3, null, "a", "b"]')
  assert.deepEqual(loadList(KEYS.pinned), ['a', 'b'])
})

test('toggled appends in order, and hands back the same list when nothing changes', () => {
  const base = ['a', 'b']
  assert.deepEqual(toggled(base, 'c', true), ['a', 'b', 'c'])
  assert.deepEqual(base, ['a', 'b'], 'the input is untouched')
  assert.equal(toggled(base, 'a', true), base)
  assert.deepEqual(toggled(base, 'a', false), ['b'])
  assert.equal(toggled(base, 'zzz', false), base)
})

test('pruned drops ids that no longer exist and keeps the order', () => {
  const base = ['c', 'gone', 'a']
  assert.deepEqual(pruned(base, new Set(['a', 'b', 'c'])), ['c', 'a'])
  const whole = ['a', 'b']
  assert.equal(pruned(whole, new Set(['a', 'b', 'c'])), whole)
})
