import assert from 'node:assert/strict'
import test from 'node:test'
import {
  SECTIONS,
  SETTING_GROUPS,
  SETTINGS_ENTRIES,
  searchSettings,
  visibleSections,
} from './settings-search.js'

test('section ids are unique and every entry points at one', () => {
  const ids = new Set(SECTIONS.map((s) => s.id))
  assert.equal(ids.size, SECTIONS.length)
  for (const entry of SETTINGS_ENTRIES) {
    assert.ok(ids.has(entry.section), `${entry.key} points at ${entry.section}`)
  }
  const keys = new Set(SETTINGS_ENTRIES.map((e) => e.key))
  assert.equal(keys.size, SETTINGS_ENTRIES.length, 'entry keys are unique')
})

test('every section sits in a declared group and no group is empty', () => {
  const groupIds = new Set(SETTING_GROUPS.map((g) => g.id))
  for (const section of SECTIONS) {
    assert.ok(groupIds.has(section.group), `${section.id} names ${section.group}`)
  }
  for (const group of SETTING_GROUPS) {
    assert.ok(
      SECTIONS.some((section) => section.group === group.id),
      `${group.label} owns a section`,
    )
  }
})

test('an empty or whitespace query matches nothing', () => {
  assert.deepEqual(searchSettings(''), [])
  assert.deepEqual(searchSettings('   '), [])
})

test('an exact row label outranks a mention in another row', () => {
  const hits = searchSettings('reduce motion')
  assert.equal(hits[0].key, 'appearance-motion')
})

test('a synonym finds the row that means it', () => {
  const hotkeys = searchSettings('hotkey')
  assert.ok(hotkeys.length > 0)
  assert.equal(hotkeys[0].section, 'keyboard')
  assert.equal(searchSettings('blur')[0].key, 'appearance-privacy')
})

test('a section name opens that section first', () => {
  assert.equal(searchSettings('daemon')[0].key, 'daemon')
  assert.equal(searchSettings('archived')[0].key, 'archived')
})

test('nonsense matches nothing rather than guessing', () => {
  assert.deepEqual(searchSettings('zzzxq'), [])
})

test('a phone sees the phone tabs, a desktop sees them all', () => {
  assert.deepEqual(
    visibleSections(true).map((s) => s.id),
    ['appearance', 'cloud', 'archived', 'this-install'],
  )
  assert.deepEqual(visibleSections(false), SECTIONS)
})
