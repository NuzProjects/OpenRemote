import assert from 'node:assert/strict'
import test from 'node:test'
import {
  BEAT_INTERVAL_MS,
  MISSES_TO_BANNER,
  classifyBeat,
  createBeatLoop,
  nextConnection,
} from './beat.js'

// The shape a beat's `run` returns: the lists answered unless named, and
// the rider calls answered too so a test only has to name the surprise.
const answered = (over = {}) => ({
  sessions: { status: 'fulfilled', value: [] },
  machines: { status: 'fulfilled', value: [] },
  mcpServers: { status: 'fulfilled', value: [] },
  automations: { status: 'fulfilled', value: [] },
  projects: { status: 'fulfilled', value: [] },
  cloud: { status: 'fulfilled', value: null },
  cloudDevices: { status: 'fulfilled', value: { devices: [] } },
  ...over,
})

// A daemon that answered nothing at all.
const silent = () => {
  const out = {}
  for (const name of ['sessions', 'machines', 'mcpServers', 'automations', 'projects', 'cloud', 'cloudDevices']) {
    out[name] = { status: 'rejected', reason: new Error('did not answer') }
  }
  return out
}

// Mocked timers fire synchronously, so the async beat needs its microtasks
// drained before the next assertion; a real macrotask is the cheapest way
// to flush them without depending on the mock's own bookkeeping.
const flush = () => new Promise((resolve) => setImmediate(resolve))

test('a beat is answered when one of the four deciding lists answered', () => {
  assert.equal(classifyBeat(answered()).answered, true)
  // A rider answering is not a daemon that can keep the banner off.
  const onlyRiders = answered({
    sessions: { status: 'rejected' },
    machines: { status: 'rejected' },
    mcpServers: { status: 'rejected' },
    automations: { status: 'rejected' },
  })
  assert.equal(classifyBeat(onlyRiders).answered, false)
  assert.deepEqual(
    classifyBeat(onlyRiders).failed,
    ['sessions', 'machines', 'mcpServers', 'automations'],
    'the failing lists are named so a route that throws every beat is visible',
  )
  assert.equal(classifyBeat(null).answered, false, 'a poll that heard nothing is not an answer')
})

test('the banner comes on the third beat with no answer, and only from connected', () => {
  // Two quiet beats are carried, the third reports the daemon gone.
  assert.deepEqual(nextConnection('connected', { answered: false, misses: 0 }), { misses: 1, state: null })
  assert.deepEqual(nextConnection('connected', { answered: false, misses: 1 }), { misses: 2, state: null })
  assert.deepEqual(nextConnection('connected', { answered: false, misses: 2 }), {
    misses: MISSES_TO_BANNER,
    state: 'error',
  })
  // An answer clears the count and revives an error connection.
  assert.deepEqual(nextConnection('connected', { answered: true, misses: 2 }), { misses: 0, state: null })
  assert.deepEqual(nextConnection('error', { answered: true, misses: 3 }), { misses: 0, state: 'connected' })
  // A first run that has not connected is not an incident, and an error
  // connection stays an error until a beat answers.
  assert.deepEqual(nextConnection('connecting', { answered: false, misses: 2 }), { misses: 3, state: null })
  assert.deepEqual(nextConnection('error', { answered: false, misses: 8 }), { misses: 9, state: null })
})

test('the first beat comes after one interval, then one per settle', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  let calls = 0
  const loop = createBeatLoop({
    run: async () => {
      calls += 1
      return answered()
    },
    onBeat: () => {},
  })
  loop.start()
  await flush()
  assert.equal(calls, 0, 'starting the loop is not a beat: the interval fires the first one')
  t.mock.timers.tick(BEAT_INTERVAL_MS)
  await flush()
  assert.equal(calls, 1)
  t.mock.timers.tick(BEAT_INTERVAL_MS - 1)
  await flush()
  assert.equal(calls, 1, 'nothing runs before the interval is up')
  t.mock.timers.tick(1)
  await flush()
  assert.equal(calls, 2)
})

