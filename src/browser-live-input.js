// What a person does on a live view of another device's tab, as what the
// page there should receive. Pure, so it is tested without a DOM: the view
// (BrowserLiveView.jsx) feeds it pointers, keys and the hidden textarea's
// edits, and sends what comes out.
//
// A tap is a click, a drag scrolls, a long press then a drag drags (a long
// press that doesn't move is a right click, a phone's context menu), two
// fingers pinch the picture bigger locally (the page itself doesn't move),
// and typing arrives as text and keys. Points are in the page's CSS pixels,
// the size the source says its pictures are.

// A touch that wanders this far (CSS pixels of the screen) is no longer a tap.
export const TAP_SLOP = 10
// A touch held this long without moving is a long press.
export const HOLD_MS = 450
// How far in the picture may be zoomed locally.
export const MAX_ZOOM = 4

// ---- where things are ----

// The largest box of the picture's shape that fits the stage, centred.
export function fit(stage, frame) {
  if (!(stage?.width > 0) || !(stage?.height > 0) || !(frame?.width > 0) || !(frame?.height > 0)) {
    return { x: 0, y: 0, width: 0, height: 0 }
  }
  const scale = Math.min(stage.width / frame.width, stage.height / frame.height)
  const width = frame.width * scale
  const height = frame.height * scale
  return { x: (stage.width - width) / 2, y: (stage.height - height) / 2, width, height }
}

// A point on the screen as a point of the page, given where the picture is
// drawn now (after any local zoom). Outside the picture it is null, unless
// `clamp` pins it to the nearest edge (a drag that leaves the picture).
export function toPage(point, rect, frame, { clamp = false } = {}) {
  if (!(rect?.width > 0) || !(rect?.height > 0) || !(frame?.width > 0) || !(frame?.height > 0)) return null
  let u = (point.x - rect.left) / rect.width
  let v = (point.y - rect.top) / rect.height
  if (u < 0 || u > 1 || v < 0 || v > 1) {
    if (!clamp) return null
    u = Math.min(1, Math.max(0, u))
    v = Math.min(1, Math.max(0, v))
  }
  return { x: round(u * frame.width), y: round(v * frame.height) }
}

function round(n) {
  return Math.round(n * 10) / 10
}

// ---- the local zoom ----

// Keeps a zoomed picture covering its stage: it can be moved but never off
// so far that the stage shows past its edge. `view` is { scale, tx, ty }
// with the picture's top-left at (tx, ty), in the stage's own pixels.
export function clampView(view, size) {
  const scale = Math.min(MAX_ZOOM, Math.max(1, view.scale))
  const minX = Math.min(0, size.width - size.width * scale)
  const minY = Math.min(0, size.height - size.height * scale)
  return {
    scale,
    tx: Math.min(0, Math.max(minX, view.tx)),
    ty: Math.min(0, Math.max(minY, view.ty)),
  }
}

// The picture as two fingers hold it: bigger or smaller by how far apart
// they are against where they started, and moved with their middle, so the
// part of the picture that was under the fingers stays there.
export function pinchView(base, start, now, size) {
  const d0 = Math.hypot(start[0].x - start[1].x, start[0].y - start[1].y)
  const d1 = Math.hypot(now[0].x - now[1].x, now[0].y - now[1].y)
  if (!(d0 > 0)) return clampView(base, size)
  const scale = Math.min(MAX_ZOOM, Math.max(1, base.scale * (d1 / d0)))
  const m0 = { x: (start[0].x + start[1].x) / 2, y: (start[0].y + start[1].y) / 2 }
  const m1 = { x: (now[0].x + now[1].x) / 2, y: (now[0].y + now[1].y) / 2 }
  // The picture's point under the fingers' middle at the start.
  const px = (m0.x - base.tx) / base.scale
  const py = (m0.y - base.ty) / base.scale
  return clampView({ scale, tx: m1.x - px * scale, ty: m1.y - py * scale }, size)
}

// ---- the touch gestures ----

// One touch at a time is a tap, a scroll, or a drag; two are a pinch. The
// machine is a reducer: `step(state, event)` answers the next state and
// what to do. Events carry the pointer's id, its position on screen and the
// time; `hold` comes from the view's timer, HOLD_MS after the first touch.
//
// Actions: click {x, y, button}, scroll {dx, dy} (the finger's own move on
// the screen: the view turns it into the page's wheel), fling {vx, vy}
// (px per ms), down/move/up {x, y} (a drag, at screen points), pinch {points,
// start}, and `buzz` (the long press landed).
export function start() {
  return { phase: 'idle', pointers: {}, samples: [] }
}

const near = (a, b, within) => Math.hypot(a.x - b.x, a.y - b.y) <= within

