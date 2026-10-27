// The dialog rules that make "modal" true: the Tab loop, what counts as a
// stop, and the inert pass that takes the rest of the app out of reach. These
// are pure rules over a small fake tree, so the behaviour is checked without a
// browser; the wiring test next door pins that every modal uses them.

import assert from 'node:assert/strict'
import test from 'node:test'
import { captureOpener, focusables, focusOpener, inertOthers, tabTarget } from './dialog-focus.js'

test('Tab wraps at both ends and leaves the middle to the browser', () => {
  // Three stops, focus on the first: Shift+Tab wraps to the last.
  assert.equal(tabTarget(3, 0, true), 2)
  // ... and Tab from the last wraps to the first.
  assert.equal(tabTarget(3, 2, false), 0)
  // The middle is the browser's own move: no preventDefault, no jump.
  assert.equal(tabTarget(3, 1, false), null)
  assert.equal(tabTarget(3, 1, true), null)
  // Focus outside the dialog (the panel itself): enter at the near end.
  assert.equal(tabTarget(3, -1, false), 0)
  assert.equal(tabTarget(3, -1, true), 2)
  // A dialog with nothing to focus has no loop to run.
  assert.equal(tabTarget(0, -1, false), null)
})

test('focusables lists what the browser can reach and skips hidden and inert', () => {
  const visible = { hasAttribute: () => false, getClientRects: () => [{ width: 10 }] }
  const disabled = { hasAttribute: (a) => a === 'inert', getClientRects: () => [{ width: 10 }] }
  const hidden = { hasAttribute: () => false, getClientRects: () => [] }
  const root = { querySelectorAll: () => [visible, disabled, hidden] }
  assert.deepEqual(focusables(root), [visible])
  assert.deepEqual(focusables(null), [])
})

// A tree just big enough for the walk: body > app-frame > (sidebar, main),
// main > backdrop > panel. No DOM library for one rule.
function tree() {
  const node = (name, children = []) => {
    const el = {
      name,
      attrs: new Set(),
      children: [],
      parentElement: null,
      hasAttribute: (a) => el.attrs.has(a),
      setAttribute: (a) => el.attrs.add(a),
      removeAttribute: (a) => el.attrs.delete(a),
    }
    for (const child of children) {
      child.parentElement = el
      el.children.push(child)
    }
    return el
  }
  const panel = node('panel')
  const backdrop = node('backdrop', [panel])
  const sidebar = node('sidebar')
  const main = node('main', [backdrop])
  const frame = node('frame', [sidebar, main])
  const body = node('body', [frame])
  const doc = { body }
  for (const el of [panel, backdrop, sidebar, main, frame, body]) el.ownerDocument = doc
  return { panel, sidebar, main, frame, body, doc }
}

test('inert takes the rest of the app out of reach, and the undo puts it back', () => {
  const { panel, sidebar, main, frame, body, doc } = tree()
  const restore = inertOthers(panel, doc)
  assert.equal(sidebar.hasAttribute('inert'), true, 'the sidebar is out of reach')
  assert.equal(panel.hasAttribute('inert'), false, 'the dialog itself is not')
  assert.equal(main.hasAttribute('inert'), false, 'the dialog\'s own branch stays live')
  assert.equal(frame.hasAttribute('inert'), false, 'nor the branch it sits in')
  assert.equal(body.hasAttribute('inert'), false, 'and the body is never marked')
  restore()
  assert.equal(sidebar.hasAttribute('inert'), false, 'closing puts the app back')
  assert.equal(frame.hasAttribute('inert'), false)
})

test('a nested dialog hides the panel under it and gives back only what it took', () => {
  // A confirm rendered inside the same backdrop as the panel it sits over.
  const { panel, sidebar, doc } = tree()
  const outerRestore = inertOthers(panel, doc)
  const confirm = { attrs: new Set(), children: [], parentElement: panel.parentElement }
  confirm.hasAttribute = (a) => confirm.attrs.has(a)
  confirm.setAttribute = (a) => confirm.attrs.add(a)
  confirm.removeAttribute = (a) => confirm.attrs.delete(a)
  confirm.ownerDocument = doc
  panel.parentElement.children.push(confirm)

  const innerRestore = inertOthers(confirm, doc)
  assert.equal(panel.hasAttribute('inert'), true, 'the dialog under the confirm is inert')
  assert.equal(sidebar.hasAttribute('inert'), true, 'and so is the rest of the app')

  innerRestore()
  assert.equal(panel.hasAttribute('inert'), false, 'closing the confirm frees the dialog under it')
  assert.equal(sidebar.hasAttribute('inert'), true, 'the outer dialog still owns the app')

  outerRestore()
  assert.equal(sidebar.hasAttribute('inert'), false)
})

