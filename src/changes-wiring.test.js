// The review surface's wiring, in the pattern of the other wiring tests:
// the parts a reader cannot see from the pure rules - that the dialog is a
// member of the one modal family, that it takes its numbers from changes.js
// and its caps from the transcript's own budget, that its styles live in the
// sheet the main canvas already loads, and that the shell mounts it with a
// chat and nothing else.

import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'

const source = (file) => readFileSync(new URL(`./${file}`, import.meta.url), 'utf8')

test('the review is a member of the modal family, with the family ways out', () => {
  const modal = source('ChangesModal.jsx')
  assert.match(modal, /className="dv-modal-backdrop"/)
  assert.match(modal, /className="dv-modal chg-modal"/)
  assert.match(modal, /className="dv-modal-head"/)
  assert.match(modal, /className="dv-modal-title"/)
  assert.match(modal, /className="dv-modal-close"/)
  assert.match(modal, /role="dialog"/)
  assert.match(modal, /aria-modal="true"/)
  // Backdrop click, the X, Esc and the phone's back: the family's four.
  assert.match(modal, /e\.target === e\.currentTarget/)
  assert.match(modal, /onClick=\{close\}/)
  assert.match(modal, /useDialog\(panelRef, close, \{ open \}\)/)
  assert.match(modal, /useBack\(open, close\)/)
})

test('it takes the numbers from the fold and the caps from the transcript budget', () => {
  const modal = source('ChangesModal.jsx')
  assert.match(modal, /import \{ fileChanges \} from '\.\/changes\.js'/)
  assert.match(modal, /fileChanges\(chat\?\.timeline\)/)
  // The transcript caps its diffs at the same bound; a second number here
  // would be one more place to keep in step.
  assert.match(modal, /import \{ MAX_RENDER_ROWS, capRows \} from '\.\/render-budget\.js'/)
  assert.match(modal, /capRows\(rows\)/)
  assert.match(modal, /Showing the first \{MAX_RENDER_ROWS\} rows/)
})

test('it says what it is not, and says which kind of nothing', () => {
  const modal = source('ChangesModal.jsx')
  assert.match(modal, /Not a git diff: nothing here stages, commits or reverts\./)
  // Two different empties: a transcript with no edits, and a chat whose
  // transcript is not in this window. The second must never read as the first.
  assert.match(modal, /folded\.empty === 'no-edit'/)
  assert.match(modal, /folded\.empty === 'no-transcript'/)
  assert.match(modal, /No file changes in this chat\./)
  assert.match(modal, /transcript is not in this window/)
})

test('the shell can mount it with a chat and nothing else', () => {
  const modal = source('ChangesModal.jsx')
  assert.match(modal, /export default function ChangesModal\(\{ chat \}\)/)
  assert.match(modal, /if \(!open \|\| !chat\) return null/)
  // Anything can ask it to open; App does not pass an open flag down. A
  // request for another chat is dropped, so one modal per pane later cannot
  // open the wrong review.
  assert.match(modal, /export function openChanges\(chatId = null\)/)
  assert.match(modal, /if \(chatId && chat\?\.id !== chatId\) return/)
  assert.match(modal, /listeners\.add\(ask\)/)
})

test('its styles are its own sheet, and add no colour or shadow', () => {
  // The dialog imports its own sheet; borrowing the sidebar's would make the
  // review depend on whatever else the shell happens to load.
  assert.match(source('ChangesModal.jsx'), /import '\.\/changes\.css'/)
  assert.doesNotMatch(source('ChangesModal.jsx'), /import '\.\/sidebar\.css'/)
  const css = source('changes.css')
  assert.match(css, /The review surface:/)
  for (const rule of ['.chg-modal', '.chg-file', '.chg-path', '.chg-diff', '.chg-cell--del', '.chg-cell--add', '.chg-empty']) {
    assert.match(css, new RegExp(rule.replace('.', '\\.')), `${rule} is styled`)
  }
  const block = css
  assert.doesNotMatch(block, /box-shadow/, 'no shadows for depth')
  // The only literal colours are the contract's split-diff tints; every
  // other colour is a token.
  const literals = [...new Set([...block.matchAll(/#[0-9a-fA-F]{3,8}\b/g)].map((m) => m[0]))]
  assert.deepEqual(literals, ['#f87171'], 'the red fallback, and nothing else')
  assert.match(block, /rgba\(248, 113, 113, 0\.18\)/, 'del tint from the contract')
  assert.match(block, /rgba\(76, 180, 135, 0\.2\)/, 'add tint from the contract')
  // And nothing of the review is left in the sidebar's sheet.
  assert.doesNotMatch(source('sidebar.css'), /\.chg-/)
})

test('a phone gets one column of diff, not two half-width ones', () => {
  const css = source('changes.css')
  assert.match(css, /@media \(max-width: 639px\)/)
  assert.match(css, /grid-template-columns: minmax\(0, 1fr\);/)
})
