// Named pane layouts: the shape of the window, saved and put back.
//
// A saved layout stores the split tree with its sizes and, per pane, a ROLE and
// never a chat id. A chat is gone tomorrow - renamed, deleted, or simply not the
// one you want now - so a layout that remembered one would restore a window
// pointing at a hole. Roles are: "chat" (whichever chat is current), "new" (a
// New chat composer), and the console's static views by name. What is where
// survives a restart; what it held does not need to.
//
// The rules are pure and live here: how a window becomes a shape, how a stored
// shape is validated (an older build may have saved a role this build no longer
// has), what restoring produces, and every refusal.

import { MAX_PANES, leaves, paneCount } from './split.js'

// The stored list's own key, like the archive's: a console preference that
// never travels to another device.
export const LAYOUTS_KEY = 'openremote-pane-layouts'
export const LAYOUT_VERSION = 1
// A layout of one pane is not a shape: it is the window.
export const MIN_PANES = 2
// Enough for a working set, few enough that the page stays a list.
export const MAX_SAVED = 20
export const NAME_CAP = 60

// Every role a pane can hold. "chat" stands for whichever chat is current; the
// rest are the console's own views, by the names its router uses.
export const ROLES = [
  'chat',
  'new',
  'plugins',
  'automations',
  'machines',
  'settings',
  'account',
  'mobile',
  'metrics',
]

const isSplit = (node) => node?.type === 'split'
const isLeaf = (node) => node?.type === 'leaf'

/**
 * The window as a shape: pane count, the tree with its sizes, and each pane's
 * role.
 *
 * A pane whose view is null is the primary, and what it shows is the console's
 * navigation rather than a leaf field, so its role comes from `primaryView` -
 * the view on screen right now. WHICH leaf that is gets recorded (`primary:
 * true`), because the primary is not always the first pane in reading order:
 * "Split left" and "Split up" put a pane in front of it, and a shape that
 * assumed reading order would come back with every role shifted by one.
 *
 * A view that is neither the current chat, the New chat composer, nor one of
 * the console's static views cannot be stored: an unknown view has no role to
 * restore. A static page off the primary cannot be stored either - the shell
 * renders only the primary, New chat and chats in a pane, so saving a page in
 * a side pane would save a window that cannot come back as it was.
 */
export function shapeOf(layout, { primaryView = null, isChat = () => false } = {}) {
  if (!layout?.root) return { ok: false, reason: 'no-layout' }
  const panes = paneCount(layout)
  if (panes < MIN_PANES) return { ok: false, reason: 'too-few-panes' }
  if (panes > MAX_PANES) return { ok: false, reason: 'too-many-panes' }
  let refusal = null
  let primaries = 0
  const roleFor = (view) => {
    if (isChat(view)) return 'chat'
    if (ROLES.includes(view)) return view
    return null
  }
  const walk = (node) => {
    if (isLeaf(node)) {
      const primary = node.view === null
      if (primary) primaries += 1
      const view = primary ? primaryView : node.view
      const role = roleFor(view)
      if (role === null) {
        refusal ??= 'unknown-view'
        return null
      }
      if (!primary && role !== 'chat' && role !== 'new') {
        refusal ??= 'static-in-pane'
        return null
      }
      return { type: 'leaf', role, ...(primary ? { primary: true } : {}) }
    }
    if (!isSplit(node)) {
      refusal ??= 'bad-tree'
      return null
    }
    const children = node.children.map(walk)
    if (children.some((child) => child === null)) return null
    return { type: 'split', dir: node.dir, sizes: [...(node.sizes ?? [])], children }
  }
  const tree = walk(layout.root)
  if (refusal || tree === null) return { ok: false, reason: refusal ?? 'bad-tree' }
  if (primaries !== 1) return { ok: false, reason: 'primary' }
  return { ok: true, panes, tree }
}

