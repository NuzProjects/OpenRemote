import assert from 'node:assert/strict'
import test from 'node:test'

import { MAX_PANES, newLayout, leaves, paneCount, splitLeaf } from './split.js'
import {
  LAYOUT_VERSION,
  MAX_SAVED,
  MIN_PANES,
  ROLES,
  UNOPENABLE_LINE,
  capacityLine,
  loadLayouts,
  offerLayouts,
  paneCountLine,
  restoreShape,
  saveLayouts,
  shapeOf,
  validateShape,
  withLayout,
  withoutLayout,
} from './layouts.js'

const isChat = (view) => view === 'chat-a' || view === 'chat-b'

// A stored leaf, and the flag that says this one is the primary pane. The flag
// exists because the primary is not always first: "Split left" puts a pane in
// front of it.
const leaf = (role, extra = {}) => ({ type: 'leaf', role, ...extra })
const PRIMARY = { primary: true }

// A window of three panes: the primary showing a chat, a New chat, and a second
// chat. A static page cannot sit in a pane at all (the shell only draws pages in
// the primary), so a window built by the app never has one there.
function threeInARow() {
  let layout = splitLeaf(newLayout(), 'p1', 'row', 'new')
  layout = splitLeaf(layout, layout.focus, 'row', 'chat-b')
  return layout
}

test('a window becomes a shape of roles, never of chats, with its primary marked', () => {
  const layout = threeInARow()
  const made = shapeOf(layout, { primaryView: 'chat-a', isChat })
  assert.equal(made.ok, true)
  assert.equal(made.panes, 3)
  assert.deepEqual(
    made.tree.children.map((child) => child.role),
    ['chat', 'new', 'chat'],
    'the primary takes the role of what is on screen, the rest their own views',
  )
  assert.deepEqual(
    made.tree.children.map((child) => child.primary === true),
    [true, false, false],
    'the flag marks which leaf is the primary',
  )
  assert.equal(
    JSON.stringify(made.tree).includes('chat-a'),
    false,
    'no chat id is stored anywhere in the shape',
  )
  assert.deepEqual(made.tree.sizes.reduce((a, b) => a + b, 0), 1, 'the sizes survive as they were')
})

test('a static view on screen is the primary pane\'s role too', () => {
  const made = shapeOf(threeInARow(), { primaryView: 'settings', isChat })
  assert.equal(made.tree.children[0].role, 'settings')
  assert.equal(made.tree.children[0].primary, true)
})

test('one pane is not a shape, and a view no pane can show cannot be stored', () => {
  assert.deepEqual(shapeOf(newLayout(), { primaryView: 'chat-a', isChat }), {
    ok: false,
    reason: 'too-few-panes',
  })
  assert.equal(MIN_PANES, 2)
  const odd = splitLeaf(newLayout(), 'p1', 'row', 'terminal')
  assert.deepEqual(shapeOf(odd, { primaryView: 'new', isChat }), { ok: false, reason: 'unknown-view' })
  // A static page in a side pane is a window the shell cannot draw back.
  const pageInPane = splitLeaf(newLayout(), 'p1', 'row', 'plugins')
  assert.deepEqual(
    shapeOf(pageInPane, { primaryView: 'new', isChat }),
    { ok: false, reason: 'static-in-pane' },
    'saving a page in a pane would save a window that cannot come back',
  )
})

const shape = (extra = {}) => ({
  name: 'Review',
  version: LAYOUT_VERSION,
  panes: 2,
  tree: {
    type: 'split',
    dir: 'row',
    sizes: [0.5, 0.5],
    children: [leaf('chat', PRIMARY), leaf('plugins')],
  },
  ...extra,
})

test('a stored shape is checked, and one this build cannot use is refused', () => {
  const good = validateShape(shape())
  assert.equal(good.ok, true)
  assert.equal(good.shape.name, 'Review')
  assert.equal(good.shape.panes, 2)

  const older = validateShape(
    shape({ tree: { type: 'split', dir: 'row', sizes: [0.5, 0.5], children: [leaf('chat', PRIMARY), leaf('terminal')] } }),
  )
  assert.deepEqual(older, { ok: false, reason: 'unknown-role' }, 'a role this build lost is refused, not guessed')

  assert.deepEqual(validateShape(shape({ name: '   ' })), { ok: false, reason: 'no-name' })
  assert.deepEqual(validateShape(shape({ panes: 5 })), { ok: false, reason: 'pane-count' })
  assert.deepEqual(validateShape(shape({ panes: 1 })), { ok: false, reason: 'pane-count' })
  assert.deepEqual(
    validateShape(shape({ tree: { type: 'split', dir: 'row', sizes: [0.5], children: [leaf('chat', PRIMARY), leaf('plugins')] } })),
    { ok: false, reason: 'bad-tree' },
    'sizes that do not match their children are not repaired',
  )
  assert.deepEqual(
    validateShape(shape({ tree: { type: 'split', dir: 'row', sizes: [1, 0], children: [leaf('chat', PRIMARY), leaf('plugins')] } })),
    { ok: false, reason: 'bad-sizes' },
    'a pane with no width is refused rather than drawn at zero',
  )
  assert.deepEqual(validateShape(null), { ok: false, reason: 'not-a-shape' })
})

