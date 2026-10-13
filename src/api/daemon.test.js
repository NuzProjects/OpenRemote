import assert from 'node:assert/strict'
import test from 'node:test'
import { createServer } from 'node:net'
import { DaemonApi, parseCursor, parseSseLine, sessionGone } from './daemon.js'

// ---- the resume cursor ----

test('a cursor counts only as a non-negative integer', () => {
  assert.equal(parseCursor(0), 0)
  assert.equal(parseCursor(41), 41)
  assert.equal(parseCursor('41'), 41)
  assert.equal(parseCursor(null), null)
  assert.equal(parseCursor(undefined), null)
  assert.equal(parseCursor(''), null)
  assert.equal(parseCursor('41x'), null)
  assert.equal(parseCursor(' 41'), null)
  assert.equal(parseCursor('-1'), null)
  assert.equal(parseCursor(-1), null)
  assert.equal(parseCursor(4.5), null)
  assert.equal(parseCursor(NaN), null)
})

// ---- one SSE line ----

test('an id line carries the frame seq, a data line its event', () => {
  assert.deepEqual(parseSseLine('id: 7'), { seq: 7 })
  assert.deepEqual(parseSseLine('id: 0'), { seq: 0 })
  assert.deepEqual(parseSseLine('data: {"seq":7,"type":"a"}'), { event: { seq: 7, type: 'a' } })
  assert.deepEqual(parseSseLine('data: {not json'), { malformed: true })
  // Separators, keep-alive comments, and an id that is not a number are
  // nothing the reader can use.
  assert.equal(parseSseLine(''), null)
  assert.equal(parseSseLine(': keep-alive'), null)
  assert.equal(parseSseLine('id: soon'), null)
})

// ---- the SSE reader over a stubbed fetch ----

// Drive `events()` with the daemon's SSE bytes as one finished response;
// the returned promise settles when the reader reports its close. A
// numeric `fail` answers that HTTP status instead of streaming, so the
// close path an error status takes is observable too.
async function collect(frames, { after, fail } = {}) {
  const api = new DaemonApi('http://daemon', 'token')
  const seen = []
  const noted = []
  let url = null
  const realFetch = globalThis.fetch
  const realError = console.error
  globalThis.fetch = async (requestUrl) => {
    url = requestUrl
    if (fail != null) return new Response('no such session', { status: fail })
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(frames))
        controller.close()
      },
    })
    return new Response(body, { status: 200 })
  }
  console.error = (...args) => noted.push(args.join(' '))
  try {
    const closedWith = await new Promise((resolve) => {
      api.events('s1', {
        after,
        onEvent: (event) => seen.push(event),
        onClose: (cursor, err) => resolve({ cursor, err }),
      })
    })
    return { seen, noted, url, ...closedWith }
  } finally {
    globalThis.fetch = realFetch
    console.error = realError
  }
}

test('well-formed frames reach onEvent and the close reports the last seq', async () => {
  const { seen, cursor, err } = await collect(
    'id: 1\ndata: {"seq":1,"type":"a"}\n\nid: 2\ndata: {"seq":2,"type":"b"}\n\n',
  )
  assert.deepEqual(seen, [
    { seq: 1, type: 'a' },
    { seq: 2, type: 'b' },
  ])
  assert.equal(cursor, 2)
  // A clean end to the stream is not an error.
  assert.equal(err, undefined)
})

test('a malformed frame is skipped, not fatal: reading continues past it', async () => {
  const { seen, cursor, noted } = await collect(
    'id: 1\ndata: {"seq":1,"type":"a"}\n\n' +
      'id: 2\ndata: {not json\n\n' +
      'id: 3\ndata: {"seq":3,"type":"c"}\n\n',
  )
  assert.deepEqual(seen.map((event) => event.type), ['a', 'c'])
  assert.equal(cursor, 3)
  assert.equal(noted.length, 1)
})

test('a malformed frame that ends the stream still advances the cursor past it', async () => {
  const { seen, cursor } = await collect(
    'id: 1\ndata: {"seq":1,"type":"a"}\n\nid: 2\ndata: torn\n\n',
  )
  assert.deepEqual(seen.map((event) => event.type), ['a'])
  // Resuming from 2 starts after the bad frame, never inside it again.
  assert.equal(cursor, 2)
})

