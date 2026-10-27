// The rename dialog's rules, and the wiring that keeps the sidebar's menu row
// and the dialog pointing at the same thing. The rules are pure; the wiring
// checks read the sources, the way the console's other wiring tests do.

import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { MAX_NAME, cleanName, renameState, shownTitle } from './rename-chat.js'

test('a name is trimmed at its ends and keeps the spacing inside it', () => {
  assert.equal(cleanName('  My chat  '), 'My chat')
  assert.equal(cleanName('Fix  the   bug'), 'Fix  the   bug')
  assert.equal(cleanName('\n\t Release plan \t'), 'Release plan')
  assert.equal(cleanName(null), '')
  assert.equal(cleanName(undefined), '')
})

test('a name is cut to what the daemon keeps, by character', () => {
  // The daemon stores the first 200 characters, so the dialog shows what will
  // be stored rather than a longer string that comes back shorter.
  const long = 'a'.repeat(MAX_NAME + 40)
  assert.equal(cleanName(long).length, MAX_NAME)
  // Cut by character: an emoji is one character to the daemon and two UTF-16
  // units to JavaScript, and half of one is mojibake.
  const emoji = '😀'.repeat(MAX_NAME + 5)
  const cut = cleanName(emoji)
  assert.equal(Array.from(cut).length, MAX_NAME)
  assert.equal(cut, '😀'.repeat(MAX_NAME))
})

test('an empty or whitespace-only field has nothing to save', () => {
  for (const text of ['', '   ', '\n\t ', null]) {
    assert.deepEqual(renameState('Old name', text), { state: 'empty', value: '' })
  }
  // Even with no current name (a chat always has one, but the rule should not
  // depend on it), an empty field is still empty.
  assert.equal(renameState(null, '   ').state, 'empty')
})

test('the same name closes without a write', () => {
  assert.equal(renameState('My chat', 'My chat').state, 'unchanged')
  // The comparison is on the cleaned form: whitespace around it is not a
  // change, and a real change is anything the daemon would store differently.
  assert.equal(renameState('My chat', '  My chat  ').state, 'unchanged')
  assert.equal(renameState('My chat', 'my chat').state, 'saveable')
  assert.equal(renameState('My chat', 'My chat 2').state, 'saveable')
})

test('a saveable name is the cleaned value that gets sent', () => {
  assert.deepEqual(renameState('Old', '  New name '), { state: 'saveable', value: 'New name' })
  const long = renameState('Old', 'b'.repeat(MAX_NAME + 10))
  assert.equal(long.state, 'saveable')
  assert.equal(long.value.length, MAX_NAME)
})

test('the row shows the saved name until the console record catches up', () => {
  // The provider returns the daemon's answer but does not fold it, so the row
  // is optimistic for one beat; once the record carries the name, the record
  // is what shows (which is also how a rename from another device lands).
  assert.equal(shownTitle('New name', 'Old name'), 'New name')
  assert.equal(shownTitle('New name', 'New name'), 'New name')
  assert.equal(shownTitle(undefined, 'Old name'), 'Old name')
  assert.equal(shownTitle('', 'Old name'), 'Old name')
})

const source = (file) => readFileSync(new URL(`./${file}`, import.meta.url), 'utf8')

test('the dialog is in the modal family and saves on Enter', () => {
  const modal = source('RenameChatModal.jsx')
  // Esc / backdrop / X / focus trap / focus back all come from the family.
  assert.match(modal, /useDialog\(panelRef, onClose\)/)
  assert.match(modal, /useBack\(true, onClose\)/)
  assert.match(modal, /className="dv-modal-backdrop"/)
  assert.match(modal, /onMouseDown=\{\(e\) => \{/)
  // Enter saves; the field is selected on open so typing replaces the name.
  assert.match(modal, /e\.key !== 'Enter'/)
  assert.match(modal, /input\.select\(\)/)
  // An empty name cannot be saved, and a refusal keeps the dialog open.
  assert.match(modal, /disabled=\{busy \|\| verdict\.state === 'empty'\}/)
  assert.match(modal, /setError\(err\?\.message \?\? String\(err\)\)/)
  assert.match(modal, /<p className="cv-error-line">\{error\}<\/p>/)
  // The limit is the rule's, not a second number in the field.
  assert.match(modal, /maxLength=\{MAX_NAME\}/)
  // An unchanged name closes without a call to the daemon.
  assert.match(modal, /if \(verdict\.state === 'unchanged'\) \{[\s\S]{0,40}onClose\(\)/)
})

test('the sidebar menu offers Rename and hosts the dialog', () => {
  const sidebar = source('Sidebar.jsx')
  assert.match(sidebar, /label: 'Rename'/)
  assert.match(sidebar, /setRenaming\(row\)/)
  assert.match(sidebar, /<RenameChatModal/)
  // The dialog is fed the row's record and writes through the console, so
  // every surface showing the chat renames in the same beat.
  assert.match(sidebar, /title=\{renaming\.title\}/)
  assert.match(sidebar, /onRename=\{\(next\) => renameTo\(renaming\.id, next\)\}/)
  // The console call is the one the slash command makes, and the row shows
  // the new name at once (the provider does not fold the answer itself).
  assert.match(sidebar, /await renameChat\(id, next\)/)
  assert.match(sidebar, /shownTitle\(/)
})
