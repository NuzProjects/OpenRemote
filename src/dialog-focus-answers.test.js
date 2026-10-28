// The two places a dialog could leave the keyboard nowhere: a surface that stays
// mounted handing focus to its first opener, and an opener the palette had already
// closed.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import { focusOpener, focusSomewhere } from './dialog-focus.js'

const source = (name) => readFileSync(new URL(`./${name}`, import.meta.url), 'utf8')

// A document small enough to need no renderer: three elements, one of them detachable.
function fakeDoc(nodes) {
  const body = {
    querySelectorAll: () => nodes,
  }
  return {
    activeElement: body,
    body,
    querySelectorAll: (sel) => (sel === 'button' ? nodes : []),
    querySelector: () => null,
  }
}

test('the same surface opened twice hands focus to the control just pressed', () => {
  // The review surface is mounted for the whole session: with the opener never cleared,
  // its second close returned the keyboard to the first control, not the second.
  const keys = source('dialog-focus.js')
  const effect = keys.slice(keys.indexOf('const restore = inertOthers(panel)'))
  assert.match(effect, /opener\.current = null/, 'the opener is cleared on close')
  assert.ok(
    effect.indexOf('opener.current = null') < effect.indexOf('}, [open, panelRef])'),
    'inside the cleanup, before the effect returns',
  )
})

test('an opener that is gone sends focus somewhere defined, never to the body', () => {
  const gone = { isConnected: false, tag: 'BUTTON', label: null }
  const doc = fakeDoc([])
  assert.equal(focusOpener(gone, doc), false, 'nothing to restore to')

  // The fallback picks the first stop it can reach, and says so when it cannot.
  const editable = {
    isConnected: true,
    getClientRects: () => [1],
    hasAttribute: () => false,
    focus() {
      withStops.activeElement = this
    },
  }
  const withStops = {
    activeElement: { body: true },
    body: { querySelectorAll: () => [editable] },
    querySelectorAll: () => [],
    querySelector: () => ({ querySelectorAll: () => [editable] }),
  }
  assert.equal(focusSomewhere(null, withStops), true)
  assert.equal(withStops.activeElement, editable)
  // No stops at all is a false answer, not a guess.
  assert.equal(focusSomewhere(null, fakeDoc([])), false)
})