test('the window controls stay live while a dialog owns the app', () => {
  // The titlebar is a sibling of the app body and carries minimize, maximize
  // and close. A modal must never be able to take the window's own controls
  // away, so the walk steps over it and marks everything else.
  const { panel, sidebar, doc } = tree()
  const titlebar = {
    attrs: new Set(),
    hasAttribute(a) {
      return this.attrs.has(a)
    },
    matches: (sel) => sel === '.titlebar',
  }
  doc.body.children[0].children.push(titlebar)
  titlebar.parentElement = doc.body.children[0]
  const restore = inertOthers(panel, doc)
  assert.equal(titlebar.hasAttribute('inert'), false, 'the caption buttons keep working')
  assert.equal(sidebar.hasAttribute('inert'), true, 'the app does not')
  restore()
})

test('an element already inert before the dialog opened stays inert after', () => {
  const { panel, sidebar, doc } = tree()
  sidebar.setAttribute('inert')
  const restore = inertOthers(panel, doc)
  restore()
  assert.equal(sidebar.hasAttribute('inert'), true, 'the undo does not lift someone else\'s mark')
})

// ---- where focus goes back to ----
//
// The hook reads the opener while it renders, because by the time its effect
// runs the dialog's own autoFocus (or the focus-in) has already moved the
// keyboard inside. It also keeps the opener's name, because a list can
// redraw itself while the dialog is open: the sidebar rebuilds its rows on
// every poll beat, so the tile that was pressed is a different node by the
// time the dialog closes.

// A fake page just big enough for the opener rules: elements that know their
// name, whether they are still in the page, and a focus() that moves the
// document's activeElement.
function openerPage() {
  const doc = { activeElement: null, elements: [] }
  doc.body = { tagName: 'BODY' }
  doc.querySelectorAll = (tag) => doc.elements.filter((el) => el.tagName === tag)
  doc.add = (tag, name, { connected = true, rect = true, label = null } = {}) => {
    const el = {
      tagName: tag,
      textContent: name,
      isConnected: connected,
      focus() {
        doc.activeElement = el
      },
      hasAttribute: () => false,
      getAttribute: (attr) => (attr === 'aria-label' ? label : null),
      getClientRects: () => (rect ? [{ width: 1 }] : []),
    }
    doc.elements.push(el)
    return el
  }
  return doc
}

test('the opener is focused again when it is still in the page', () => {
  const doc = openerPage()
  const tile = doc.add('BUTTON', 'New chat')
  doc.activeElement = tile
  const saved = captureOpener(tile, doc)
  doc.activeElement = null
  assert.equal(focusOpener(saved, doc), true)
  assert.equal(doc.activeElement, tile)
})

test('the opener was replaced while the dialog was open: the new node takes the focus', () => {
  const doc = openerPage()
  const before = doc.add('BUTTON', 'New chat')
  doc.activeElement = before
  const saved = captureOpener(before, doc)
  // A poll beat redrew the sidebar: same control on screen, new element.
  before.isConnected = false
  const after = doc.add('BUTTON', 'New chat')
  doc.activeElement = null
  assert.equal(focusOpener(saved, doc), true)
  assert.equal(doc.activeElement, after, 'the person stays on New chat, not on the body')
})

test('a name that is no longer on the page leaves focus where it was', () => {
  const doc = openerPage()
  const gone = doc.add('BUTTON', 'Rename')
  doc.activeElement = gone
  const saved = captureOpener(gone, doc)
  // The row was removed while the dialog was open, and nothing replaced it.
  gone.isConnected = false
  doc.activeElement = null
  assert.equal(focusOpener(saved, doc), false)
  assert.equal(doc.activeElement, null)
})

test('the body is never remembered, and the name a person reads is the fallback', () => {
  const doc = openerPage()
  assert.equal(captureOpener(doc.body, doc), null)
  assert.equal(captureOpener(null, doc), null)
  const labelled = doc.add('BUTTON', 'New chat Ctrl+N', { label: 'New chat' })
  assert.equal(captureOpener(labelled, doc).label, 'New chat', 'an aria-label beats the visible shortcut')
})