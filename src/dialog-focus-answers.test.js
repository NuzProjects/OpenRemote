// The two places a dialog could leave the keyboard nowhere: a surface that stays
// mounted handing focus to its first opener, and an opener the palette had already
// closed.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import { focusOpener, focusSomewhere } from './dialog-focus.js'

const source = (name) => readFileSync(new URL(`./${name}`, import.meta.url), 'utf8')

// A document small enough to need no renderer: a body, and the stops it can reach.
function fakeDoc(nodes) {
  const body = { querySelectorAll: () => nodes }
  return {
    activeElement: body,
    body,
    querySelectorAll: () => [],
    querySelector: () => null,
  }
}

test('the same surface opened twice captures its opener again', () => {
  // The review surface stays mounted for the session. Capturing once per mount handed
  // the keyboard back to the first control; capturing per render captured the dialog's
  // own field. It captures on the open transition.
  const keys = source('dialog-focus.js')
  assert.match(keys, /const wasOpen = useRef\(false\)/, 'the transition is remembered')
  assert.match(keys, /if \(open && !wasOpen\.current\) \{\n\s*opener\.current = captureOpener/, 'captured when it opens')
  // And the value survives the cleanup: React runs an effect twice in development, and
  // clearing on the first cleanup left the second pass nothing to restore.
  const cleanup = keys.slice(keys.indexOf('const restore = inertOthers(panel)'))
  assert.doesNotMatch(cleanup.slice(0, 600), /opener\.current = null/)
})

test('an opener that is gone sends focus somewhere defined, never to the body', () => {
  const gone = { isConnected: false, tag: 'BUTTON', label: null }
  const doc = fakeDoc([])
  assert.equal(focusOpener(gone, doc), false, 'nothing to restore to')

  // The fallback picks the first stop it can reach, and says so when it cannot.
  const withStops = {
    activeElement: { body: true },
    body: { querySelectorAll: () => [] },
    querySelectorAll: () => [],
    querySelector: () => null,
  }
  const editable = {
    isConnected: true,
    getClientRects: () => [1],
    hasAttribute: () => false,
    focus() {
      withStops.activeElement = this
    },
  }
  withStops.body.querySelectorAll = () => [editable]
  assert.equal(focusSomewhere(null, withStops), true)
  assert.equal(withStops.activeElement, editable)
  // No stops at all is a false answer, not a guess.
  assert.equal(focusSomewhere(null, fakeDoc([])), false)
})
