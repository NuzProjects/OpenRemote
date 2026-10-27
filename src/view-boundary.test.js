import assert from 'node:assert/strict'
import test from 'node:test'
import { RETRY_LIMIT, causeLine, errorLine, failureNotice, firstFrame } from './view-boundary.js'

const componentStack = `
    at ChatView (http://localhost:5175/src/ChatView.jsx:412:9)
    at Splash (http://localhost:5175/src/Splash.jsx:20:3)`

test('an error keeps its own words and the component frame that names where it threw', () => {
  const notice = failureNotice({
    error: new TypeError("Cannot read properties of undefined (reading 'map')"),
    componentStack,
  })
  assert.equal(notice.detail.message, "TypeError: Cannot read properties of undefined (reading 'map')")
  assert.equal(notice.detail.frame, 'at ChatView (http://localhost:5175/src/ChatView.jsx:412:9)')
  assert.equal(notice.cause, 'Something this view expected to find was not there.')
  assert.equal(
    notice.retry,
    false,
    'reading a field of undefined fails the same way on every try, so the panel does not offer one',
  )
})

test('the property-access family is not worth retrying, whichever way it is worded', () => {
  const shapes = [
    "Cannot read properties of undefined (reading 'map')",
    "Cannot read property 'map' of undefined",
    "Cannot read properties of null (reading 'length')",
    "undefined is not an object (evaluating 'rows.map')",
    "null is not an object (evaluating 'state.id')",
  ]
  for (const message of shapes) {
    const notice = failureNotice({ error: new TypeError(message) })
    assert.equal(notice.retry, false, `no retry for: ${message}`)
    assert.equal(notice.detail.message, `TypeError: ${message}`, 'and the words still reach the panel')
  }
})

test('an error that is not one of the deterministic shapes still offers one retry', () => {
  // Something outside the rendered state (a race, a clock, a value read once)
  // can pass on a second render, so the panel keeps the way to try.
  const notice = failureNotice({ error: new Error('the response was not a list') })
  assert.equal(notice.retry, true)
})

test('the cause line names the kind of failure rather than repeating the message', () => {
  assert.equal(causeLine(new ReferenceError('x is not defined')), 'The view asked for a name that is not defined.')
  assert.equal(causeLine(new RangeError('bad size')), 'The view asked for a size or a number it cannot work with.')
  assert.equal(causeLine(new SyntaxError('bad json')), 'The view could not read something it was given.')
  assert.equal(causeLine(new Error('anything else')), 'The view stopped while it was drawing itself.')
  assert.equal(causeLine('a thrown string'), 'The view stopped while it was drawing itself.')
})

test('something thrown that is not an Error still has honest rows', () => {
  assert.equal(errorLine('plain text'), 'plain text')
  assert.equal(errorLine(42), '42')
  assert.equal(errorLine({}), 'The view threw something that is not an error.')
  const notice = failureNotice({ error: { message: 'a rejected promise' } })
  assert.equal(notice.detail.message, 'a rejected promise')
  assert.equal(notice.detail.frame, '', 'no stack, no frame: the block shows the message alone')
  assert.equal(notice.retry, true)
})

test('the first frame is the component stack when there is one, the error stack when not', () => {
  const error = new Error('boom')
  assert.equal(firstFrame(error, componentStack), 'at ChatView (http://localhost:5175/src/ChatView.jsx:412:9)')
  const own = firstFrame(error)
  assert.match(own, /^at /, "the error's own first frame stands in for a missing component stack")
  assert.equal(firstFrame({ message: 'no stack' }), '')
  assert.equal(firstFrame(error, '   \n  '), own, 'a blank component stack falls through to the error')
})

test('an error React cannot render at all is not worth retrying on its first failure', () => {
  const children = failureNotice({ error: new Error('Objects are not valid as a React child (found: object)') })
  assert.equal(children.retry, false)
  const hooks = failureNotice({ error: new Error('Rendered more hooks than during the previous render.') })
  assert.equal(hooks.retry, false)
  const infinite = failureNotice({ error: new Error('Maximum update depth exceeded.') })
  assert.equal(infinite.retry, false)
})

test('retrying once is the limit; after that the panel offers the way back only', () => {
  const error = new Error('boom')
  assert.equal(failureNotice({ error, attempts: 0 }).retry, true)
  assert.equal(failureNotice({ error, attempts: RETRY_LIMIT }).retry, false)
  assert.equal(failureNotice({ error, attempts: RETRY_LIMIT + 1 }).retry, false)
})

test('nothing thrown, nothing to show', () => {
  assert.equal(failureNotice({ error: null }), null)
  assert.equal(failureNotice(), null)
  assert.equal(failureNotice({ error: undefined, attempts: 3 }), null)
})

test('every notice is complete: a cause, both detail rows and a retry answer', () => {
  for (const error of [new Error('x'), new TypeError('y'), 'z', { message: 'm' }, 7]) {
    const notice = failureNotice({ error, componentStack })
    assert.equal(typeof notice.cause, 'string')
    assert.ok(notice.cause.length > 0)
    assert.equal(typeof notice.detail.message, 'string')
    assert.equal(typeof notice.detail.frame, 'string')
    assert.equal(typeof notice.retry, 'boolean')
  }
})
