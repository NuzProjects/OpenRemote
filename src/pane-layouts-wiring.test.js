// The pane header's Layouts control, wired: one word button beside the split,
// a ContextMenu in the existing pattern, a list built from layouts.js and
// nothing reimplemented. The rules themselves are pinned in layouts.test.js.

import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'

const source = (file) => readFileSync(new URL(`./${file}`, import.meta.url), 'utf8')
const area = source('SplitArea.jsx')
const css = source('split.css')

test('the header gains one word control beside the split, in the same menu pattern', () => {
  // The button sits in the header's own actions row, after the split and
  // before the overflow, and it is a real button with the menu contract.
  const actions = area.slice(area.indexOf('<div className="split-actions">'), area.indexOf('{!primary && ('))
  assert.match(actions, /className="split-btn split-btn--text"/)
  assert.match(actions, />\s*Layouts\s*</)
  assert.match(actions, /aria-label="Saved layouts"/)
  assert.match(actions, /aria-haspopup="menu"/)
  assert.match(actions, /aria-expanded=\{Boolean\(layoutMenu\)\}/)
  assert.match(actions, /onClick=\{openLayoutMenu\}/)
  // It opens the same menu component the split options use, anchored under it,
  // so the keyboard, the Escape key and the viewport clamp are the existing
  // ones rather than a second implementation.
  assert.match(area, /<ContextMenu\s+x=\{layoutMenu\.x\}/)
  assert.match(area, /items=\{layoutMenuItems\(\)\}/)
  assert.match(area, /onClose=\{\(\) => setLayoutMenu\(null\)\}/)
})

test('the list comes from layouts.js, not from SplitArea', () => {
  assert.match(area, /import \{ MIN_PANES, loadLayouts, offerLayouts \} from '\.\/layouts\.js'/)
  assert.match(area, /const offers = offerLayouts\(loadLayouts\(\), \{ currentChat \}\)/)
  // Read when the menu opens: a shape saved elsewhere is in storage by then.
  assert.match(area, /const openLayoutMenu = \(\) => \{[\s\S]{0,220}setLayoutMenu\(\{ x:/)
  assert.doesNotMatch(area, /restoreShape\(/, 'the header does not restore on its own')
})

test('each layout carries its pane count, and one that cannot open says why', () => {
  const menu = area.slice(area.indexOf('const layoutMenuItems'), area.indexOf('const over ='))
  assert.match(menu, /hint: offer\.countLine/)
  // A refused shape stays in the list, disabled, with its sentence under it.
  assert.match(menu, /disabled: !offer\.ok/)
  assert.match(menu, /if \(!offer\.ok\) items\.push\(\{ header: offer\.note \}\)/)
  assert.match(menu, /onSelect: offer\.ok \? \(\) => onRestoreLayout\(offer\.plan\) : undefined/)
  // Nothing saved is said in the menu rather than leaving it blank.
  assert.match(menu, /if \(offers\.length === 0\) items\.push\(\{ header: 'No saved layouts yet' \}\)/)
})

test('save-as is offered only when the window holds more than one pane', () => {
  const menu = area.slice(area.indexOf('const layoutMenuItems'), area.indexOf('const over ='))
  assert.match(menu, /if \(count >= MIN_PANES && onSaveLayout\) \{/)
  assert.match(menu, /label: 'Save this layout…'/)
  assert.match(menu, /onSelect: \(\) => onSaveLayout\(\)/)
})

test('without the shell callbacks the control is not rendered at all', () => {
  // A menu that could not apply or save anything would be a dead control, so
  // the button is gated on the apply function the shell owns.
  assert.match(area, /\{onRestoreLayout && \(/)
  // And the shell hands over the three props (App.jsx is the one caller).
  assert.match(area, /onSaveLayout = null,/)
  assert.match(area, /onRestoreLayout = null,/)
  assert.match(area, /currentChat = null,/)
  assert.match(area, /onRestoreLayout=\{onRestoreLayout\}/)
})

test('the word keeps the header row, and the stylesheet says so', () => {
  assert.match(css, /\.split-btn--text \{/)
  const rule = css.slice(css.indexOf('.split-btn--text {'), css.indexOf('.split-btn--text:hover'))
  assert.match(rule, /width: auto/)
  assert.match(rule, /font-size: 11\.5px/)
})
