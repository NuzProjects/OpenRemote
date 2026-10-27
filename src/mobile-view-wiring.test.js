// A signed-in account with no phones left the Mobile view showing an empty
// grid under a heading that counted zero, so the page read as half-drawn
// and said nothing about what a phone is for. The empty state is now one
// row in the settings list shape. It has to stay distinct from the pairing
// panel above it, which has its own empty words about the local socket,
// and it must stay a sentence rather than a control, because the first
// step lives on the phone and a button here could only do nothing.

import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'

const view = readFileSync(new URL('./MobileView.jsx', import.meta.url), 'utf8')
const start = view.indexOf('function NoPhonesYet()')
const empty = view.slice(start, view.indexOf('export default function MobileView'))

test('the signed-in branch shows the empty row only when the account has no phones', () => {
  assert.notEqual(start, -1, 'NoPhonesYet is gone')
  assert.match(view, /phones\.length === 0 \? \(\s*<NoPhonesYet \/>/)
  // The grid is the other arm: a non-empty list is what renders cards.
  const branch = view.slice(view.indexOf('phones.length === 0'))
  assert.match(branch, /<div className="dv-grid">[\s\S]*phones\.map/)
})

test('the empty row says what a phone is for and what to do first', () => {
  assert.match(empty, /No phones in your Cloud yet\./)
  // What it is for: the synced chats, and the machines it can drive.
  assert.match(empty, /lists the chats you sync/)
  assert.match(empty, /drive your machines/)
  // What to do first: install it, then sign in with the same account.
  assert.match(empty, /Install OpenRemote on the phone/)
  assert.match(empty, /sign in[^.]*same account/)
})

test('the empty row is the settings row shape, not a new list of its own', () => {
  assert.match(empty, /pn-list pn-list--tight/)
  assert.match(empty, /className="pn-row"/)
  assert.match(empty, /className="pn-name"/)
  assert.match(empty, /className="pn-detail"/)
})

test('the empty row holds no control and never repeats the pairing panel', () => {
  // A button here would have nothing to press for: the step is on the
  // phone. A control that does nothing is what the contract bans.
  assert.doesNotMatch(empty, /onClick/)
  assert.doesNotMatch(empty, /<button/)
  // The pairing panel above owns the local-socket empty state. Reusing its
  // words here would send a user to pair a phone that is already paired.
  assert.doesNotMatch(empty, /No phones paired/)
  assert.doesNotMatch(empty, /QR/)
})