export function step(state, e) {
  switch (e.type) {
    case 'down': {
      const pointers = { ...state.pointers, [e.id]: { x: e.x, y: e.y } }
      const count = Object.keys(pointers).length
      if (count === 1) {
        return {
          state: { phase: 'pending', pointers, origin: { x: e.x, y: e.y }, at: e.t, samples: [] },
          actions: [],
        }
      }
      if (count === 2) {
        // Two fingers: whatever one was doing ends without a click, and a
        // drag already under way lets go where it is.
        const actions = state.phase === 'dragging' ? [{ kind: 'up', x: state.last.x, y: state.last.y }] : []
        const ids = Object.keys(pointers)
        return {
          state: {
            phase: 'pinching',
            pointers,
            start: ids.map((id) => ({ ...pointers[id] })),
            ids,
            samples: [],
          },
          actions: [...actions, { kind: 'pinch', points: ids.map((id) => pointers[id]), start: ids.map((id) => pointers[id]) }],
        }
      }
      return { state: { ...state, pointers }, actions: [] }
    }

    case 'hold': {
      if (state.phase !== 'pending') return { state, actions: [] }
      return { state: { ...state, phase: 'held' }, actions: [{ kind: 'buzz' }] }
    }

    case 'move': {
      if (!state.pointers[e.id]) return { state, actions: [] }
      const was = state.pointers[e.id]
      const pointers = { ...state.pointers, [e.id]: { x: e.x, y: e.y } }
      if (state.phase === 'pending') {
        if (near(state.origin, e, TAP_SLOP)) return { state: { ...state, pointers }, actions: [] }
        // Moved before the hold: the finger is scrolling. The first step
        // carries what it already moved.
        return {
          state: { ...state, phase: 'scrolling', pointers, samples: [{ x: e.x, y: e.y, t: e.t }] },
          actions: [{ kind: 'scroll', dx: e.x - state.origin.x, dy: e.y - state.origin.y }],
        }
      }
      if (state.phase === 'held') {
        if (near(state.origin, e, TAP_SLOP)) return { state: { ...state, pointers }, actions: [] }
        // Held, then moved: a drag, which starts where the finger first was.
        return {
          state: { ...state, phase: 'dragging', pointers, last: { x: e.x, y: e.y } },
          actions: [
            { kind: 'down', x: state.origin.x, y: state.origin.y },
            { kind: 'move', x: e.x, y: e.y },
          ],
        }
      }
      if (state.phase === 'scrolling') {
        const samples = [...state.samples, { x: e.x, y: e.y, t: e.t }].filter((s) => e.t - s.t <= 120)
        return {
          state: { ...state, pointers, samples },
          actions: [{ kind: 'scroll', dx: e.x - was.x, dy: e.y - was.y }],
        }
      }
      if (state.phase === 'dragging') {
        return { state: { ...state, pointers, last: { x: e.x, y: e.y } }, actions: [{ kind: 'move', x: e.x, y: e.y }] }
      }
      if (state.phase === 'pinching') {
        const points = state.ids.map((id) => pointers[id]).filter(Boolean)
        if (points.length < 2) return { state: { ...state, pointers }, actions: [] }
        return { state: { ...state, pointers }, actions: [{ kind: 'pinch', points, start: state.start }] }
      }
      return { state: { ...state, pointers }, actions: [] }
    }

    case 'up':
    case 'cancel': {
      if (!state.pointers[e.id]) return { state, actions: [] }
      const pointers = { ...state.pointers }
      delete pointers[e.id]
      const left = Object.keys(pointers).length
      const cancelled = e.type === 'cancel'
      if (state.phase === 'pinching') {
        // A finger left: the pinch is over, and the other one is ignored
        // until it lifts too, so it never turns into a tap or a scroll.
        return { state: left ? { phase: 'ignoring', pointers, samples: [] } : start(), actions: [] }
      }
      if (state.phase === 'ignoring') {
        return { state: left ? { ...state, pointers } : start(), actions: [] }
      }
      let actions = []
      if (!cancelled) {
        if (state.phase === 'pending') {
          // Lifted before the hold and without moving: a tap, however slow.
          actions = [{ kind: 'click', x: e.x, y: e.y, button: 'left' }]
        } else if (state.phase === 'held') {
          actions = [{ kind: 'click', x: state.origin.x, y: state.origin.y, button: 'right' }]
        } else if (state.phase === 'scrolling') {
          const v = velocity(state.samples)
          if (v) actions = [{ kind: 'fling', vx: v.vx, vy: v.vy }]
        }
      }
      if (state.phase === 'dragging') actions = [{ kind: 'up', x: e.x, y: e.y }]
      return { state: left ? { phase: 'ignoring', pointers, samples: [] } : start(), actions }
    }

    default:
      return { state, actions: [] }
  }
}