/**
 * A stored shape, checked and normalised, or the reason it cannot be used.
 *
 * An older build can have saved a role this build no longer has, a tree whose
 * sizes do not add up, or a pane count that disagrees with its own leaves. All
 * of those are refused rather than repaired into something the user never saw.
 * Sizes are scaled to sum to one so a hand-edited or hand-rolled file cannot
 * leave a pane with no width.
 *
 * The stored `version` is read, not ignored: a shape this build does not know
 * is set aside even when its structure happens to validate, because "the fields
 * line up" is not the same promise as "the meaning is unchanged". A shape
 * written before the field existed has no version and is set aside the same
 * way. Exactly one leaf must be the primary.
 */
export function validateShape(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, reason: 'not-a-shape' }
  if (raw.version !== LAYOUT_VERSION) return { ok: false, reason: 'version' }
  const name = String(raw.name ?? '').trim()
  if (!name) return { ok: false, reason: 'no-name' }
  const panes = raw.panes
  if (!Number.isInteger(panes) || panes < MIN_PANES || panes > MAX_PANES) {
    return { ok: false, reason: 'pane-count' }
  }
  let leafCount = 0
  let primaries = 0
  let refusal = null
  const walk = (node) => {
    if (isLeaf(node)) {
      if (!ROLES.includes(node.role)) {
        refusal ??= 'unknown-role'
        return null
      }
      const primary = node.primary === true
      if (primary) primaries += 1
      leafCount += 1
      return { type: 'leaf', role: node.role, ...(primary ? { primary: true } : {}) }
    }
    if (!isSplit(node)) {
      refusal ??= 'bad-tree'
      return null
    }
    if (node.dir !== 'row' && node.dir !== 'col') {
      refusal ??= 'bad-tree'
      return null
    }
    const children = Array.isArray(node.children) ? node.children : null
    const sizes = Array.isArray(node.sizes) ? node.sizes : null
    if (!children || !sizes || children.length < 2 || sizes.length !== children.length) {
      refusal ??= 'bad-tree'
      return null
    }
    if (sizes.some((size) => typeof size !== 'number' || !Number.isFinite(size) || size <= 0)) {
      refusal ??= 'bad-sizes'
      return null
    }
    const built = children.map(walk)
    if (built.some((child) => child === null)) return null
    const total = sizes.reduce((sum, size) => sum + size, 0)
    return { type: 'split', dir: node.dir, sizes: sizes.map((size) => size / total), children: built }
  }
  const tree = walk(raw.tree)
  if (refusal || tree === null) return { ok: false, reason: refusal ?? 'bad-tree' }
  if (leafCount !== panes) return { ok: false, reason: 'pane-count' }
  if (primaries !== 1) return { ok: false, reason: 'primary' }
  return {
    ok: true,
    shape: {
      id: typeof raw.id === 'string' && raw.id ? raw.id : null,
      name: name.slice(0, NAME_CAP),
      version: LAYOUT_VERSION,
      panes,
      tree,
      saved_at: typeof raw.saved_at === 'number' && Number.isFinite(raw.saved_at) ? raw.saved_at : 0,
    },
  }
}

/** The stored shapes that this build can still use, newest first. */
export function loadLayouts() {
  try {
    const raw = JSON.parse(localStorage.getItem(LAYOUTS_KEY) ?? '[]')
    if (!Array.isArray(raw)) return []
    return raw
      .map((entry) => validateShape(entry))
      .filter((checked) => checked.ok)
      .map((checked) => checked.shape)
      .sort((a, b) => b.saved_at - a.saved_at)
      .slice(0, MAX_SAVED)
  } catch {
    return []
  }
}

/** Store the list; a console preference, so damage or a full disk is quiet. */
export function saveLayouts(list) {
  try {
    localStorage.setItem(LAYOUTS_KEY, JSON.stringify(list ?? []))
  } catch {
    /* storage unavailable */
  }
}

/**
 * One more saved shape, newest first. A shape is named by the person, and two
 * layouts can share a name - the list is the record, not the name - so the id
 * is what identifies one.
 */
