// The browser's stored state has one piece that outlives a console reload:
// which page the user was on. The shell hands the pages back
// (`browser_tabs`) and the console used to land on the first one, so a
// development reload moved the user to a different tab and covered the
// console with it while it booted. These two cases pin the rule.

import assert from 'node:assert/strict'
import test from 'node:test'
import { getState, restoredActive, setState } from './browser-store.js'

const KEY = 'openremote-browser-active'

function fakeStorage() {
  const store = new Map()
  return {
    store,
    getItem: (key) => store.get(key) ?? null,
    setItem: (key, value) => store.set(key, value),
    removeItem: (key) => store.delete(key),
  }
}

test('switching tabs records the page, so a reload can come back to it', () => {
  const previous = globalThis.sessionStorage
  const storage = fakeStorage()
  globalThis.sessionStorage = storage
  try {
    setState(() => ({
      tabs: [
        { key: 'a', native: 'tab-1' },
        { key: 'b', native: 'tab-2' },
      ],
      active: 'b',
    }))
    assert.equal(storage.store.get(KEY), 'tab-2')
    // An event that does not change the active tab writes nothing new: a
    // page's title and loading state fire constantly during a navigation.
    setState((s) => ({ tabs: s.tabs.map((t) => ({ ...t, title: 'x' })) }))
    assert.equal(storage.store.get(KEY), 'tab-2')
    setState((s) => ({ active: 'a' }))
    assert.equal(storage.store.get(KEY), 'tab-1')
  } finally {
    globalThis.sessionStorage = previous
    // The store is a module singleton: leave it the way the next test in
    // this file expects to find it.
    setState((s) => ({ tabs: s.tabs, active: s.tabs[0]?.key }))
  }
  assert.ok(getState().tabs.length > 0)
})

test('a page that is gone falls back to the first tab', () => {
  const tabs = [
    { key: 'x', native: 'tab-7' },
    { key: 'y', native: 'tab-9' },
  ]
  assert.equal(restoredActive(tabs, 'tab-9'), 'y')
  // Closed in the shell while the console was loading: land somewhere real.
  assert.equal(restoredActive(tabs, 'tab-3'), 'x')
  assert.equal(restoredActive(tabs, null), 'x')
  assert.equal(restoredActive([], 'tab-1'), undefined)
})
