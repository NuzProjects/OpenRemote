import assert from 'node:assert/strict'
import test from 'node:test'
import {
  DROP_BAND,
  MAX_PANES,
  balanceSplit,
  closeLeaf,
  dropZone,
  focusByIndex,
  focusLeaf,
  leaves,
  newLayout,
  paneCount,
  resizeSplit,
  restoreLayout,
  secondaryChatIds,
  setLeafView,
  splitLeaf,
} from './split.js'

const ids = (layout) => leaves(layout.root).map((l) => l.id)

test('a new layout is one primary pane with focus', () => {
  const l = newLayout()
  assert.equal(paneCount(l), 1)
  assert.equal(leaves(l.root)[0].view, null)
  assert.equal(l.focus, 'p1')
})

test('splitting opens a new pane beside the old one and focuses it', () => {
  const l = splitLeaf(newLayout(), 'p1', 'row')
  assert.deepEqual(ids(l), ['p1', 'p2'])
  assert.equal(l.focus, 'p2')
  assert.equal(l.root.dir, 'row')
  assert.deepEqual(l.root.sizes, [0.5, 0.5])
  assert.equal(leaves(l.root)[1].view, 'new')
})

test('repeated same-direction splits stay one flat row and halve the split pane', () => {
  let l = splitLeaf(newLayout(), 'p1', 'row')
  l = splitLeaf(l, 'p1', 'row')
  assert.equal(l.root.type, 'split')
  assert.deepEqual(ids(l), ['p1', 'p3', 'p2'])
  assert.deepEqual(l.root.sizes, [0.25, 0.25, 0.5])
})

test('splitting before opens to the left or above', () => {
  let l = splitLeaf(newLayout(), 'p1', 'row', 'new', true)
  assert.deepEqual(ids(l), ['p2', 'p1'])
  assert.equal(l.focus, 'p2')
  l = splitLeaf(l, 'p1', 'row', 'new', true)
  assert.deepEqual(ids(l), ['p2', 'p3', 'p1'])
  assert.deepEqual(l.root.sizes, [0.5, 0.25, 0.25])
})

test('a cross-direction split nests', () => {
  let l = splitLeaf(newLayout(), 'p1', 'row')
  l = splitLeaf(l, 'p2', 'col')
  assert.equal(l.root.children[1].type, 'split')
  assert.equal(l.root.children[1].dir, 'col')
  assert.deepEqual(ids(l), ['p1', 'p2', 'p3'])
})

test('the pane count is capped', () => {
  let l = newLayout()
  for (let i = 0; i < MAX_PANES + 3; i++) l = splitLeaf(l, l.focus, i % 2 ? 'row' : 'col')
  assert.equal(paneCount(l), MAX_PANES)
})

test('closing dissolves a split and hands over focus; the primary stays', () => {
  let l = splitLeaf(newLayout(), 'p1', 'row')
  assert.equal(closeLeaf(l, 'p1'), l)
  l = closeLeaf(l, 'p2')
  assert.equal(l.root.type, 'leaf')
  assert.equal(l.focus, 'p1')
})

test('closing gives the freed space to the neighbours', () => {
  let l = splitLeaf(newLayout(), 'p1', 'row')
  l = splitLeaf(l, 'p2', 'row')
  l = closeLeaf(l, 'p3')
  assert.deepEqual(ids(l), ['p1', 'p2'])
  assert.ok(Math.abs(l.root.sizes.reduce((a, b) => a + b, 0) - 1) < 1e-9)
})

test('closing inside a nested split collapses it into its sibling', () => {
  let l = splitLeaf(newLayout(), 'p1', 'row')
  l = splitLeaf(l, 'p2', 'col')
  l = closeLeaf(l, 'p3')
  assert.equal(l.root.children[1].type, 'leaf')
  assert.deepEqual(ids(l), ['p1', 'p2'])
})

test('a pane takes a view, but the primary never does', () => {
  let l = splitLeaf(newLayout(), 'p1', 'row')
  l = setLeafView(l, 'p2', 'chat-9')
  assert.equal(leaves(l.root)[1].view, 'chat-9')
  assert.equal(setLeafView(l, 'p1', 'chat-1'), l)
})

test('focus only moves to panes that exist', () => {
  const l = splitLeaf(newLayout(), 'p1', 'row')
  assert.equal(focusLeaf(l, 'p1').focus, 'p1')
  assert.equal(focusLeaf(l, 'nope'), l)
})

