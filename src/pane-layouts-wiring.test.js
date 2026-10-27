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
  assert.match(area, /import \{[^}]*MIN_PANES[^}]*loadLayouts[^}]*offerLayouts[^}]*\} from '\.\/layouts\.js'/)
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
  // Nothing saved is said in the menu rather than leaving it blank, in the one
  // sentence layouts.js holds (the palette's Layouts page says it too).
  assert.match(menu, /if \(offers\.length === 0\) items\.push\(\{ header: SAVED_LAYOUTS_NONE \}\)/)
})

test('the empty state is one sentence, shared with the palette\u2019s layouts page', () => {
  const layouts = source('layouts.js')
  assert.match(layouts, /export const SAVED_LAYOUTS_NONE = 'No saved layouts yet'/)
  const palette = source('CommandPalette.jsx')
  assert.match(palette, /SAVED_LAYOUTS_NONE, capacityLine, loadLayouts/)
  // The layouts page takes the specific sentence; the generic one stays for
  // pages that really have nothing at all.
  assert.match(palette, /page === 'layouts'\s*\n\s*\? SAVED_LAYOUTS_NONE/)
  assert.match(palette, /'Nothing to show here yet\.'/)
  // And no second copy of the sentence anywhere the two of them say it.
  const copies = (source('SplitArea.jsx').match(/'No saved layouts yet'/g) ?? []).length
  assert.equal(copies, 0, 'the header menu reads the constant, not a copy')
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

// ---- what the header says ----

test('a chat pane header shows the chat, a role pane keeps the role name', () => {
  // The record comes from the console, the same source the sidebar reads.
  assert.match(area, /import \{ useConsole \} from '\.\/state\/console\.jsx'/)
  assert.match(area, /import \{ paneChatId, paneHeader \} from '\.\/pane-header\.js'/)
  assert.match(area, /const \{ chats, projects \} = useConsole\(\)/)
  assert.match(area, /const chatId = paneChatId\(node\.view, currentChat\)/)
  assert.match(area, /const head = paneHeader\(\{/)
  assert.match(area, /projectFor\(projects \?\? \[\], chat\.workspace\)/)
})

test('the header wears the sidebar dot and the sidebar harness mark, one line', () => {
  // Same classes and statuses as the sidebar's row: one language, not two.
  assert.match(area, /className=\{`dot dot--\$\{head\.status\}`\}/)
  assert.match(area, /<HarnessMark harness=\{head\.harness\} size=\{12\} \/>/)
  // The title truncates while the controls keep their width.
  assert.match(area, /<span className="split-title">\{head\.title\}<\/span>/)
  assert.match(area, /<span className="split-project">\{`· \$\{head\.project\}`\}<\/span>/)
  assert.match(css, /\.split-title \{[\s\S]{0,140}text-overflow: ellipsis/)
  assert.match(css, /\.split-project \{[\s\S]{0,200}text-overflow: ellipsis/)
  assert.match(css, /\.split-actions \{\s*flex: none/, 'the actions never give ground to the title')
  // A role pane renders none of the chat parts: no dot, no mark, no project.
  assert.match(area, /\{head\.chat && <span className=\{`dot dot--/)
  assert.match(area, /\{head\.chat && head\.harness && <HarnessMark/)
  assert.match(area, /\{head\.project && <span className="split-project">/)
})
