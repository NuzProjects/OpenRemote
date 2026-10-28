// The two words that told the wrong story: a stream refused for ever called a drop
// that heals itself, and a console bug blamed on the daemon.
import test from 'node:test'
import assert from 'node:assert/strict'

import { errorCopy } from './error-copy.js'
import { harnessRows } from './harness-manager.js'

test('a live stream refused is not called a drop that is healing', () => {
  // 5xx is what a reconnect can fix; a 404 (a daemon that no longer serves the route)
  // or a 403 would otherwise promise a recovery that never comes.
  assert.match(errorCopy(new Error('SSE HTTP 503')), /reconnecting on its own/)
  for (const code of [400, 403, 404, 410]) {
    const line = errorCopy(new Error(`SSE HTTP ${code}`))
    assert.match(line, new RegExp(`refused the live stream \\(HTTP ${code}\\)`))
    assert.doesNotMatch(line, /reconnecting on its own/)
  }
})

test('a TypeError from the console is not reported as an unreachable daemon', () => {
  // `instanceof TypeError` was read as proof the request never landed, so a shape bug
  // in the console's own code sent a person to restart a daemon that was fine.
  const bug = new TypeError("Cannot read properties of undefined (reading 'id')")
  const line = errorCopy(bug)
  assert.doesNotMatch(line, /could not reach its daemon/)
  assert.match(line, /Cannot read properties of undefined/)
  // The real network case still says what it always said.
  assert.match(errorCopy(new TypeError('Failed to fetch')), /could not reach its daemon/)
  assert.match(errorCopy(new Error('fetch failed: ECONNREFUSED')), /could not reach its daemon/)
})

test('a harness the daemon cannot sign in for says how its own sign-in works', () => {
  const caps = {
    harnesses: [
      { id: 'claude', available: true, signed_in: false, version: '2.1.0', path: '/usr/bin/claude' },
      { id: 'opencode', available: true, signed_in: false, version: '2.1.2', path: '/usr/bin/oc' },
      { id: 'codex', available: true, signed_in: true, version: '1.0.0' },
    ],
  }
  const rows = harnessRows(caps, null)
  const claude = rows.find((r) => r.id === 'claude')
  const opencode = rows.find((r) => r.id === 'opencode')
  const codex = rows.find((r) => r.id === 'codex')
  assert.equal(claude.action, 'signin', 'the daemon relays this one')
  assert.equal(opencode.action, 'none')
  assert.match(opencode.detail, /signs in through its own setup/)
  assert.equal(opencode.detailKind, 'note')
  assert.equal(codex.statusLabel, 'Ready')
})
