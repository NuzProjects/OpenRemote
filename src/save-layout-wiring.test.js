// The save-layout dialog's wiring: one field, the family's plumbing, and the
// rules module doing the storing. A layout is a shape, so this reads the dialog
// to prove it saves the roles and sizes layouts.js hands it and no chat id.

import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'

const modal = readFileSync(new URL('./SaveLayoutModal.jsx', import.meta.url), 'utf8')

test('the dialog is the family\'s, with one field and one primary', () => {
  assert.ok(modal.includes('useDialog(panelRef, onClose)'), 'focus in, Tab inside, focus back')
  assert.ok(modal.includes('useBack(true, onClose)'), 'Esc and the backdrop close it')
  assert.ok(modal.includes('dv-modal-backdrop') && modal.includes('dv-modal"'), 'it wears the family shell')
  assert.ok(modal.includes('className="sl-input"'), 'one field, for the name')
  assert.ok(modal.includes('Save layout'), 'and one primary')
})

test('it saves the shape the rules built, and nothing about which chat was there', () => {
  assert.ok(modal.includes('shapeOf(layout, { primaryView: currentView, isChat })'), 'the shape is the module\'s')
  assert.ok(
    modal.includes('{ name: name.trim(), panes: shape.panes, tree: shape.tree }'),
    'the store gets the name, the pane count and the tree',
  )
  assert.equal(
    modal.includes('currentView }'),
    false,
    'the view on screen is a role, never stored as itself',
  )
  assert.ok(modal.includes('withLayout('), 'the list is appended through the module')
  assert.ok(modal.includes('loadLayouts(),'), 'over what is already saved')
  assert.ok(modal.includes('saveLayouts(saved)'), 'and written once')
  assert.ok(modal.includes('disabled={!ready}'), 'an unnamed layout cannot be saved')
})

test('Enter saves, and the field is focused by hand the way its siblings are', () => {
  // Enter commits, as it does in the rename and preset dialogs.
  assert.match(modal, /if \(e\.key !== 'Enter'\) return\s*\n\s*e\.preventDefault\(\)\s*\n\s*save\(\)/)
  // The field takes focus on mount through a ref, not the autoFocus attribute:
  // the palette closes just before this dialog opens and restores focus to the
  // row that opened it, which could take the mount-time focus away.
  assert.match(modal, /const inputRef = useRef\(null\)/)
  assert.match(modal, /useEffect\(\(\) => \{\s*\n\s*const input = inputRef\.current\s*\n\s*if \(!input\) return\s*\n\s*input\.focus\(\)\s*\n\s*input\.select\(\)/)
  assert.match(modal, /ref=\{inputRef\}/)
  assert.doesNotMatch(modal, /^\s*autoFocus\b/m, 'no autoFocus attribute on the field')
  // Escape stays the family's cancel, one layer at a time.
  assert.match(modal, /useDialog\(panelRef, onClose\)/)
  assert.match(modal, /useBack\(true, onClose\)/)
})