test('a run of malformed frames is noted on the first and again at the tenth', async () => {
  let frames = ''
  for (let seq = 1; seq <= 10; seq += 1) frames += `id: ${seq}\ndata: {oops\n\n`
  const { seen, noted } = await collect(frames)
  assert.deepEqual(seen, [])
  assert.equal(noted.length, 2)
})

test('a garbage stored cursor is a deliberate full replay: no after param', async () => {
  const { url } = await collect('id: 1\ndata: {"seq":1,"type":"a"}\n\n', { after: '12x' })
  assert.ok(!url.includes('after='))
})

test('a valid stored cursor rides the url', async () => {
  const { url } = await collect('id: 10\ndata: {"seq":10,"type":"a"}\n\n', { after: '9' })
  assert.ok(url.includes('after=9'))
})

// ---- a session that is no longer there ----

test('a 404 close carries the status: the caller can tell a dead session from a dead connection', async () => {
  const { cursor, err } = await collect('', { fail: 404 })
  // No frame was ever read, so the resume cursor is the one asked for.
  assert.equal(cursor, null)
  assert.equal(err.status, 404)
  assert.ok(sessionGone(err))
})

test('another HTTP error also rides the close, but is not a gone session', async () => {
  const { err } = await collect('', { fail: 503 })
  assert.equal(err.status, 503)
  assert.ok(!sessionGone(err))
  // A clean close (stream simply ended) and no error at all: retryable.
  assert.ok(!sessionGone(undefined))
  assert.ok(!sessionGone(new Error('network drop')))
})

// ---- a probe the daemon could not ask ----

test('a failed models probe rejects: never an empty array to cache', async () => {
  // The daemon answers 503 when a harness's catalog probe fails (the
  // CLI not signed in, slow to boot, a spawn failure). An empty array is
  // a real answer callers may hold; a failed probe must never pose as
  // one, so it surfaces as the same rejection every failed call is.
  const api = new DaemonApi('http://daemon', 'token')
  const realFetch = globalThis.fetch
  globalThis.fetch = async () => new Response('{"error": "could not ask"}', { status: 503 })
  try {
    await assert.rejects(
      api.models('claude'),
      (err) => {
        assert.equal(err.message, 'could not ask')
        assert.equal(err.status, 503)
        return true
      },
    )
  } finally {
    globalThis.fetch = realFetch
  }
})

// ---- request timeouts ----

test('a request that never answers rejects when its timeout fires', async () => {
  // A socket that accepts the connection but never answers: the daemon
  // that is alive but wedged.
  const open = new Set()
  const server = createServer((socket) => {
    open.add(socket)
    socket.on('close', () => open.delete(socket))
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  const api = new DaemonApi(`http://127.0.0.1:${port}`, 'token')
  try {
    await assert.rejects(api.call('GET', '/healthz', null, { timeoutMs: 200 }), /did not answer in time/)
  } finally {
    for (const socket of open) socket.destroy()
    server.close()
  }
})

test('every request is bounded: 10s normally, 120s across a harness boot, none for the installer', async () => {
  const api = new DaemonApi('http://daemon', 'token')
  const budgets = []
  const signals = []
  const realTimeout = AbortSignal.timeout
  const realFetch = globalThis.fetch
  // The budget is observable only where it is spent, so record what
  // reaches AbortSignal.timeout (and whether a signal rides the fetch).
  AbortSignal.timeout = (ms) => {
    budgets.push(ms)
    return new AbortController().signal
  }
  globalThis.fetch = async (requestUrl, options) => {
    signals.push(options.signal)
    return new Response('null', { status: 200 })
  }
  try {
    await api.call('GET', '/healthz')
    // The four whose wait includes a harness boot (a cold CLI can take
    // 30-60 s daemon-side): create, resume, run-now, and the model
    // catalog's CLI handshake.
    await api.createSession({ harness: 'claude' })
    await api.resume('s1')
    await api.runRule('r1')
    await api.models('claude')
    await api.installHarness('m1', 'claude')
  } finally {
    AbortSignal.timeout = realTimeout
    globalThis.fetch = realFetch
  }
  assert.deepEqual(budgets, [10000, 120000, 120000, 120000, 120000])
  assert.ok(signals.slice(0, 5).every((signal) => signal instanceof AbortSignal))
  // The installer's wait is the contract: no signal at all.
  assert.equal(signals[5], undefined)
})
