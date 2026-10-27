// Split panes: several chats side by side in one window, Local and Cloud
// alike. A pure layout tree, kept free of React so it is tested directly.
//
// The tree's leaves are panes. Exactly one leaf is the primary pane - its
// `view` is null and it shows whatever the app's own navigation (history,
// back and forward) points at. Every other leaf holds its own view: a chat
// id, or 'new' for a fresh composer. The primary pane can never be closed,
// so a window always has somewhere to navigate.

export const MAX_PANES = 4
const MIN_SIZE = 0.15

export function newLayout() {
  return { root: { type: 'leaf', id: 'p1', view: null }, focus: 'p1', seq: 1 }
}

/** The panes, left to right and top to bottom. */
export function leaves(node) {
  return node.type === 'leaf' ? [node] : node.children.flatMap(leaves)
}

export function leafById(layout, id) {
  return leaves(layout.root).find((l) => l.id === id) ?? null
}

export function paneCount(layout) {
  return leaves(layout.root).length
}

function mapNode(node, fn) {
  const next = fn(node)
  if (next !== node) return next
  if (node.type !== 'split') return node
  const children = node.children.map((c) => mapNode(c, fn))
  return children.some((c, i) => c !== node.children[i]) ? { ...node, children } : node
}

/**
 * Split a pane: the new pane opens beside it ('row') or below it ('col')
 * showing `view`, and takes focus. With `before` it opens on the other
 * side - to the left or above. A pane already inside a split of the same
 * direction just gains a sibling, so repeated splits stay one flat row
 * instead of nesting. At MAX_PANES nothing happens.
 */
export function splitLeaf(layout, leafId, dir, view = 'new', before = false) {
  if (paneCount(layout) >= MAX_PANES || !leafById(layout, leafId)) return layout
  const seq = layout.seq + 1
  const fresh = { type: 'leaf', id: `p${seq}`, view }
  const root = mapNode(layout.root, (node) => {
    if (node.type === 'leaf' && node.id === leafId) {
      return { type: 'split', id: `s${seq}`, dir, children: before ? [fresh, node] : [node, fresh], sizes: [0.5, 0.5] }
    }
    if (node.type === 'split' && node.dir === dir) {
      const at = node.children.findIndex((c) => c.type === 'leaf' && c.id === leafId)
      if (at === -1) return node
      // The new sibling takes half of the pane it was split from.
      const half = node.sizes[at] / 2
      const children = [...node.children]
      const sizes = [...node.sizes]
      children.splice(before ? at : at + 1, 0, fresh)
      sizes.splice(at, 1, half, half)
      return { ...node, children, sizes }
    }
    return node
  })
  return { ...layout, root, focus: fresh.id, seq }
}

/**
 * Close a pane. The primary pane stays. Its space goes to its neighbours,
 * a split left with one child dissolves into it, and focus moves to a pane
 * beside the one that closed when it had focus.
 */
export function closeLeaf(layout, leafId) {
  const target = leafById(layout, leafId)
  if (!target || target.view === null) return layout
  const order = leaves(layout.root)
  const at = order.findIndex((l) => l.id === leafId)
  const root = prune(layout.root, leafId)
  const remaining = leaves(root)
  const focus =
    layout.focus === leafId ? (order[at - 1] ?? order[at + 1]).id : layout.focus
  return { ...layout, root, focus: remaining.some((l) => l.id === focus) ? focus : remaining[0].id }
}

function prune(node, leafId) {
  if (node.type === 'leaf') return node
  const at = node.children.findIndex((c) => c.type === 'leaf' && c.id === leafId)
  if (at !== -1) {
    const children = node.children.filter((_, i) => i !== at)
    const freed = node.sizes[at]
    const sizes = node.sizes.filter((_, i) => i !== at).map((s) => s + freed / children.length)
    return children.length === 1 ? children[0] : { ...node, children, sizes }
  }
  const children = node.children.map((c) => prune(c, leafId))
  return { ...node, children }
}

export function setLeafView(layout, leafId, view) {
  const root = mapNode(layout.root, (node) =>
    node.type === 'leaf' && node.id === leafId && node.view !== null && node.view !== view
      ? { ...node, view }
      : node,
  )
  return root === layout.root ? layout : { ...layout, root }
}

