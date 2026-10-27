// The contract names one dropdown engine: `PickerMenu.jsx` - it opens at the
// cursor, searches, groups, keyboard-navigates and clamps to the viewport. A
// native `<select>` in a dark console gets none of that: the OS draws the
// list, the theme does not reach it, there is no search, and the arrows only
// work once the list is open. These files had five of them (an automation's
// hour and minute, an endpoint's credential kind, the plugin filters for
// category and marketplace), so a user met the OS's menu inside OpenRemote's
// own panels most days.
//
// This pins the rule rather than the five files: any `<select>` in a console
// view is the bug, wherever it appears.

import assert from 'node:assert/strict'
import test from 'node:test'
import { readdirSync, readFileSync } from 'node:fs'

const source = (file) => readFileSync(new URL(`./${file}`, import.meta.url), 'utf8')

const views = readdirSync(new URL('.', import.meta.url))
  .filter((name) => name.endsWith('.jsx'))
  .sort()

test('no console view draws its own native select', () => {
  const offenders = views.filter((name) => /<select\b/.test(source(name)))
  assert.deepEqual(
    offenders,
    [],
    `these views draw a native <select> instead of the one dropdown engine:\n  ${offenders.join('\n  ')}`,
  )
})

test('the controls that used to be native selects open PickerMenu', () => {
  // Named one by one: the rule above would pass just as well if a control
  // were dropped rather than rebuilt, and this is the list a reader is
  // looking for.
  for (const file of ['AutomationForm.jsx', 'EndpointManager.jsx', 'PluginDiscover.jsx']) {
    const text = source(file)
    assert.match(text, /import PickerMenu from '\.\/PickerMenu\.jsx'/, `${file} imports the engine`)
    assert.match(text, /aria-haspopup="listbox"/, `${file} marks its trigger as a list popup`)
  }
  // Two time fields in one form, two filters in one toolbar: each trigger
  // needs its own kind, so a picker open on one never answers for the other.
  assert.match(source('AutomationForm.jsx'), /openPicker\('hour'\)/)
  assert.match(source('AutomationForm.jsx'), /openPicker\('minute'\)/)
  assert.match(source('PluginDiscover.jsx'), /openPicker\('category'\)/)
  assert.match(source('PluginDiscover.jsx'), /openPicker\('market'\)/)
  assert.match(source('EndpointManager.jsx'), /openPicker\('authKind'\)/)
})