test('the version is read, not ignored', () => {
  assert.deepEqual(validateShape(shape({ version: 2 })), { ok: false, reason: 'version' })
  assert.deepEqual(
    validateShape(shape({ version: '1' })),
    { ok: false, reason: 'version' },
    'a string version is not the number this build writes',
  )
  const noVersion = shape()
  delete noVersion.version
  assert.deepEqual(
    validateShape(noVersion),
    { ok: false, reason: 'version' },
    'a shape written before the field existed is set aside, not guessed at',
  )
  assert.equal(LAYOUT_VERSION, 1)
})

test('exactly one leaf is the primary', () => {
  const noPrimary = shape({
    tree: { type: 'split', dir: 'row', sizes: [0.5, 0.5], children: [leaf('chat'), leaf('plugins')] },
  })
  assert.deepEqual(validateShape(noPrimary), { ok: false, reason: 'primary' })
  const twoPrimaries = shape({
    tree: {
      type: 'split',
      dir: 'row',
      sizes: [0.5, 0.5],
      children: [leaf('chat', PRIMARY), leaf('plugins', PRIMARY)],
    },
  })
  assert.deepEqual(validateShape(twoPrimaries), { ok: false, reason: 'primary' })
})

test('sizes are scaled to one, so a hand-edited file cannot leave a sliver', () => {
  const checked = validateShape(
    shape({ tree: { type: 'split', dir: 'row', sizes: [2, 2], children: [leaf('chat', PRIMARY), leaf('plugins')] } }),
  )
  assert.equal(checked.ok, true)
  assert.deepEqual(checked.shape.tree.sizes, [0.5, 0.5])
})

test('what restoring builds, for two, three and four panes', () => {
  for (const panes of [2, 3, 4]) {
    const roles = Array.from({ length: panes }, (_, i) => (i === 0 ? 'chat' : i === 1 ? 'new' : 'chat'))
    const stored = shape({
      panes,
      tree: {
        type: 'split',
        dir: 'row',
        sizes: Array.from({ length: panes }, () => 1 / panes),
        children: roles.map((role, i) => leaf(role, i === 0 ? PRIMARY : {})),
      },
    })
    const restored = restoreShape(stored, { currentChat: 'chat-b' })
    assert.equal(restored.ok, true)
    assert.equal(paneCount(restored.layout), panes)
    const views = leaves(restored.layout.root).map((node) => node.view)
    assert.deepEqual(views[0], null, 'the primary keeps navigation')
    assert.equal(restored.primaryRole, 'chat-b', 'and the caller navigates it to the chat current now')
    assert.deepEqual(views.slice(1), roles.slice(1).map((role) => (role === 'chat' ? 'chat-b' : role)))
  }
})

test('a pane split to the left of the primary comes back in its place', () => {
  // The case the first round-trip tests missed: "Split left" puts a chat pane in
  // front of the primary, so the primary is the second leaf in reading order.
  const layout = splitLeaf(newLayout(), 'p1', 'row', 'chat-b', true)
  assert.deepEqual(
    leaves(layout.root).map((node) => node.view),
    ['chat-b', null],
  )

  const made = shapeOf(layout, { primaryView: 'chat-a', isChat })
  assert.deepEqual(
    made.tree.children.map((child) => [child.role, child.primary === true]),
    [
      ['chat', false],
      ['chat', true],
    ],
    'the second leaf is the primary, and the shape says so',
  )

  const restored = restoreShape(shape({ name: 'Left', panes: 2, tree: made.tree }), {
    currentChat: 'chat-c',
  })
  assert.equal(restored.ok, true)
  assert.deepEqual(
    leaves(restored.layout.root).map((node) => node.view),
    ['chat-c', null],
    'the chat pane is still on the left and the primary is still second',
  )
  assert.equal(restored.primaryRole, 'chat-c', 'and the primary navigates to the chat current now')
})

