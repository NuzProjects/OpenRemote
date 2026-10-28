// The palette's dialog duty lives in dialog-focus.js and is tested by the
// modal family; this reads the two seams a unit test cannot see: that the
// palette actually joins that family (with its own Escape, so paging still
// works), and that the dispatcher refuses a navigating action while a field
// has focus.

import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'

const source = (file) => readFileSync(new URL(`./${file}`, import.meta.url), 'utf8')

test('the palette is a dialog like the others, and keeps its own Escape', () => {
  const palette = source('CommandPalette.jsx')
  assert.match(palette, /import \{ useDialog \} from '\.\/dialog-focus\.js'/)
  assert.match(palette, /useDialog\(panelRef, onClose, \{ esc: false \}\)/)
  // The element the hook focuses and traps is the one that carries the role.
  const at = palette.indexOf('className="kb-palette"')
  assert.ok(at > 0, 'the palette panel exists')
  const panel = palette.slice(at - 60, at + 220)
  assert.match(panel, /ref=\{panelRef\}/)
  assert.match(panel, /role="dialog"/)
  // Escape stays the palette's own key: a page steps back, the last page closes.
  assert.match(palette, /if \(page\) pageBack\(\)\s*\n\s*else onClose\(\)/)
})

test('a navigating shortcut stands down while a field has focus', () => {
  const keys = source('keyboard.jsx')
  const start = keys.indexOf('const onKey')
  const dispatch = keys.slice(start, keys.indexOf("window.addEventListener('keydown', onKey)"))
  assert.ok(start > 0 && dispatch.length > 0, 'the dispatcher exists')
  const gate = dispatch.indexOf('blocksWhileTyping(id)')
  const run = dispatch.indexOf('run(id)')
  assert.ok(gate >= 0, 'the typing gate is in the dispatcher')
  assert.ok(run > gate, 'and it runs before any handler')
  assert.match(dispatch, /preventDefault\(\)/, 'a swallowed Mod combo does not reach the browser')
})

test('an Escape in a field outside the chat does not interrupt the turn', () => {
  // Esc is the one action that fires while typing (the chat's own composer is where
  // holding a turn happens), and the field handlers that clear a search do not stop
  // the event. Without this guard, Escape pressed to clear the sidebar's search also
  // aborted the turn the sidebar was showing.
  const keys = source('keyboard.jsx')
  const start = keys.indexOf('const onKey')
  const dispatch = keys.slice(start, keys.indexOf("window.addEventListener('keydown', onKey)"))
  const guard = dispatch.indexOf("id === 'interrupt'")
  assert.ok(guard > 0, 'the dispatcher knows the one action Esc is bound to')
  assert.match(dispatch, /closest\?\.\('\.chatview'\)/, 'and where it may fire from')
  const run = dispatch.indexOf('run(id)')
  assert.ok(run > guard, 'the guard runs before the handler does')
})

test('an overlay owns the keyboard only while it is really on screen', () => {
  // A menu left in the DOM but hidden still matched the old selector, and then every
  // shortcut in the app was dead with nothing saying why.
  const keys = source('keyboard.jsx')
  assert.match(keys, /function overlayOpen\(\)[\s\S]{0,220}getClientRects\(\)\.length > 0/)
  assert.match(keys, /if \(overlayOpen\(\)\) return/, 'the dispatcher asks the question, not the selector')
  assert.doesNotMatch(keys, /if \(document\.querySelector\(OVERLAY\)\) return/)
})

test('the sheet explains the leave-the-chat rule where bindings are explained', () => {
  const sheet = source('ShortcutSheet.jsx')
  const at = sheet.indexOf('Actions that leave the chat')
  assert.ok(at > 0, 'the sentence is in the sheet')
  assert.ok(at > sheet.indexOf('kb-sheet-grid'), 'below the list, not at the top of the sheet')
  // The clause that carries the rule, not the whole sentence: the sheet owns
  // its wording, and a copy edit there should not fail this test.
  assert.match(
    sheet.slice(at),
    /wait until\s+the caret leaves the message box, so a half-written message is never lost\./,
  )
})

test('the capture refuses a key the dispatcher will not deliver, and says why', () => {
  const settings = source('SettingsView.jsx')
  assert.match(settings, /import \{[^}]*captureRefusal[^}]*\} from '\.\/shortcuts\.js'/)
  const capture = settings.slice(settings.indexOf('const onKey = (e) =>'), settings.indexOf('window.addEventListener'))
  assert.match(capture, /captureRefusal\(combo\)/)
  const refusal = capture.indexOf('captureRefusal(combo)')
  const rebind = capture.indexOf('kb.rebind')
  assert.ok(rebind > refusal, 'nothing is bound before the refusal is asked')
  assert.match(capture, /setRefused\(refusal\)/, 'and the reason is shown under the row')
  assert.match(settings, /\{refused && capturing === a\.id && <div className="pn-detail">\{refused\}<\/div>\}/)
})

test('a saved key for a removed action is shown with a way to clear it', () => {
  const settings = source('SettingsView.jsx')
  assert.match(settings, /kb\.staleBindings\?\.length > 0/)
  assert.match(settings, /Saved shortcut for an action this build no longer has/)
  assert.match(settings, /kb\.clearStale\(\)/)
})
