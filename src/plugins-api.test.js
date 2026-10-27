// The plugin routes' client budgets. A plugin install runs whatever makes
// the plugin, which for a marketplace entry is a command that can take
// minutes, so the client must not cut it off and then report a failure
// while the daemon finishes. Everything else in the plugin lane keeps a
// timeout, so a wedged daemon still surfaces instead of hanging the pane.

import assert from 'node:assert/strict'
import test from 'node:test'
import { DaemonApi } from './api/daemon.js'

function captureFetch(body = '{"result":{}}') {
  const seen = []
  const original = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    seen.push({ url, init })
    return new Response(body, { status: 200, headers: { 'Content-Type': 'application/json' } })
  }
  return {
    seen,
    restore: () => {
      globalThis.fetch = original
    },
  }
}

async function call(route) {
  const { seen, restore } = captureFetch()
  try {
    await route(new DaemonApi('http://127.0.0.1:9', 'token'))
  } finally {
    restore()
  }
  assert.equal(seen.length, 1, 'one request')
  return seen[0]
}

test('a plugin install carries no client timeout', async () => {
  const request = await call((api) => api.installStagedPlugin('stage-1'))
  assert.equal(request.init.method, 'POST')
  assert.match(request.url, /\/plugins\/stage\/stage-1\/install$/)
  assert.equal(request.init.signal, undefined, 'the install is the wait, not a call')
})

test('the harness installer stays unbounded too', async () => {
  const request = await call((api) => api.installHarness('machine-1', 'pi'))
  assert.equal(request.init.signal, undefined)
})

test('staging keeps its own long budget', async () => {
  const request = await call((api) => api.stagePlugin({ kind: 'git', url: 'https://example.test/p' }))
  assert.ok(request.init.signal instanceof AbortSignal)
})

test('removing a plugin is bounded, so a hung daemon still answers', async () => {
  const request = await call((api) => api.removePlugin('name@market'))
  assert.match(request.url, /\/plugins\/name%40market\/remove$/)
  assert.ok(request.init.signal instanceof AbortSignal)
})

test('a plain list read keeps the normal budget', async () => {
  const request = await call((api) => api.plugins())
  assert.match(request.url, /\/plugins$/)
  assert.ok(request.init.signal instanceof AbortSignal)
})