test('a static page saved as the primary comes back as the primary, not as a side pane', () => {
  const layout = splitLeaf(newLayout(), 'p1', 'row', 'chat-b', true)
  const made = shapeOf(layout, { primaryView: 'plugins', isChat })
  const restored = restoreShape(shape({ panes: 2, tree: made.tree }), { currentChat: 'chat-c' })
  assert.equal(restored.ok, true)
  assert.deepEqual(
    leaves(restored.layout.root).map((node) => node.view),
    ['chat-c', null],
    'the page is the primary (navigation shows it); the side pane is the chat',
  )
  assert.equal(restored.primaryRole, 'plugins')
})

test('a static page off the primary opens on New chat, because a pane cannot show it', () => {
  const stored = shape({
    panes: 2,
    tree: {
      type: 'split',
      dir: 'row',
      sizes: [0.5, 0.5],
      children: [leaf('plugins'), leaf('chat', PRIMARY)],
    },
  })
  const restored = restoreShape(stored, { currentChat: 'chat-a' })
  assert.equal(restored.ok, true)
  assert.deepEqual(
    leaves(restored.layout.root).map((node) => node.view),
    ['new', null],
    'the side pane degrades to the composer rather than to a page it cannot draw',
  )
  assert.equal(restored.primaryRole, 'chat-a')
})

test('nested trees come back nested, with their sizes', () => {
  const stored = shape({
    panes: 3,
    tree: {
      type: 'split',
      dir: 'row',
      sizes: [0.5, 0.5],
      children: [
        leaf('new', PRIMARY),
        {
          type: 'split',
          dir: 'col',
          sizes: [0.4, 0.6],
          children: [leaf('chat'), leaf('settings')],
        },
      ],
    },
  })
  const restored = restoreShape(stored, { currentChat: 'chat-a' })
  assert.equal(paneCount(restored.layout), 3)
  assert.equal(restored.layout.root.dir, 'row')
  const down = restored.layout.root.children[1]
  assert.equal(down.dir, 'col')
  assert.deepEqual(down.sizes, [0.4, 0.6])
  assert.equal(restored.primaryRole, 'new', 'the primary is the leaf the shape marked')
  assert.deepEqual(
    leaves(restored.layout.root).map((node) => node.view),
    [null, 'chat-a', 'new'],
    'and the settings leaf, off the primary, opens on New chat',
  )
})

test('a chat pane with no chat current opens the New chat composer', () => {
  const stored = shape({
    panes: 3,
    tree: {
      type: 'split',
      dir: 'row',
      sizes: [0.34, 0.33, 0.33],
      children: [leaf('chat', PRIMARY), leaf('chat'), leaf('plugins')],
    },
  })
  const restored = restoreShape(stored, { currentChat: null })
  assert.equal(restored.ok, true)
  assert.deepEqual(
    leaves(restored.layout.root).map((node) => node.view),
    [null, 'new', 'new'],
  )
  assert.equal(restored.primaryRole, 'new')
})

test('a window that cannot hold the panes refuses, and builds nothing', () => {
  const four = shape({
    panes: 4,
    tree: {
      type: 'split',
      dir: 'row',
      sizes: [0.25, 0.25, 0.25, 0.25],
      children: [leaf('chat', PRIMARY), leaf('new'), leaf('plugins'), leaf('settings')],
    },
  })
  const phone = restoreShape(four, { currentChat: 'chat-a', capacity: 1 })
  assert.deepEqual(phone, { ok: false, refusal: { code: 'capacity', panes: 4, capacity: 1 } })
  assert.equal(phone.layout, undefined, 'nothing half-applied')
  assert.equal(
    capacityLine(phone.refusal),
    'This window holds one pane, so a 4-pane layout cannot open here.',
  )
  assert.equal(restoreShape(four, { currentChat: 'chat-a', capacity: 2 }).ok, false)
  assert.equal(restoreShape(four, { currentChat: 'chat-a', capacity: MAX_PANES }).ok, true)
  assert.equal(capacityLine(null), '')
})

test('a stored list keeps what this build can use, newest first', () => {
  const store = new Map()
  globalThis.localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
    clear: () => store.clear(),
  }
  store.clear()
  const good = { ...shape(), id: 'a', saved_at: 200 }
  const olderBuild = { ...shape({ name: 'Old' }), id: 'b', saved_at: 300, version: 2 }
  const lostRole = {
    ...shape({ name: 'Lost' }),
    id: 'c',
    saved_at: 100,
    tree: {
      type: 'split',
      dir: 'row',
      sizes: [0.5, 0.5],
      children: [leaf('chat', PRIMARY), leaf('terminal')],
    },
  }
  saveLayouts([good, olderBuild, lostRole])
  assert.deepEqual(
    loadLayouts().map((entry) => entry.id),
    ['a'],
    'a shape from a build this one does not know is set aside, and so is the lost role',
  )
  store.set('openremote-pane-layouts', '{not json')
  assert.deepEqual(loadLayouts(), [], 'damage reads as none')
})