test('resizing moves the divider and respects the minimum', () => {
  let l = splitLeaf(newLayout(), 'p1', 'row')
  l = resizeSplit(l, l.root.id, 0, 0.2)
  assert.ok(Math.abs(l.root.sizes[0] - 0.7) < 1e-9)
  l = resizeSplit(l, l.root.id, 0, 5)
  assert.ok(Math.abs(l.root.sizes[1] - 0.15) < 1e-9)
  l = resizeSplit(l, l.root.id, 0, -5)
  assert.ok(Math.abs(l.root.sizes[0] - 0.15) < 1e-9)
})

test('secondary chat ids skip new-chat panes', () => {
  let l = splitLeaf(newLayout(), 'p1', 'row')
  l = splitLeaf(l, 'p2', 'col')
  l = setLeafView(l, 'p2', 'chat-9')
  assert.deepEqual(secondaryChatIds(l, (v) => v !== 'new'), ['chat-9'])
})

test('restore trusts only a well-formed layout', () => {
  const good = splitLeaf(newLayout(), 'p1', 'row')
  assert.deepEqual(restoreLayout(JSON.parse(JSON.stringify(good))), good)
  for (const bad of [
    null,
    {},
    { ...good, focus: 'zzz' },
    { ...good, root: { ...good.root, sizes: [0.9, 0.9] } },
    { ...good, root: { ...good.root, children: [good.root.children[0]] } },
    { ...good, root: { ...good.root, children: [good.root.children[1], good.root.children[1]] } },
  ]) {
    assert.equal(paneCount(restoreLayout(bad)), 1)
  }
})

test('a drop in the middle keeps the chat in that pane', () => {
  const box = { left: 0, top: 0, right: 600, bottom: 400, width: 600, height: 400 }
  assert.deepEqual(dropZone(box, 300, 200), { zone: 'center' })
  // Just inside the band on two sides at once still counts as an edge.
  assert.equal(dropZone(box, 300, 100).zone, 'top')
})

test('a drop near an edge splits on that side, nearest edge wins', () => {
  const box = { left: 0, top: 0, right: 600, bottom: 400, width: 600, height: 400 }
  const bandX = 600 * DROP_BAND
  const bandY = 400 * DROP_BAND
  assert.deepEqual(dropZone(box, bandX - 1, 200), { zone: 'left', dir: 'row', before: true })
  assert.deepEqual(dropZone(box, 600 - bandX + 1, 200), { zone: 'right', dir: 'row', before: false })
  assert.deepEqual(dropZone(box, 300, bandY - 1), { zone: 'top', dir: 'col', before: true })
  assert.deepEqual(dropZone(box, 300, 400 - bandY + 1), { zone: 'bottom', dir: 'col', before: false })
  // A corner belongs to the closer side, not the one it crossed first.
  assert.equal(dropZone(box, 20, 380).zone, 'left')
  assert.equal(dropZone(box, 580, 380).zone, 'right')
  // A panes far from every edge is a center target.
  assert.equal(dropZone(box, 300, 250).zone, 'center')
})

test('a short pane still has a middle: the band scales with the box', () => {
  const box = { left: 100, top: 50, right: 500, bottom: 150, width: 400, height: 100 }
  assert.equal(dropZone(box, 300, 100).zone, 'center')
  assert.equal(dropZone(box, 300, 60).zone, 'top')
})

test('double-clicking a divider evens its children, and only them', () => {
  let l = splitLeaf(newLayout(), 'p1', 'row')
  const splitId = l.root.id
  l = resizeSplit(l, splitId, 0, 0.2)
  assert.notEqual(l.root.sizes[0], l.root.sizes[1])
  assert.deepEqual(balanceSplit(l, splitId).root.sizes, [0.5, 0.5])
  // A row of three evens to thirds, and the sum never drifts from 1.
  const three = splitLeaf(l, 'p2', 'row')
  assert.equal(three.root.children.length, 3)
  const thirds = balanceSplit(three, splitId)
  assert.deepEqual(thirds.root.sizes, [1 / 3, 1 / 3, 1 / 3])
  assert.ok(Math.abs(thirds.root.sizes.reduce((a, b) => a + b, 0) - 1) < 1e-9)
  assert.equal(paneCount(thirds), 3)
  // An unknown split changes nothing (the same object comes back).
  assert.equal(balanceSplit(l, 'nope'), l)
})

test('focus by index walks the panes in reading order', () => {
  let l = splitLeaf(newLayout(), 'p1', 'row')
  l = splitLeaf(l, 'p2', 'col')
  assert.deepEqual(ids(l), ['p1', 'p2', 'p3'])
  assert.equal(focusByIndex(l, 0).focus, 'p1')
  assert.equal(focusByIndex(l, 2).focus, 'p3')
  assert.equal(focusByIndex(l, 9), l)
})