/// Move a chat from the pane that shows it into another pane on `dir` and
/// `before`. `sourceId` is null when the chat came from the sidebar and no
/// pane holds it, which is an open-beside and not a move. The source pane
/// becomes a New chat, so the chat never streams in two panes with two
/// drafts. A drop on the pane the chat already lives in is not a move.
export function moveLeaf(layout, sourceId, targetId, dir, before, view) {
  if (sourceId === targetId) return layout
  const split = splitLeaf(layout, targetId, dir, view, before)
  return sourceId ? setLeafView(split, sourceId, 'new') : split
}

/// Repair the panes whose view no longer means anything: a chat this console
/// knows is gone (deleted here or on another device), or a view a pane can
/// never hold (a static page restored from an older build). The pane becomes
/// a New chat composer in place, so the arrangement is kept and no pane points
/// at nothing. The primary is left alone: its view is the app's navigation,
/// and setLeafView refuses an empty leaf, which is the same line.
export function reconcilePanes(layout, stale) {
  if (!stale || stale.size === 0) return layout
  let next = layout
  for (const leaf of leaves(layout.root)) {
    if (leaf.view !== null && stale.has(leaf.view)) next = setLeafView(next, leaf.id, 'new')
  }
  return next
}

export function focusLeaf(layout, leafId) {
  return layout.focus === leafId || !leafById(layout, leafId) ? layout : { ...layout, focus: leafId }
}

/** Focus the nth pane, left to right and top to bottom. */
export function focusByIndex(layout, index) {
  const leaf = leaves(layout.root)[index]
  return leaf ? focusLeaf(layout, leaf.id) : layout
}

/**
 * Where a dropped chat lands in a pane: the middle keeps it in that pane,
 * the outer band of each side splits the pane on that side. The nearest
 * edge wins, so a corner resolves to whichever side is closer. `band` is
 * a fraction of the pane's width or height - wide enough to hit on
 * purpose, narrow enough that the middle stays a real target.
 */
export const DROP_BAND = 0.28

/**
 * Whether a drag in progress carries a chat. The payload itself is only
 * readable on drop, but the drag's own types are readable throughout, so this
 * is the question the hover path can ask: without it a file or a paragraph
 * tints a pane and then does nothing when it lands.
 */
export function acceptsChatDrop(types) {
  if (!types) return false
  return Array.from(types).includes('text/plain')
}

/**
 * The zone the pane should tint while a chat hovers. Where no split can
 * happen (the pane cap, or a phone, which has no panes) the drop opens in the
 * pane it landed on, so the tint says "here", not "this half": the screen
 * must not promise an action the release will not perform.
 */
export function tintZone(canSplit, box, x, y) {
  return canSplit ? dropZone(box, x, y) : { zone: 'center' }
}

export function dropZone(box, x, y) {
  const edges = [
    { zone: 'left', dir: 'row', before: true, at: (x - box.left) / box.width },
    { zone: 'right', dir: 'row', before: false, at: (box.right - x) / box.width },
    { zone: 'top', dir: 'col', before: true, at: (y - box.top) / box.height },
    { zone: 'bottom', dir: 'col', before: false, at: (box.bottom - y) / box.height },
  ]
  const nearest = edges.reduce((a, b) => (b.at < a.at ? b : a))
  if (nearest.at > DROP_BAND) return { zone: 'center' }
  return { zone: nearest.zone, dir: nearest.dir, before: nearest.before }
}

/** Even out a split's children - a double-click on its divider. */
export function balanceSplit(layout, splitId) {
  const root = mapNode(layout.root, (node) => {
    if (node.type !== 'split' || node.id !== splitId) return node
    const even = 1 / node.children.length
    return { ...node, sizes: node.children.map(() => even) }
  })
  return root === layout.root ? layout : { ...layout, root }
}

/**
 * The sizes after moving the divider after `index` by `delta` (a fraction of
 * the split's whole size). Neither neighbour shrinks below MIN_SIZE. Kept
 * apart from the layout walk so a drag can paint from exactly the numbers it
 * will later commit.
 */