test('a beat in flight is never asked again, and the next one waits for it', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  let calls = 0
  let release = null
  const loop = createBeatLoop({
    run: () => {
      calls += 1
      return new Promise((resolve) => {
        release = () => resolve(answered())
      })
    },
    onBeat: () => {},
  })
  loop.start()
  t.mock.timers.tick(BEAT_INTERVAL_MS)
  await flush()
  assert.equal(calls, 1)
  // A daemon that takes ten intervals to answer is asked once, not ten times.
  t.mock.timers.tick(BEAT_INTERVAL_MS * 10)
  await flush()
  assert.equal(calls, 1, 'a slow beat is not stacked on')
  release()
  await flush()
  t.mock.timers.tick(BEAT_INTERVAL_MS - 1)
  await flush()
  assert.equal(calls, 1, 'the interval is measured from the settle, not the start')
  t.mock.timers.tick(1)
  await flush()
  assert.equal(calls, 2)
})

test('three silent beats report the daemon gone, and the next answer revives it', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  let daemon = 'connected'
  let dead = true
  const reported = []
  const loop = createBeatLoop({
    run: async () => (dead ? silent() : answered()),
    currentConnection: () => daemon,
    onBeat: (beat) => {
      reported.push(beat.connection)
      if (beat.connection) daemon = beat.connection
    },
  })
  loop.start()
  for (let i = 0; i < MISSES_TO_BANNER; i += 1) {
    t.mock.timers.tick(BEAT_INTERVAL_MS)
    await flush()
  }
  assert.deepEqual(reported, [null, null, 'error'], 'two quiet beats are tolerated, the third is news')
  dead = false
  t.mock.timers.tick(BEAT_INTERVAL_MS)
  await flush()
  assert.equal(reported.at(-1), 'connected', 'the first answering beat heals it')
  assert.equal(loop.state().misses, 0)
})

test('a kick takes the pending beat\'s place instead of adding a second loop', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  let calls = 0
  const loop = createBeatLoop({
    run: async () => {
      calls += 1
      return answered()
    },
    onBeat: () => {},
  })
  loop.start()
  t.mock.timers.tick(BEAT_INTERVAL_MS / 2)
  loop.kick()
  await flush()
  assert.equal(calls, 1, 'the kick runs a beat now')
  t.mock.timers.tick(BEAT_INTERVAL_MS)
  await flush()
  assert.equal(calls, 2, 'one loop survives the kick, so one beat per interval, not two')
})

test('a kick while a beat is in flight does nothing', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  let calls = 0
  let release = null
  const loop = createBeatLoop({
    run: () => {
      calls += 1
      return new Promise((resolve) => {
        release = () => resolve(answered())
      })
    },
    onBeat: () => {},
  })
  loop.kick()
  await flush()
  assert.equal(calls, 1)
  loop.kick()
  await flush()
  assert.equal(calls, 1, 'the in-flight beat is left alone')
  release()
  await flush()
})

test('a poll that throws is a beat with no answer, not a crash', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const reported = []
  const loop = createBeatLoop({
    run: async () => {
      throw new Error('the promise chain itself broke')
    },
    onBeat: (beat) => reported.push(beat),
  })
  loop.kick()
  await flush()
  assert.equal(reported.length, 1)
  assert.equal(reported[0].answered, false)
  assert.equal(reported[0].misses, 1)
})

test('stop clears the timer and nothing runs again', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  let calls = 0
  const loop = createBeatLoop({
    run: async () => {
      calls += 1
      return answered()
    },
    onBeat: () => {},
  })
  loop.start()
  t.mock.timers.tick(BEAT_INTERVAL_MS)
  await flush()
  assert.equal(calls, 1)
  loop.stop()
  assert.equal(loop.state().scheduled, false, 'the pending timer is gone')
  t.mock.timers.tick(BEAT_INTERVAL_MS * 10)
  await flush()
  assert.equal(calls, 1, 'a stopped loop is silent')
  loop.kick()
  await flush()
  assert.equal(calls, 1, 'and a kick cannot restart it')
})