export function withLayout(list, entry, { id, now = 0 } = {}) {
  const kept = (list ?? []).filter(Boolean)
  const made = {
    id: id ?? `layout-${now}-${kept.length}`,
    name: String(entry?.name ?? '').trim().slice(0, NAME_CAP),
    version: LAYOUT_VERSION,
    panes: entry?.panes,
    tree: entry?.tree,
    saved_at: now,
  }
  return [made, ...kept].slice(0, MAX_SAVED)
}

/** The list without one shape. */
export function withoutLayout(list, id) {
  return (list ?? []).filter((entry) => entry?.id !== id)
}

/**
 * The window a saved shape becomes.
 *
 * The leaf the shape marks as primary keeps the null view, because the console's
 * navigation owns that pane rather than a leaf field, and its content comes from
 * the caller navigating to the returned `primaryRole`. It is placed where the
 * shape says it was, not where reading order puts it: "Split left" and "Split
 * up" leave a pane in front of the primary, and assuming the first leaf would
 * hand every role to the wrong pane.
 *
 * Every other pane takes its role: "chat" is the chat current now (the caller
 * passes it), "new" is the New chat composer. A static page off the primary
 * opens on New chat instead: the shell renders only the primary, New chat and
 * chats in a pane, so a page there would draw "That chat is no longer in this
 * workspace." rather than itself, and a pane must not be handed a page it cannot
 * show. With no chat current, a chat pane opens the New chat composer too - a
 * pane is never left blank.
 *
 * A window that cannot hold the shape's panes is refused before anything is
 * built, so a phone never half-applies a four-pane layout.
 */
export function restoreShape(shape, { currentChat = null, capacity = MAX_PANES } = {}) {
  const checked = validateShape(shape)
  if (!checked.ok) return { ok: false, refusal: { code: checked.reason } }
  const saved = checked.shape
  const room = Number.isInteger(capacity) ? capacity : MAX_PANES
  if (saved.panes > room) {
    return { ok: false, refusal: { code: 'capacity', panes: saved.panes, capacity: room } }
  }
  const viewFor = (role) => {
    if (role === 'chat') return currentChat ?? 'new'
    return role
  }
  // Only the primary can show a static page; everywhere else the safe answer is
  // the composer, which every pane can render.
  const viewForPane = (role) => (role === 'chat' || role === 'new' ? viewFor(role) : 'new')
  let seq = 0
  const build = (node) => {
    if (isLeaf(node)) {
      const id = `p${(seq += 1)}`
      return { type: 'leaf', id, view: null }
    }
    const children = node.children.map(build)
    const id = `s${(seq += 1)}`
    return { type: 'split', id, dir: node.dir, sizes: [...node.sizes], children }
  }
  const root = build(saved.tree)
  const ordered = leaves(root)
  const savedLeaves = []
  const collect = (node) => {
    if (isLeaf(node)) savedLeaves.push({ role: node.role, primary: node.primary === true })
    else node.children.forEach(collect)
  }
  collect(saved.tree)
  const primaryAt = savedLeaves.findIndex((leaf) => leaf.primary)
  // validateShape guarantees exactly one primary, so this is never -1; the guard
  // is here so a future change to validation cannot index a missing leaf.
  if (primaryAt < 0) return { ok: false, refusal: { code: 'primary' } }
  ordered.forEach((leaf, index) => {
    if (index === primaryAt) return
    leaf.view = viewForPane(savedLeaves[index].role)
  })
  return {
    ok: true,
    primaryRole: viewFor(savedLeaves[primaryAt].role),
    layout: { root, focus: ordered[primaryAt].id, seq },
  }
}

/** "This window holds one pane, so a 4-pane layout cannot open here." */
export function capacityLine(refusal) {
  if (refusal?.code !== 'capacity') return ''
  const holds = refusal.capacity === 1 ? 'one pane' : `${refusal.capacity} panes`
  return `This window holds ${holds}, so a ${refusal.panes}-pane layout cannot open here.`
}
