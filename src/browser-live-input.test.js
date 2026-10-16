import assert from 'node:assert/strict'
import test from 'node:test'
import {
  HOLD_MS,
  clampView,
  coalesce,
  fit,
  flingSteps,
  keyName,
  pinchView,
  start,
  step,
  textEdits,
  toPage,
  wheelFromDrag,
  wheelPixels,
} from './browser-live-input.js'

// Plays touch events through the machine; answers every action it asked for.
function play(events) {
  let state = start()
  const actions = []
  for (const e of events) {
    const next = step(state, e)
    state = next.state
    actions.push(...next.actions)
  }
  return actions
}

const down = (x, y, t = 0, id = 1) => ({ type: 'down', id, x, y, t })
const move = (x, y, t, id = 1) => ({ type: 'move', id, x, y, t })
const up = (x, y, t, id = 1) => ({ type: 'up', id, x, y, t })

test('the picture is drawn as large as fits, in its own shape', () => {
  assert.deepEqual(fit({ width: 1000, height: 400 }, { width: 800, height: 800 }), {
    x: 300,
    y: 0,
    width: 400,
    height: 400,
  })
  assert.deepEqual(fit({ width: 0, height: 0 }, { width: 800, height: 800 }).width, 0)
})

test('a point on the picture is a point on the page', () => {
  const rect = { left: 100, top: 50, width: 400, height: 200 }
  const frame = { width: 1280, height: 640 }
  assert.deepEqual(toPage({ x: 300, y: 150 }, rect, frame), { x: 640, y: 320 })
  assert.equal(toPage({ x: 50, y: 150 }, rect, frame), null)
  assert.deepEqual(toPage({ x: 50, y: 400 }, rect, frame, { clamp: true }), { x: 0, y: 640 })
})

test('a tap is a click, and a slow tap is too', () => {
  assert.deepEqual(play([down(10, 10), up(12, 11, 90)]), [{ kind: 'click', x: 12, y: 11, button: 'left' }])
  assert.deepEqual(play([down(10, 10), up(10, 10, 400)]), [{ kind: 'click', x: 10, y: 10, button: 'left' }])
})

test('a drag scrolls, with the distance it had already moved, and flings', () => {
  const actions = play([down(100, 300), move(100, 270, 16), move(100, 220, 32), move(100, 160, 48), up(100, 160, 50)])
  assert.deepEqual(actions[0], { kind: 'scroll', dx: 0, dy: -30 })
  assert.deepEqual(actions[1], { kind: 'scroll', dx: 0, dy: -50 })
  assert.equal(actions.filter((a) => a.kind === 'click').length, 0)
  const fling = actions.at(-1)
  assert.equal(fling.kind, 'fling')
  assert.ok(fling.vy < -0.5, 'upward')
  // The page follows the finger: it goes the other way.
  assert.deepEqual(wheelFromDrag(0, -30, 2), { dx: -0, dy: 60 })
})

test('a long press then a drag drags from where the finger first was', () => {
  const actions = play([
    down(50, 50),
    { type: 'hold', id: 1, t: HOLD_MS },
    move(80, 60, HOLD_MS + 20),
    move(120, 90, HOLD_MS + 40),
    up(120, 90, HOLD_MS + 60),
  ])
  assert.deepEqual(actions, [
    { kind: 'buzz' },
    { kind: 'down', x: 50, y: 50 },
    { kind: 'move', x: 80, y: 60 },
    { kind: 'move', x: 120, y: 90 },
    { kind: 'up', x: 120, y: 90 },
  ])
})

test('a long press that stays put is a right click', () => {
  const actions = play([down(50, 50), { type: 'hold', id: 1, t: HOLD_MS }, up(51, 50, 700)])
  assert.deepEqual(actions, [{ kind: 'buzz' }, { kind: 'click', x: 50, y: 50, button: 'right' }])
})

test('two fingers pinch, and neither one then taps or scrolls', () => {
  const actions = play([
    down(100, 100, 0, 1),
    down(200, 100, 5, 2),
    move(80, 100, 20, 1),
    move(220, 100, 20, 2),
    up(80, 100, 40, 1),
    move(220, 130, 50, 2),
    up(220, 130, 60, 2),
  ])
  assert.ok(actions.length >= 3 && actions.every((a) => a.kind === 'pinch'))
  assert.deepEqual(actions.at(-1).start, [
    { x: 100, y: 100 },
    { x: 200, y: 100 },
  ])
})

