// The Browser group's rows: which tabs are listed, how a query ranks them
// against the palette's other rows, and what a tab with no title yet says.
// The ranker is the palette's own (shortcuts.js), so this test pins that a tab
// sorts by the same rule as a chat rather than by a second one invented here.

import assert from 'node:assert/strict'
import test from 'node:test'
import { browserTabs, tabRow } from './palette-tabs.js'

const tabs = [
  { key: 'a', title: 'OpenRemote docs', url: 'https://moreweb.space/openremote' },
  { key: 'b', title: 'Release notes', url: 'https://example.test/notes' },
  { key: 'c', title: '', url: '' },
]

test('a mounted browser lists every tab, in strip order, with no query', () => {
  const rows = browserTabs({ tabs, mounted: true })
  assert.deepEqual(rows.map((r) => r.key), ['a', 'b', 'c'])
  assert.equal(rows[0].name, 'OpenRemote docs')
  assert.equal(rows[0].sub, 'https://moreweb.space/openremote')
})

test('no browser on screen, or no tabs, means no group', () => {
  assert.deepEqual(browserTabs({ tabs, mounted: false }), [])
  assert.deepEqual(browserTabs({ tabs: [], mounted: true }), [])
  assert.deepEqual(browserTabs({ mounted: true }), [])
})

test('a tab with no title says so instead of showing an empty line', () => {
  const fresh = tabRow({ key: 'c', title: '', url: '' })
  assert.equal(fresh.name, 'New tab')
  assert.equal(fresh.sub, 'No address yet')
  const loading = tabRow({ key: 'd', title: '  ', url: 'https://example.test' })
  assert.equal(loading.name, 'New tab')
  assert.equal(loading.sub, 'https://example.test', 'the address answers when it has one')
})

test('a query ranks tabs by the palette ranker', () => {
  const all = browserTabs({ tabs, mounted: true, query: 'notes' })
  assert.equal(all[0].key, 'b', 'the matching title comes first')
  assert.ok(all.length <= tabs.length)
  // Something that matches nothing contributes nothing.
  assert.deepEqual(browserTabs({ tabs, mounted: true, query: 'zzzz' }), [])
})
