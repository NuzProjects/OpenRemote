import assert from 'node:assert/strict'
import test from 'node:test'

import { MAX_PANES, newLayout, leaves, paneCount, splitLeaf } from './split.js'
import {
  MAX_SAVED,
  MIN_PANES,
  ROLES,
  capacityLine,
  loadLayouts,
  restoreShape,
  saveLayouts,
  shapeOf,
  validateShape,
  withLayout,
  withoutLayout,
} from './layouts.js'

const isChat = (view) => view === 'chat-a' || view === 'chat-b'

// A window of three panes: the primary showing a chat, a New chat, and Plugins.
function threeInARow() {
  let layout = splitLeaf(newLayout(), 'p1', 'row', 'new')
  layout = splitLeaf(layout, layout.focus, 'row', 'plugins')
  return layout
}

test('a window becomes a shape of roles, never of chats', () => {
  const layout = threeInARow()
  const made = shapeOf(layout, { primaryView: 'chat-a', isChat })
  assert.equal(made.ok, true)
  assert.equal(made.panes, 3)
  assert.deepEqual(
    made.tree.children.map((child) => child.role),
    ['chat', 'new', 'plugins'],
    'the primary takes the role of what is on screen, the rest their own views',
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
})

test('one pane is not a shape, and an unknown view cannot be stored', () => {
  assert.deepEqual(shapeOf(newLayout(), { primaryView: 'chat-a', isChat }), {
    ok: false,
    reason: 'too-few-panes',
  })
  assert.equal(MIN_PANES, 2)
  const odd = splitLeaf(newLayout(), 'p1', 'row', 'terminal')
  assert.deepEqual(shapeOf(odd, { primaryView: 'new', isChat }), { ok: false, reason: 'unknown-view' })
})

const shape = (extra = {}) => ({
  name: 'Review',
  version: 1,
  panes: 2,
  tree: {
    type: 'split',
    dir: 'row',
    sizes: [0.5, 0.5],
    children: [
      { type: 'leaf', role: 'chat' },
      { type: 'leaf', role: 'plugins' },
    ],
  },
  ...extra,
})

test('a stored shape is checked, and one this build cannot use is refused', () => {
  const good = validateShape(shape())
  assert.equal(good.ok, true)
  assert.equal(good.shape.name, 'Review')
  assert.equal(good.shape.panes, 2)

  const older = validateShape(shape({ tree: { type: 'split', dir: 'row', sizes: [0.5, 0.5], children: [{ type: 'leaf', role: 'chat' }, { type: 'leaf', role: 'terminal' }] } }))
  assert.deepEqual(older, { ok: false, reason: 'unknown-role' }, 'a role this build lost is refused, not guessed')

  assert.deepEqual(validateShape(shape({ name: '   ' })), { ok: false, reason: 'no-name' })
  assert.deepEqual(validateShape(shape({ panes: 5 })), { ok: false, reason: 'pane-count' })
  assert.deepEqual(validateShape(shape({ panes: 1 })), { ok: false, reason: 'pane-count' })
  assert.deepEqual(
    validateShape(shape({ tree: { type: 'split', dir: 'row', sizes: [0.5], children: [{ type: 'leaf', role: 'chat' }, { type: 'leaf', role: 'plugins' }] } })),
    { ok: false, reason: 'bad-tree' },
    'sizes that do not match their children are not repaired',
  )
  assert.deepEqual(
    validateShape(shape({ tree: { type: 'split', dir: 'row', sizes: [1, 0], children: [{ type: 'leaf', role: 'chat' }, { type: 'leaf', role: 'plugins' }] } })),
    { ok: false, reason: 'bad-sizes' },
    'a pane with no width is refused rather than drawn at zero',
  )
  assert.deepEqual(validateShape(null), { ok: false, reason: 'not-a-shape' })
})

test('sizes are scaled to one, so a hand-edited file cannot leave a sliver', () => {
  const checked = validateShape(
    shape({ tree: { type: 'split', dir: 'row', sizes: [2, 2], children: [{ type: 'leaf', role: 'chat' }, { type: 'leaf', role: 'plugins' }] } }),
  )
  assert.equal(checked.ok, true)
  assert.deepEqual(checked.shape.tree.sizes, [0.5, 0.5])
})

test('what restoring builds, for two, three and four panes', () => {
  for (const panes of [2, 3, 4]) {
    const roles = Array.from({ length: panes }, (_, i) => (i === 0 ? 'chat' : i === 1 ? 'new' : 'plugins'))
    const stored = shape({
      panes,
      tree: {
        type: 'split',
        dir: 'row',
        sizes: Array.from({ length: panes }, () => 1 / panes),
        children: roles.map((role) => ({ type: 'leaf', role })),
      },
    })
    const restored = restoreShape(stored, { currentChat: 'chat-b' })
    assert.equal(restored.ok, true)
    assert.equal(paneCount(restored.layout), panes)
    const views = leaves(restored.layout.root).map((leaf) => leaf.view)
    assert.deepEqual(views[0], null, 'the primary keeps navigation')
    assert.equal(restored.primaryRole, 'chat-b', 'and the caller navigates it to the chat current now')
    assert.deepEqual(views.slice(1), roles.slice(1).map((role) => (role === 'chat' ? 'chat-b' : role)))
  }
})

test('nested trees come back nested, with their sizes', () => {
  const stored = shape({
    panes: 3,
    tree: {
      type: 'split',
      dir: 'row',
      sizes: [0.5, 0.5],
      children: [
        { type: 'leaf', role: 'new' },
        {
          type: 'split',
          dir: 'col',
          sizes: [0.4, 0.6],
          children: [
            { type: 'leaf', role: 'chat' },
            { type: 'leaf', role: 'settings' },
          ],
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
  assert.equal(restored.primaryRole, 'new', 'the first pane in reading order is the primary')
})

test('a chat pane with no chat current opens the New chat composer', () => {
  const restored = restoreShape(shape({ panes: 3, tree: { type: 'split', dir: 'row', sizes: [0.34, 0.33, 0.33], children: [{ type: 'leaf', role: 'chat' }, { type: 'leaf', role: 'chat' }, { type: 'leaf', role: 'plugins' }] } }), {
    currentChat: null,
  })
  assert.equal(restored.ok, true)
  assert.deepEqual(
    leaves(restored.layout.root).map((leaf) => leaf.view),
    [null, 'new', 'plugins'],
  )
  assert.equal(restored.primaryRole, 'new')
})

test('a window that cannot hold the panes refuses, and builds nothing', () => {
  const four = shape({ panes: 4, tree: { type: 'split', dir: 'row', sizes: [0.25, 0.25, 0.25, 0.25], children: [{ type: 'leaf', role: 'chat' }, { type: 'leaf', role: 'new' }, { type: 'leaf', role: 'plugins' }, { type: 'leaf', role: 'settings' }] } })
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
  const olderBuild = { ...shape({ name: 'Old' }), id: 'b', saved_at: 300, tree: { type: 'split', dir: 'row', sizes: [0.5, 0.5], children: [{ type: 'leaf', role: 'chat' }, { type: 'leaf', role: 'terminal' }] } }
  saveLayouts([good, olderBuild])
  assert.deepEqual(loadLayouts().map((entry) => entry.id), ['a'], 'the one whose role is gone is dropped')
  store.set('openremote-pane-layouts', '{not json')
  assert.deepEqual(loadLayouts(), [], 'damage reads as none')
})

test('saving keeps the newest twenty and deleting takes one out', () => {
  let list = []
  for (let i = 1; i <= MAX_SAVED + 3; i += 1) {
    list = withLayout(list, { name: `layout ${i}`, panes: 2, tree: shape().tree }, { id: `id-${i}`, now: i })
  }
  assert.equal(list.length, MAX_SAVED)
  assert.equal(list[0].id, `id-${MAX_SAVED + 3}`, 'newest first')
  assert.equal(list.some((entry) => entry.id === 'id-1'), false, 'the oldest fell off')
  assert.deepEqual(withoutLayout(list, `id-${MAX_SAVED + 3}`).map((e) => e.id)[0], `id-${MAX_SAVED + 2}`)
  assert.deepEqual(withoutLayout([], 'nope'), [])
  assert.equal(ROLES.includes('chat') && ROLES.includes('new') && ROLES.includes('plugins'), true, 'the role list is the app\'s views')
})