test('a pinch grows the picture about the fingers and stays on the stage', () => {
  const size = { width: 400, height: 300 }
  const base = { scale: 1, tx: 0, ty: 0 }
  const grown = pinchView(
    base,
    [
      { x: 150, y: 150 },
      { x: 250, y: 150 },
    ],
    [
      { x: 100, y: 150 },
      { x: 300, y: 150 },
    ],
    size,
  )
  assert.equal(grown.scale, 2)
  // The middle of the fingers (200, 150) still shows the same part of it.
  assert.equal((200 - grown.tx) / grown.scale, 200)
  assert.deepEqual(clampView({ scale: 9, tx: 50, ty: -9000 }, size), { scale: 4, tx: 0, ty: -900 })
  assert.deepEqual(clampView({ scale: 0.4, tx: 30, ty: 30 }, size), { scale: 1, tx: 0, ty: 0 })
})

test('a fling slows to a stop', () => {
  const steps = flingSteps(0, -2)
  assert.ok(steps.length > 10 && steps.length < 90)
  assert.ok(Math.abs(steps[0].dy) > Math.abs(steps.at(-1).dy))
  assert.deepEqual(flingSteps(0.001, 0), [])
})

test('the mouse wheel is counted in pixels', () => {
  assert.deepEqual(wheelPixels({ deltaMode: 0, deltaX: 0, deltaY: 120 }), { dx: 0, dy: 120 })
  assert.deepEqual(wheelPixels({ deltaMode: 1, deltaX: 0, deltaY: 3 }), { dx: 0, dy: 120 })
})

test('keys that are not typed go as names; typed ones go through the textarea', () => {
  const key = (k, extra = {}) => ({ key: k, ctrlKey: false, altKey: false, shiftKey: false, metaKey: false, ...extra })
  assert.equal(keyName(key('Enter')), 'Enter')
  assert.equal(keyName(key('Tab', { shiftKey: true })), 'Shift+Tab')
  assert.equal(keyName(key('ArrowLeft')), 'ArrowLeft')
  assert.equal(keyName(key('a', { ctrlKey: true })), 'Control+a')
  assert.equal(keyName(key('c', { metaKey: true }), { mac: true }), 'Control+c')
  assert.equal(keyName(key(' ', { ctrlKey: true })), 'Control+Space')
  assert.equal(keyName(key('a')), null, 'a typed letter is text')
  assert.equal(keyName(key('A', { shiftKey: true })), null)
  assert.equal(keyName(key('@', { ctrlKey: true, altKey: true })), null, 'AltGr types')
  assert.equal(keyName(key('Shift', { shiftKey: true })), null)
  assert.equal(keyName(key('Unidentified')), null)
  assert.equal(keyName(key('Process', { keyCode: 229 })), null, 'the keyboard is composing')
})

test('the textarea going from one value to another is some keys and some text', () => {
  assert.deepEqual(textEdits('', 'hello'), [{ kind: 'text', text: 'hello' }])
  assert.deepEqual(textEdits('teh', 'the'), [
    { kind: 'key', key: 'Backspace' },
    { kind: 'key', key: 'Backspace' },
    { kind: 'text', text: 'he' },
  ])
  assert.deepEqual(textEdits('ab', 'a'), [{ kind: 'key', key: 'Backspace' }])
  assert.deepEqual(textEdits('', 'one\ntwo'), [
    { kind: 'text', text: 'one' },
    { kind: 'key', key: 'Enter' },
    { kind: 'text', text: 'two' },
  ])
  assert.deepEqual(textEdits('same', 'same'), [])
})

test('what waits to be sent folds together, but never past a click or a key', () => {
  const folded = coalesce([
    { kind: 'move', x: 1, y: 1 },
    { kind: 'move', x: 5, y: 5 },
    { kind: 'wheel', x: 9, y: 9, dx: 0, dy: 10 },
    { kind: 'wheel', x: 9, y: 9, dx: 0, dy: -4 },
    { kind: 'key', key: 'Enter' },
    { kind: 'wheel', x: 9, y: 9, dx: 0, dy: 3 },
    { kind: 'text', text: 'a' },
    { kind: 'text', text: 'b' },
  ])
  assert.deepEqual(folded, [
    { kind: 'move', x: 5, y: 5 },
    { kind: 'wheel', x: 9, y: 9, dx: 0, dy: 6 },
    { kind: 'key', key: 'Enter' },
    { kind: 'wheel', x: 9, y: 9, dx: 0, dy: 3 },
    { kind: 'text', text: 'ab' },
  ])
})