// How fast a finger was moving as it lifted (px per ms), from the last
// moments of its path; null when it was slow or the path too short to say.
export function velocity(samples) {
  if (samples.length < 2) return null
  const first = samples[0]
  const last = samples[samples.length - 1]
  const span = last.t - first.t
  if (span < 20) return null
  const vx = (last.x - first.x) / span
  const vy = (last.y - first.y) / span
  return Math.hypot(vx, vy) >= 0.3 ? { vx, vy } : null
}

// The scrolling that carries on after a fling, a step a frame, slowing as
// it goes, until it is too small to matter: [{ dx, dy }] in screen pixels,
// one per 16 ms.
export function flingSteps(vx, vy, { frame = 16, friction = 0.94, floor = 0.4, max = 90 } = {}) {
  const steps = []
  let dx = vx * frame
  let dy = vy * frame
  while (steps.length < max && Math.hypot(dx, dy) >= floor) {
    steps.push({ dx, dy })
    dx *= friction
    dy *= friction
  }
  return steps
}

// A finger's move on the screen as the page's wheel: the page follows the
// finger, so it goes the other way, and a screen pixel is `scale` page
// pixels (the page is drawn smaller or larger than it is).
export function wheelFromDrag(dx, dy, scale) {
  return { dx: round(-dx * scale), dy: round(-dy * scale) }
}

// A mouse wheel's turn in pixels, whatever unit the browser counted in.
export function wheelPixels(e, { line = 40, page = 800 } = {}) {
  const unit = e.deltaMode === 1 ? line : e.deltaMode === 2 ? page : 1
  return { dx: round(e.deltaX * unit), dy: round(e.deltaY * unit) }
}

// ---- keys and typing ----

const MODIFIERS = new Set(['Control', 'Shift', 'Alt', 'Meta', 'AltGraph', 'CapsLock', 'NumLock', 'ScrollLock', 'Fn', 'OS'])
const NOT_KEYS = new Set(['Dead', 'Unidentified', 'Process', 'Compose', 'Hyper', 'Super'])

// A key press as the name the page's browser takes (`Enter`, `Control+A`,
// `Shift+Tab`), or null when it is not a key to send as one: typed
// characters go as text through the textarea, a modifier alone is nothing.
// On a Mac the Command key stands for Control, which is what the page's
// computer reads copy and paste from.
export function keyName(e, { mac = false } = {}) {
  const key = e.key
  if (!key || MODIFIERS.has(key) || NOT_KEYS.has(key) || e.isComposing || e.keyCode === 229) return null
  const printable = [...key].length === 1
  let ctrl = e.ctrlKey
  const alt = e.altKey
  let meta = e.metaKey
  if (mac && meta) {
    ctrl = true
    meta = false
  }
  // Control and Alt together are how some layouts type a character (AltGr).
  if (printable && e.ctrlKey && e.altKey) return null
  if (printable && !ctrl && !alt && !meta) return null
  const name = key === ' ' ? 'Space' : key
  const parts = []
  if (ctrl) parts.push('Control')
  if (alt) parts.push('Alt')
  if (meta) parts.push('Meta')
  if (e.shiftKey && (!printable || ctrl || alt || meta)) parts.push('Shift')
  parts.push(name)
  return parts.join('+')
}

// What to send for the hidden textarea going from `before` to `after`: the
// characters of `before` that are gone (Backspaces), then what was typed.
// A new line typed is an Enter, not a character. Edits at the end are all a
// soft keyboard makes here: the textarea is kept empty of anything else.
export function textEdits(before, after) {
  const a = [...before]
  const b = [...after]
  let common = 0
  while (common < a.length && common < b.length && a[common] === b[common]) common += 1
  const edits = []
  for (let i = common; i < a.length; i += 1) edits.push({ kind: 'key', key: 'Backspace' })
  const typed = b.slice(common).join('')
  for (const [i, part] of typed.split(/\r\n|\r|\n/).entries()) {
    if (i > 0) edits.push({ kind: 'key', key: 'Enter' })
    if (part) edits.push({ kind: 'text', text: part })
  }
  return edits
}

// Inputs waiting to go, with what can be folded together folded: one drag
// position after another is only the last, and wheel turns add up. Nothing
// else is touched, and nothing moves past a click or a key.
export function coalesce(inputs) {
  const out = []
  for (const input of inputs) {
    const last = out[out.length - 1]
    if (last && last.kind === 'move' && input.kind === 'move') {
      out[out.length - 1] = input
    } else if (last && last.kind === 'wheel' && input.kind === 'wheel') {
      out[out.length - 1] = {
        ...input,
        dx: round(last.dx + input.dx),
        dy: round(last.dy + input.dy),
      }
    } else if (last && last.kind === 'text' && input.kind === 'text') {
      out[out.length - 1] = { kind: 'text', text: last.text + input.text }
    } else {
      out.push(input)
    }
  }
  return out
}