export function movedSizes(sizes, index, delta) {
  const a = sizes?.[index]
  const b = sizes?.[index + 1]
  if (a === undefined || b === undefined) return sizes
  const moved = Math.max(MIN_SIZE - a, Math.min(b - MIN_SIZE, delta))
  const next = [...sizes]
  next[index] = a + moved
  next[index + 1] = b - moved
  return next
}

/**
 * Move the divider after child `index` of a split by `delta` (a fraction of
 * the split's whole size). Neither neighbour shrinks below MIN_SIZE.
 */
export function resizeSplit(layout, splitId, index, delta) {
  const root = mapNode(layout.root, (node) => {
    if (node.type !== 'split' || node.id !== splitId) return node
    const sizes = movedSizes(node.sizes, index, delta)
    return sizes === node.sizes ? node : { ...node, sizes }
  })
  return root === layout.root ? layout : { ...layout, root }
}

/**
 * One divider drag, driven by pointer positions on one axis. `move` returns
 * the sizes to paint and never commits anything; `release` returns the delta
 * to commit, or 0 when the pointer did not move (a double-click on the strip
 * starts a drag that goes nowhere, and that must not spend a layout commit).
 *
 * The controller exists so the rule is testable without a DOM: a drag paints
 * on every move and hands React one state change, at the end. Committing on
 * every move re-rendered every pane, transcripts included, at pointer rate.
 */
export function createDividerDrag({ sizes, index, total, start }) {
  const base = sizes ?? []
  let delta = 0
  if (!(total > 0)) {
    return {
      move: () => ({ sizes: base, delta: 0 }),
      release: () => 0,
    }
  }
  return {
    move(at) {
      delta = (at - start) / total
      return { sizes: movedSizes(base, index, delta), delta }
    },
    release() {
      return delta
    },
  }
}

/** The chat ids showing in secondary panes (the primary's come from navigation). */
export function secondaryChatIds(layout, isChatView) {
  return leaves(layout.root)
    .filter((l) => l.view !== null && isChatView(l.view))
    .map((l) => l.view)
}

/**
 * A stored layout, trusted only when it is well formed: one primary pane,
 * unique ids, sizes that add up. Anything else is a fresh single pane.
 */
export function restoreLayout(raw) {
  try {
    if (!valid(raw)) return newLayout()
    return raw
  } catch {
    return newLayout()
  }
}

function valid(layout) {
  if (!layout || typeof layout !== 'object' || typeof layout.seq !== 'number') return false
  const all = []
  const check = (node) => {
    if (!node || typeof node.id !== 'string') return false
    all.push(node)
    if (node.type === 'leaf') return node.view === null || typeof node.view === 'string'
    if (node.type !== 'split' || (node.dir !== 'row' && node.dir !== 'col')) return false
    if (!Array.isArray(node.children) || node.children.length < 2) return false
    if (!Array.isArray(node.sizes) || node.sizes.length !== node.children.length) return false
    if (node.sizes.some((s) => typeof s !== 'number' || !(s > 0))) return false
    if (Math.abs(node.sizes.reduce((a, b) => a + b, 0) - 1) > 0.001) return false
    return node.children.every(check)
  }
  if (!check(layout.root)) return false
  if (new Set(all.map((n) => n.id)).size !== all.length) return false
  const panes = all.filter((n) => n.type === 'leaf')
  return (
    panes.length <= MAX_PANES &&
    panes.filter((l) => l.view === null).length === 1 &&
    panes.some((l) => l.id === layout.focus)
  )
}

/**
 * A dragged chat travels as text/plain with this prefix: every drag source
 * (a sidebar row, a pane's own title) writes it, and a drop only acts on a
 * payload that carries it, so a stray file or text drop is ignored.
 */
export const CHAT_DRAG = 'openremote-chat:'

export function chatDragPayload(id) {
  return CHAT_DRAG + id
}

export function draggedChat(dataTransfer) {
  const raw = dataTransfer?.getData('text/plain') ?? ''
  return raw.startsWith(CHAT_DRAG) ? raw.slice(CHAT_DRAG.length) : ''
}
