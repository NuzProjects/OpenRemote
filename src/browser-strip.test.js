// The browser's one-level-back rules, pinned: the closed-tab list and its cap,
// both close-many commands in strip order, and which tabs a measured strip
// draws against a fixed tab width.

import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import {
  CLOSED_CAP,
  NEW_TAB_WIDTH,
  TAB_GAP,
  TAB_WIDTH,
  closeOthers,
  closeToRight,
  closedEntry,
  rememberClosed,
  stripPlan,
  takeClosed,
} from './browser-tabs.js'

const tab = (key, url = `https://${key}.example`, extra = {}) => ({ key, native: null, url, title: '', loading: false, ...extra })

test('a closed tab leaves its address and title, and the list is capped and newest first', () => {
  assert.equal(closedEntry(tab('a', '')), null, 'a new tab page has nothing to reopen')
  assert.equal(closedEntry(tab('a', 'about:blank')), null)
  assert.deepEqual(closedEntry(tab('a', 'https://x.test', { title: 'X' })), { url: 'https://x.test', title: 'X' })
  assert.equal(closedEntry(tab('a', 'https://x.test')).title, 'https://x.test', 'the address stands in for a title')
  let closed = []
  for (const n of ['a', 'b', 'c', 'd', 'e', 'f', 'g']) closed = rememberClosed(closed, tab(n))
  assert.equal(closed.length, CLOSED_CAP, 'five is the memory')
  assert.equal(closed[0].url, 'https://g.example', 'the last closed is the first offered')
  assert.equal(closed.at(-1).url, 'https://c.example', 'the oldest is forgotten')
  // Closing the same address twice keeps one entry, so one reopen gets it back.
  const once = rememberClosed([], tab('a', 'https://same.test'))
  const twice = rememberClosed(once, tab('a', 'https://same.test'))
  assert.equal(twice.length, 1)
  assert.equal(twice[0].url, 'https://same.test')
})

test('reopening takes the newest entry and leaves the rest, or nothing at all', () => {
  assert.equal(takeClosed([]), null)
  const entry = { url: 'https://x.test', title: 'X' }
  const kept = { url: 'https://y.test', title: 'Y' }
  assert.deepEqual(takeClosed([entry, kept]), { entry, rest: [kept] })
})

test('close others keeps only the tab asked from, close to the right keeps the rest of the line', () => {
  const tabs = [tab('a'), tab('b'), tab('c'), tab('d')]
  assert.deepEqual(closeOthers(tabs, 'b'), ['a', 'c', 'd'])
  assert.deepEqual(closeOthers([tab('a')], 'a'), [], 'one tab has no others')
  assert.deepEqual(closeOthers(tabs, 'nope'), [])
  assert.deepEqual(closeToRight(tabs, 'b'), ['c', 'd'])
  assert.deepEqual(closeToRight(tabs, 'd'), [], 'the last tab has nothing to its right')
  assert.deepEqual(closeToRight(tabs, 'nope'), [])
  // Strip order, not the visible subset: a resize must not change the answer.
  assert.deepEqual(closeToRight(tabs, 'a'), ['b', 'c', 'd'])
})

test('the strip draws whole tabs, reserves the overflow control, and never hides the active one', () => {
  // Everything fits: no control, nothing hidden. A tab costs its width plus
  // the gap after it, and the new-tab button is the last thing in the row.
  assert.deepEqual(stripPlan({ width: 5 * (TAB_WIDTH + TAB_GAP) + NEW_TAB_WIDTH, count: 5, active: 0 }), {
    start: 0,
    shown: 5,
    hidden: 0,
  })
  // Ten tabs in room for six: five tabs plus the control, five behind it.
  const wide = stripPlan({ width: 6 * TAB_WIDTH, count: 10, active: 0 })
  assert.equal(wide.shown, 5)
  assert.equal(wide.hidden, 5)
  assert.ok((TAB_WIDTH + TAB_GAP) * wide.shown + NEW_TAB_WIDTH <= 6 * TAB_WIDTH)
  // The active tab is always inside the window, even when it is the last one.
  const atEnd = stripPlan({ width: TAB_WIDTH * 3, count: 10, active: 9 })
  assert.equal(atEnd.shown, 2, 'two tabs and the control fit in three tabs of room')
  assert.equal(atEnd.start, 8)
  assert.equal(atEnd.hidden, 8)
  // Unmeasured and empty strips: everything, and nothing.
  assert.deepEqual(stripPlan({ width: 0, count: 4, active: 0 }), { start: 0, shown: 4, hidden: 0 })
  assert.deepEqual(stripPlan({ width: 100, count: 0, active: 0 }), { start: 0, shown: 0, hidden: 0 })
  // A strip too narrow for a tab and the control still shows the active tab.
  const narrow = stripPlan({ width: 150, count: 6, active: 3 })
  assert.equal(narrow.shown, 1)
  assert.equal(narrow.start, 3)
  assert.equal(narrow.hidden, 5)
})

// ---- the sheet's numbers, read out of the sheet ----
//
// The plan and the CSS cannot be allowed to drift: a constant no selector
// honours draws tabs that are not there. This reads browser.css, so the only
// way to change one of these widths is to change both files.

const sheet = readFileSync(new URL('./browser.css', import.meta.url), 'utf8')

const blockOf = (selector) => {
  const at = sheet.indexOf(`${selector} {`)
  assert.ok(at > 0, `${selector} is in the sheet`)
  return sheet.slice(at, sheet.indexOf('}', at))
}

const px = (block, prop) => {
  const match = new RegExp(`(?:^|\\n)\\s*${prop}:\\s*(\\d+)px`).exec(block)
  assert.ok(match, `${prop} is a px number in that block`)
  return Number(match[1])
}

test("the strip's numbers are the sheet's numbers", () => {
  assert.equal(px(blockOf('.bw-tab'), 'width'), TAB_WIDTH, 'TAB_WIDTH and .bw-tab')
  assert.equal(px(blockOf('.bw-tabs-scroll'), 'gap'), TAB_GAP, 'TAB_GAP and .bw-tabs-scroll')
  assert.equal(px(blockOf('.bw-newtab'), 'width'), NEW_TAB_WIDTH, 'NEW_TAB_WIDTH and .bw-newtab')
  // The overflow control is not planned against, so its width is asserted
  // here rather than kept as a constant: this is the sheet's own number.
  assert.equal(px(blockOf('.bw-tabsearch.is-more'), 'width'), 56, 'the overflow control is 56px')
  // The element the ResizeObserver watches must not carry padding of its own:
  // the plan treats its width as the space tabs occupy, and the strip's own
  // padding lives on .bw-tabs, outside that element.
  assert.doesNotMatch(blockOf('.bw-tabs-scroll'), /padding/)
})
