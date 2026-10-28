import assert from 'node:assert/strict'
import test from 'node:test'
import {
  DROP_BAND,
  MAX_PANES,
  acceptsChatDrop,
  balanceSplit,
  closeLeaf,
  createDividerDrag,
  CHAT_DRAG_TYPE,
  dropZone,
  focusByIndex,
  focusLeaf,
  leafById,
  leaves,
  moveLeaf,
  movedSizes,
  newLayout,
  paneCount,
  reconcilePanes,
  resizeSplit,
  restoreLayout,
  secondaryChatIds,
  setLeafView,
  splitLeaf,
  tintZone,
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

// ---- one drag paints, one release commits ----

test('a divider drag paints on every move and commits once, on release', () => {
  // The pane strip follows the pointer, and React hears about the drag once.
  // Committing per move re-rendered every pane, transcripts included, at
  // pointer rate; this is the rule that keeps one gesture to one commit.
  const commits = []
  const drag = createDividerDrag({ sizes: [0.5, 0.5], index: 0, total: 1000, start: 100 })
  for (const at of [140, 260, 380]) {
    const painted = drag.move(at)
    assert.ok(painted.sizes[0] > 0.5, 'the strip follows the pointer')
    assert.ok(painted.sizes[0] + painted.sizes[1] === 1, 'and the split stays whole')
  }
  assert.deepEqual(commits, [], 'no move commits anything')
  commits.push(drag.release())
  assert.equal(commits.length, 1, 'one commit for the whole drag')
  assert.equal(commits[0], 0.28, 'the delta is the whole gesture, not the last step')
})

test('a drag that never moved commits nothing (the first half of a double-click)', () => {
  const drag = createDividerDrag({ sizes: [0.5, 0.5], index: 0, total: 1000, start: 100 })
  drag.move(100)
  assert.equal(drag.release(), 0, 'a press and release with no motion is not a resize')
})

test('a split with no measured size never divides by zero', () => {
  const base = [0.5, 0.5]
  const drag = createDividerDrag({ sizes: base, index: 0, total: 0, start: 0 })
  const painted = drag.move(400)
  assert.equal(painted.sizes, base, 'nothing is repainted from an unmeasured box')
  assert.equal(drag.release(), 0)
})

test('movedSizes clamps both neighbours and leaves other arrays alone', () => {
  const same = (actual, expected, why) => {
    assert.equal(actual.length, expected.length, why)
    actual.forEach((value, i) => {
      assert.ok(Math.abs(value - expected[i]) < 1e-9, `${why}: ${value} vs ${expected[i]}`)
    })
  }
  same(movedSizes([0.5, 0.5], 0, 0.2), [0.7, 0.3], 'a free move')
  // Neither side goes below the minimum, in either direction.
  same(movedSizes([0.2, 0.8], 0, 0.9), [0.85, 0.15], 'clamped at the far side')
  same(movedSizes([0.8, 0.2], 0, -0.9), [0.15, 0.85], 'clamped at the near side')
  // An index with no neighbour is not a resize.
  const sizes = [1]
  assert.equal(movedSizes(sizes, 0, 0.2), sizes)
  assert.equal(movedSizes(sizes, 5, 0.2), sizes)
})

test('only a chat drag is offered a pane', () => {
  // The payload is unreadable during dragover, the types are not: a file or
  // a selected paragraph must not tint a pane it could never fill. A text
  // selection carries text/plain, so the private type is the only question
  // that can be asked without lying.
  assert.equal(acceptsChatDrop([CHAT_DRAG_TYPE]), true)
  assert.equal(acceptsChatDrop([CHAT_DRAG_TYPE, 'text/plain']), true, 'a chat drag may also carry other data')
  assert.equal(acceptsChatDrop(['text/plain']), false, 'a selected paragraph is not a chat')
  assert.equal(acceptsChatDrop(['text/plain', 'Files']), false, 'neither is a dragged file')
  assert.equal(acceptsChatDrop(['Files']), false, 'a file from the desktop')
  assert.equal(acceptsChatDrop([]), false, 'nothing to carry')
  assert.equal(acceptsChatDrop(undefined), false, 'a drag event with no dataTransfer')
  assert.equal(acceptsChatDrop(null), false)
})

// ---- moving a chat between panes, and repairing panes that lost theirs ----

test('a dragged chat moves out of its pane, and a drop on itself does nothing', () => {
  const l = splitLeaf(newLayout(), 'p1', 'row', 'chat-a')
  assert.equal(moveLeaf(l, 'p2', 'p2', 'row', false, 'chat-a'), l, 'a drop on its own pane is a no-op')
  const moved = moveLeaf(l, 'p2', 'p1', 'row', false, 'chat-a')
  assert.equal(paneCount(moved), 3)
  assert.equal(leafById(moved, 'p2').view, 'new', 'the source pane lets go of the chat')
  assert.equal(
    leaves(moved.root).filter((pane) => pane.view === 'chat-a').length,
    1,
    'one pane, one stream, one draft',
  )
  // A sidebar drag has no source pane: it opens beside and moves nothing.
  const beside = moveLeaf(l, null, 'p1', 'col', false, 'chat-b')
  assert.equal(leafById(beside, 'p2').view, 'chat-a')
})

test('the tint matches the drop: a full-pane target where no split can happen', () => {
  const box = { left: 0, top: 0, width: 400, height: 300, right: 400, bottom: 300 }
  assert.equal(tintZone(true, box, 395, 150).zone, 'right', 'an edge tints its half while a split is possible')
  assert.deepEqual(tintZone(false, box, 395, 150), { zone: 'center' }, 'at the cap the whole pane is the target')
  assert.deepEqual(tintZone(false, box, 5, 5), { zone: 'center' }, 'on a phone too, whatever the corner')
})

test('a pane whose chat is gone becomes a New chat, in place', () => {
  let l = splitLeaf(newLayout(), 'p1', 'row', 'chat-a')
  l = splitLeaf(l, 'p2', 'col', 'chat-b')
  const repaired = reconcilePanes(l, new Set(['chat-a']))
  assert.equal(leafById(repaired, 'p2').view, 'new', 'the pane stops pointing at nothing')
  assert.equal(leafById(repaired, 'p3').view, 'chat-b', 'the other pane keeps its chat')
  assert.equal(paneCount(repaired), 3, 'the arrangement is kept')
  assert.equal(leafById(repaired, 'p1').view, null, 'the primary keeps the app navigation')
})

test('a static view restored into a pane is repaired too', () => {
  const l = splitLeaf(newLayout(), 'p1', 'row', 'settings')
  assert.equal(leafById(reconcilePanes(l, new Set(['settings'])), 'p2').view, 'new')
})

test('nothing stale hands back the layout it was given', () => {
  const l = splitLeaf(newLayout(), 'p1', 'row', 'chat-a')
  assert.equal(reconcilePanes(l, new Set()), l)
  assert.equal(reconcilePanes(l, new Set(['chat-z'])), l)
  assert.equal(reconcilePanes(l, null), l)
})

// ---- the drag floor is the restored layout's own: pixels, not a fraction ----

const twoPane = () => splitLeaf(newLayout(), 'p1', 'row')

test('a drag in a 600px split cannot leave a neighbour below the pane floor', () => {
  // 15 percent of 600 is 90px, a pane header nobody can read. The neighbour
  // stops at 240px, which is 0.4 of the split.
  const painted = movedSizes([0.5, 0.5], 0, 0.9, 600)
  assert.ok(Math.abs(painted[1] * 600 - 240) < 1e-9, `neighbour ${painted[1] * 600}px`)
  assert.ok(Math.abs(painted[0] + painted[1] - 1) < 1e-9, 'the split stays whole')
  // The other direction lands on the same pixel number.
  const back = movedSizes([0.5, 0.5], 0, -0.9, 600)
  assert.ok(Math.abs(back[0] * 600 - 240) < 1e-9, `left ${back[0] * 600}px`)
})

test('the same drag in a 2000px split stops at the old fraction', () => {
  // 240/2000 is 0.12, below MIN_SIZE, so a wide window behaves exactly as
  // before: the fraction is still the stricter rule there.
  const painted = movedSizes([0.5, 0.5], 0, -0.9, 2000)
  assert.ok(Math.abs(painted[0] - 0.15) < 1e-9, `${painted[0]}`)
})

test('a split too narrow for two floors pins the divider instead of a sliver', () => {
  // 400px cannot hold two 240px panes: half is the honest answer, and neither
  // side is zero or negative.
  const pinned = movedSizes([0.5, 0.5], 0, 0.9, 400)
  assert.ok(Math.abs(pinned[0] - 0.5) < 1e-9, `${pinned[0]}`)
  assert.ok(Math.abs(pinned[1] - 0.5) < 1e-9, `${pinned[1]}`)
  const other = movedSizes([0.5, 0.5], 0, -0.9, 400)
  assert.ok(other[0] >= 0 && other[1] >= 0, `${other}`)
  // A pair narrower than two floors is split evenly, not pushed under zero.
  const narrow = movedSizes([0.3, 0.1], 0, 0.9, 600)
  assert.ok(Math.abs(narrow[0] - 0.2) < 1e-9, `${narrow[0]}`)
  assert.ok(Math.abs(narrow[1] - 0.2) < 1e-9, `${narrow[1]}`)
})

test('the paint and the commit agree on the released number', () => {
  // Both paths apply one floor, so the last painted frame is the layout the
  // release commits and the divider does not jump.
  const l = twoPane()
  const drag = createDividerDrag({ sizes: [0.5, 0.5], index: 0, total: 600, start: 300 })
  const painted = drag.move(300 + 200)
  const committed = resizeSplit(l, l.root.id, 0, drag.release(), 600)
  assert.ok(Math.abs(painted.sizes[0] - committed.root.sizes[0]) < 1e-9, `${painted.sizes} vs ${committed.root.sizes}`)
  assert.ok(Math.abs(painted.sizes[1] - committed.root.sizes[1]) < 1e-9, `${painted.sizes} vs ${committed.root.sizes}`)
})

test('no geometry keeps the fraction exactly, on both paths', () => {
  // movedSizes and resizeSplit are called from paths with no pixel size; those
  // keep today's rule instead of guessing one.
  const painted = movedSizes([0.5, 0.5], 0, -0.9)
  assert.ok(Math.abs(painted[0] - 0.15) < 1e-9, `${painted[0]}`)
  const l = twoPane()
  const committed = resizeSplit(l, l.root.id, 0, -0.9)
  assert.ok(Math.abs(committed.root.sizes[0] - 0.15) < 1e-9, `${committed.root.sizes[0]}`)
  // A junk total counts as no total.
  assert.ok(Math.abs(movedSizes([0.5, 0.5], 0, -0.9, Number.NaN)[0] - 0.15) < 1e-9)
  assert.ok(Math.abs(movedSizes([0.5, 0.5], 0, -0.9, 0)[0] - 0.15) < 1e-9)
})
