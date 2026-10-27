// Instrumentation for the event fold, not a gate.
//
// It times the two shapes the console has used for stream events, on this
// machine, over a synthetic turn: a 200-item timeline and a 500-event stream.
// Nothing here asserts a number - a timing check on a shared machine fails for
// reasons that have nothing to do with the code - so run it when the fold
// changes and read the table.
//
// The shapes:
//   per event: one chat copy and one timeline copy for every event (what the
//              console did before the frame batch).
//   per frame: one copy for each animation frame's batch of events, folded
//              through the same foldEvent calls in the same order.
//
// Usage: node scripts/fold-bench.mjs

import { chatFromSession, foldEvent, foldEvents } from '../src/state/reducer.js'

const TIMELINE_SEED = 200
const STREAM_EVENTS = 500
const RUNS = 7

const session = {
  id: 's1',
  harness: 'claude',
  workspace: 'C:\\dev\\webapp',
  status: 'idle',
  last_error: null,
}
const event = (seq, payload) => ({ seq, session_id: 's1', ...payload })

// A chat with a 200-item history: the baseline every run starts from.
function baseChat() {
  let chat = chatFromSession(session)
  let seq = 0
  for (let i = 0; i < TIMELINE_SEED; i += 1) {
    seq += 1
    if (i % 5 === 0) {
      chat = foldEvent(chat, event(seq, { type: 'message.added', message: { id: `seed-${i}`, turn: Math.floor(i / 5), role: 'user', text: `question ${i}` } }))
    } else if (i % 5 === 1) {
      chat = foldEvent(chat, event(seq, { type: 'tool.started', turn: Math.floor(i / 5), name: 'Bash', input: { command: `cmd ${i}` } }))
    } else {
      chat = foldEvent(chat, event(seq, { type: 'message.added', message: { id: `seed-${i}`, turn: Math.floor(i / 5), role: 'assistant', text: `answer ${i}` } }))
    }
  }
  return chat
}

// One turn's stream: mostly deltas growing the live reply, with a settled
// message and a tool call every so often, which is the shape a harness sends.
function stream() {
  const events = []
  let seq = TIMELINE_SEED + 1
  let turn = 40
  for (let i = 0; i < STREAM_EVENTS; i += 1) {
    const phase = i % 50
    if (phase === 0) {
      events.push(event(seq++, { type: 'message.delta', turn, text: `reply ${i} ` }))
    } else if (phase === 25) {
      events.push(event(seq++, { type: 'tool.started', turn, name: 'Bash', input: { command: `step ${i}` } }))
    } else if (phase === 26) {
      events.push(event(seq++, { type: 'tool.result', turn, name: 'Bash', output: 'ok', is_error: false }))
    } else if (phase === 45) {
      events.push(event(seq++, { type: 'message.delta', turn, text: 'more ' }))
    } else if (phase === 49) {
      events.push(event(seq++, { type: 'message.added', message: { id: `m-${i}`, turn, role: 'assistant', text: 'settled reply' } }))
      turn += 1
    } else {
      events.push(event(seq++, { type: 'message.delta', turn, text: 'x' }))
    }
  }
  return events
}

// The old shape: a copy of the chat and the timeline for every event.
function foldPerEvent(stream, base) {
  let chats = { s1: base }
  for (const e of stream) {
    const chat = chats.s1
    chats = { ...chats, s1: foldEvent({ ...chat, timeline: [...chat.timeline] }, e) }
  }
  return chats
}

// The new shape: a copy per frame, the whole batch folded against it.
function foldPerFrame(stream, base, perFrame) {
  let chats = { s1: base }
  for (let i = 0; i < stream.length; i += perFrame) {
    const chat = chats.s1
    chats = { ...chats, s1: foldEvents({ ...chat, timeline: [...chat.timeline] }, stream.slice(i, i + perFrame)) }
  }
  return chats
}

function time(fn) {
  const runs = []
  for (let i = 0; i < RUNS; i += 1) {
    const start = performance.now()
    fn()
    runs.push(performance.now() - start)
  }
  runs.sort((a, b) => a - b)
  return runs[Math.floor(runs.length / 2)]
}

const events = stream()
const base = baseChat()
const result = foldPerEvent(events, base)
if (result.s1.timeline.length < TIMELINE_SEED) throw new Error('the bench stream lost the history')

const rows = []
const oldMs = time(() => foldPerEvent(events, base))
for (const perFrame of [1, 8, 60, events.length]) {
  const newMs = time(() => foldPerFrame(events, base, perFrame))
  rows.push({
    perFrame,
    frames: Math.ceil(events.length / perFrame),
    oldMs,
    newMs,
    speedup: oldMs / newMs,
    oldRefs: events.length * base.timeline.length,
    newRefs: Math.ceil(events.length / perFrame) * base.timeline.length,
  })
}

console.log(`${STREAM_EVENTS} events over a ${base.timeline.length}-item timeline, median of ${RUNS} runs, ms`)
console.log('events/frame  frames  per event (old)  per frame (new)  speedup  timeline refs old -> new')
for (const row of rows) {
  console.log(
    `${String(row.perFrame).padStart(12)}  ${String(row.frames).padStart(6)}  ${row.oldMs.toFixed(2).padStart(15)}  ${row.newMs.toFixed(2).padStart(15)}  ${row.speedup.toFixed(2).padStart(7)}x  ${String(row.oldRefs).padStart(8)} -> ${row.newRefs}`,
  )
}