test('saving keeps the newest twenty, writes the version, and deleting takes one out', () => {
  let list = []
  for (let i = 1; i <= MAX_SAVED + 3; i += 1) {
    list = withLayout(list, { name: `layout ${i}`, panes: 2, tree: shape().tree }, { id: `id-${i}`, now: i })
  }
  assert.equal(list.length, MAX_SAVED)
  assert.equal(list[0].id, `id-${MAX_SAVED + 3}`, 'newest first')
  assert.equal(list[0].version, LAYOUT_VERSION, 'the version is written with the shape')
  assert.equal(list.some((entry) => entry.id === 'id-1'), false, 'the oldest fell off')
  assert.deepEqual(withoutLayout(list, `id-${MAX_SAVED + 3}`).map((e) => e.id)[0], `id-${MAX_SAVED + 2}`)
  assert.deepEqual(withoutLayout([], 'nope'), [])
  assert.equal(ROLES.includes('chat') && ROLES.includes('new') && ROLES.includes('plugins'), true, 'the role list is the app\'s views')
})

// ---- the pane header's menu ----

test('a pane count is said in panes, singular and plural', () => {
  assert.equal(paneCountLine(2), '2 panes')
  assert.equal(paneCountLine(3), '3 panes')
  assert.equal(paneCountLine(1), '1 pane')
  // Damage reads as nothing rather than "undefined panes".
  assert.equal(paneCountLine(undefined), '0 panes')
  assert.equal(paneCountLine(null), '0 panes')
})

test('the menu offers every saved layout, in the stored order, with its count', () => {
  const three = shapeOf(threeInARow(), { primaryView: 'chat-a', isChat })
  assert.equal(three.ok, true)
  const two = shape()
  const saved = [
    ...withLayout([], { name: 'Work', panes: three.panes, tree: three.tree }, { id: 'b', now: 2 }),
    ...withLayout([], { name: 'Review', panes: two.panes, tree: two.tree }, { id: 'a', now: 1 }),
  ]
  const offers = offerLayouts(saved, { currentChat: 'chat-a' })
  assert.deepEqual(offers.map((offer) => offer.id), ['b', 'a'], 'the stored order, newest first')
  assert.deepEqual(offers.map((offer) => offer.name), ['Work', 'Review'])
  assert.deepEqual(offers.map((offer) => offer.countLine), ['3 panes', '2 panes'])
  for (const offer of offers) {
    assert.equal(offer.ok, true)
    assert.equal(offer.note, null)
    // The plan is the restore rule's own answer, not a second one.
    const entry = saved.find((e) => e.id === offer.id)
    assert.deepEqual(offer.plan, restoreShape(entry, { currentChat: 'chat-a' }))
  }
  // The current chat is what a restored "chat" pane gets.
  assert.ok(JSON.stringify(offers[0].plan.layout).includes('chat-a'))
})

test('a layout that cannot fit stays in the menu, disabled, with the reason', () => {
  const three = shapeOf(threeInARow(), { primaryView: 'chat-a', isChat })
  const wide = withLayout([], { name: 'Wide', panes: three.panes, tree: three.tree }, { id: 'w', now: 3 })
  const phone = offerLayouts(wide, { capacity: 1 })
  assert.equal(phone.length, 1, 'it is offered, not hidden')
  assert.equal(phone[0].ok, false)
  assert.equal(phone[0].plan, null)
  assert.equal(phone[0].note, 'This window holds one pane, so a 3-pane layout cannot open here.')
  // A shape whose role this build no longer has gets the one plain sentence.
  const lost = [{ id: 'x', name: 'Old', panes: 2, version: LAYOUT_VERSION, tree: { type: 'leaf', role: 'terminal', primary: true } }]
  const offers = offerLayouts(lost, {})
  assert.equal(offers[0].ok, false)
  assert.equal(offers[0].note, UNOPENABLE_LINE)
})

test('an empty list offers nothing, and damage in it is skipped', () => {
  assert.deepEqual(offerLayouts([], {}), [])
  assert.deepEqual(offerLayouts(null, {}), [])
  assert.deepEqual(offerLayouts([null, undefined], {}), [])
})
