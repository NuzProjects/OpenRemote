// The two layout fixes: the question a restore has to ask, and the pixel floor
// its fractions have to respect. Both are pure, so the window that is too small
// is a number in a test rather than a screenshot.

import assert from 'node:assert/strict'
import test from 'node:test'
import { PANE_MIN_PX, fitLayout, restoreConfirm, sameShape } from './layouts.js'
import { paneCount } from './split.js'

const leaf = (view, id) => ({ type: 'leaf', id, view })
const split = (dir, sizes, children, id = 's1') => ({ type: 'split', id, dir, sizes, children })

const plan = (root, view = 'new') => ({
  ok: true,
  primaryRole: view,
  layout: { root, focus: root.id, seq: 9 },
})

const onePane = () => ({ root: leaf(null, 'p1'), focus: 'p1', seq: 1 })
const twoPanes = () =>
  ({ root: split('row', [0.5, 0.5], [leaf(null, 'p1'), leaf('chat-x', 'p2')]), focus: 'p1', seq: 2 })

test('a restore asks only when something open would be taken away', () => {
  const saved = plan(split('row', [0.5, 0.5], [leaf('new', 'p1'), leaf('new', 'p2')]))
  // A window with only its primary pane has nothing to lose.
  const empty = onePane()
  assert.equal(restoreConfirm(saved, empty), null, 'nothing is open')
  // The shape already on screen: restoring it changes nothing, so no question.
  const identical = { root: saved.layout.root, focus: 'p1', seq: 2 }
  assert.equal(restoreConfirm(saved, identical), null, 'the same window')
  assert.equal(sameShape(saved.layout.root, identical.root), true)
  // Four panes open, a two-pane shape: it asks, and it says what closes.
  const four = {
    root: split('row', [0.5, 0.5], [
      split('col', [0.5, 0.5], [leaf(null, 'p1'), leaf('chat-a', 'p2')], 's2'),
      split('col', [0.5, 0.5], [leaf('chat-b', 'p3'), leaf('chat-c', 'p4')], 's3'),
    ]),
    focus: 'p1',
    seq: 4,
  }
  const ask = restoreConfirm(saved, four)
  assert.ok(ask, 'four panes replaced by two asks')
  assert.equal(ask.open, 4)
  assert.equal(ask.incoming, 2)
  assert.equal(ask.dropped, 2)
  assert.equal(ask.title, 'Restore this layout?')
  assert.equal(ask.confirm, 'Restore')
  assert.equal(ask.cancel, 'Keep what is open')
  assert.match(ask.note, /replaces the 4 panes open now with a 2-pane shape/)
  assert.match(ask.note, /2 panes close/)
  assert.match(ask.note, /The chats themselves stay in the sidebar\./)
})

test('a restore that grows the window asks, and one that would not change it does not', () => {
  const savedFour = plan(
    split('row', [0.5, 0.5], [
      split('col', [0.5, 0.5], [leaf('new', 'p1'), leaf('new', 'p2')], 's2'),
      split('col', [0.5, 0.5], [leaf('new', 'p3'), leaf('new', 'p4')], 's3'),
    ]),
  )
  const ask = restoreConfirm(savedFour, twoPanes())
  assert.equal(ask.dropped, 0, 'nothing is dropped when the shape grows')
  assert.match(ask.note, /replaces the 2 panes open now with a 4-pane shape/)
  assert.doesNotMatch(ask.note, /panes close/)
  // A plan that cannot open is not a question: the row is already disabled with
  // its reason.
  assert.equal(restoreConfirm({ ok: false, refusal: { code: 'capacity' } }, twoPanes()), null)
  assert.equal(restoreConfirm(null, twoPanes()), null)
})

test('the floor gives every pane its minimum, recursively', () => {
  // A 1000px window, a 90/10 split: the 10% pane has to grow to the floor.
  const layout = { root: split('row', [0.9, 0.1], [leaf(null, 'p1'), leaf('chat', 'p2')]), focus: 'p1', seq: 2 }
  const fitted = fitLayout(layout, { width: 1000, minPx: PANE_MIN_PX })
  const widths = fitted.root.sizes.map((size) => size * 1000)
  assert.ok(widths[0] >= PANE_MIN_PX - 0.01, `left pane is ${widths[0]}px`)
  assert.ok(widths[1] >= PANE_MIN_PX - 0.01, `right pane is ${widths[1]}px`)
  assert.ok(Math.abs(fitted.root.sizes.reduce((a, b) => a + b, 0) - 1) < 0.000001, 'sizes still add to one')
  // A nested split is measured against its own width, not the window's.
  const nested = {
    root: split('row', [0.5, 0.5], [
      leaf(null, 'p1'),
      split('col', [0.95, 0.05], [leaf('chat-a', 'p2'), leaf('chat-b', 'p3')], 's2'),
    ]),
    focus: 'p1',
    seq: 3,
  }
  const inner = fitLayout(nested, { width: 1000, minPx: 240 }).root.children[1]
  const innerWidths = inner.sizes.map((size) => size * 500)
  assert.ok(innerWidths.every((w) => w >= 240 - 0.01), `inner widths ${innerWidths.join(', ')}`)
})

test('when the floor cannot be met the children split evenly, and the trade is stated', () => {
  // Three panes in a 600px window cannot each have 240: 600 < 720.
  const layout = {
    root: split('row', [0.8, 0.1, 0.1], [leaf(null, 'p1'), leaf('chat-a', 'p2'), leaf('chat-b', 'p3')]),
    focus: 'p1',
    seq: 3,
  }
  const fitted = fitLayout(layout, { width: 600, minPx: 240 })
  assert.deepEqual(fitted.root.sizes.map((size) => Math.round(size * 1000) / 1000), [0.333, 0.333, 0.333])
  assert.ok(fitted.root.sizes.every((size) => size * 600 < 240), 'the floor is honestly not met')
  // Pane count and ids survive: this is the same window, just fitted.
  assert.equal(paneCount(fitted), 3)
  assert.deepEqual(fitted.root.children.map((c) => c.id), ['p1', 'p2', 'p3'])
})
