// The text-field menu's rules, and the shell wiring that puts it where the
// webview's own menu used to open.

import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { fieldKind, insertAt, selectionOf, textMenuRows } from './text-menu.js'

test('only the fields a caret menu belongs in are fields', () => {
  assert.equal(fieldKind({ tagName: 'INPUT', type: 'text' }), 'input')
  assert.equal(fieldKind({ tagName: 'input', type: 'search' }), 'input')
  assert.equal(fieldKind({ tagName: 'TEXTAREA' }), 'textarea')
  assert.equal(fieldKind({ tagName: 'DIV', isContentEditable: true }), 'editable')
  // The types with no useful selection API.
  for (const type of ['number', 'date', 'color', 'file', 'checkbox', 'range']) {
    assert.equal(fieldKind({ tagName: 'INPUT', type }), null, type)
  }
  assert.equal(fieldKind({ tagName: 'DIV' }), null)
  assert.equal(fieldKind(null), null)
  assert.equal(fieldKind('input'), null)
})

test('pasting at the caret replaces the selection and moves the caret', () => {
  assert.deepEqual(insertAt('hello world', 6, 6, 'big '), {
    value: 'hello big world',
    caret: 10,
  })
  assert.deepEqual(insertAt('hello world', 0, 5, 'goodbye'), {
    value: 'goodbye world',
    caret: 7,
  })
  // Out-of-range positions clamp instead of slicing from nowhere.
  assert.deepEqual(insertAt('abc', 99, 99, '!'), { value: 'abc!', caret: 4 })
  assert.deepEqual(insertAt('abc', -5, 2, 'X'), { value: 'Xc', caret: 1 })
})

test('the selection is read off the field, and nothing off something else', () => {
  assert.deepEqual(selectionOf({ tagName: 'INPUT', type: 'text', value: 'abcdef', selectionStart: 1, selectionEnd: 3 }), {
    start: 1,
    end: 3,
    text: 'bc',
    editable: false,
  })
  // No selection API (or no selection): the caret is at the end, nothing
  // selected, so Cut and Copy are disabled rather than acting on everything.
  assert.deepEqual(selectionOf({ tagName: 'TEXTAREA', value: 'abc' }), {
    start: 3,
    end: 3,
    text: '',
    editable: false,
  })
  assert.equal(selectionOf({ tagName: 'DIV' }).text, '')
})

test('the rows are Cut, Copy, Paste, Select all, disabled where they cannot act', () => {
  const el = { tagName: 'INPUT', type: 'text', value: 'abcdef', selectionStart: 0, selectionEnd: 0 }
  const none = textMenuRows(el).map((r) => r.id)
  assert.deepEqual(none.slice(0, 2), ['cut', 'copy'])
  assert.equal(textMenuRows(el).find((r) => r.id === 'cut').disabled, true)
  assert.equal(textMenuRows(el).find((r) => r.id === 'copy').disabled, true)
  assert.equal(textMenuRows(el).find((r) => r.id === 'select-all').disabled, false)
  // Paste depends on the clipboard being readable at all, not on its contents.
  const paste = textMenuRows(el).find((r) => r.id === 'paste')
  assert.equal(paste, undefined, 'node has no clipboard, so Paste is not offered')
  const withSelection = { ...el, selectionEnd: 3 }
  assert.deepEqual(
    textMenuRows(withSelection)
      .filter((r) => r.id === 'cut' || r.id === 'copy')
      .map((r) => r.disabled),
    [false, false],
  )
})

test('the order is Cut, Copy, Paste, Select all when a paste is possible', () => {
  const el = { tagName: 'INPUT', type: 'text', value: 'x', selectionStart: 0, selectionEnd: 1 }
  assert.deepEqual(
    textMenuRows(el, true).map((r) => r.id),
    ['cut', 'copy', 'paste', 'select-all'],
  )
})

test('the shell listens once, at the document, and only for text fields', () => {
  const app = readFileSync(new URL('./App.jsx', import.meta.url), 'utf8')
  // A capture listener, so a field inside a pane or a popup is covered even
  // when the view around it has its own handler.
  assert.match(app, /document\.addEventListener\('contextmenu', [\w]+, true\)/)
  assert.match(app, /document\.removeEventListener\('contextmenu', [\w]+, true\)/)
  assert.match(app, /const el = textFieldOf\(e\.target\)/)
  // The fields are taken out of the engine's hands; everything else is left
  // to the handlers that already existed.
  assert.match(app, /<ContextMenu[\s\S]{0,200}items=\{textMenuItems\(/)
  assert.match(app, /import \{ textFieldOf, textMenuItems \} from '\.\/text-menu\.js'/)
})
