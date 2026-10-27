// What a unit test cannot reach from outside: the provider is a hook, so
// these four wiring facts are read from its source, the same way the other
// wiring tests read the views. Each one is the load-bearing line of a fix
// whose failure the reporter would feel, not a description of the file.

import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'

const source = readFileSync(new URL('./console.jsx', import.meta.url), 'utf8')

const between = (from, to) => {
  const start = source.indexOf(from)
  const end = source.indexOf(to, start + from.length)
  assert.ok(start >= 0 && end > start, `${from} .. ${to} not found in console.jsx`)
  return source.slice(start, end)
}

test('a status report for the same daemon does not reconnect', () => {
  // A respawn on the same port, or a retry that found the daemon already up,
  // used to tear down every live stream and replay every transcript. The
  // comparison has to come before the reconnect, or it decides nothing.
  const body = between('const applyDaemonInfo', 'const retryDaemon')
  const guard = body.indexOf('sameDaemon(apiRef.current, info.url, info.token)')
  const connect = body.indexOf('connect(info.url, info.token)')
  assert.ok(guard >= 0, 'the report is compared with the daemon in hand')
  assert.ok(connect > guard, 'and the comparison runs before any reconnect')
})

test('an answer from a daemon the console has left is dropped', () => {
  // The model catalog is the one that sticks: it is fetched once per key, so
  // a stale answer would be offered for the rest of the session.
  const body = between('const modelsFor', 'The custom model endpoints')
  assert.match(body, /if \(!stillCurrent\(api\)\) return list/)
})

test('a reconnect resumes from the fold cursor, never a second one', () => {
  const body = between('const openStream', 'A new connection')
  assert.doesNotMatch(body, /stream\.cursor/, 'one cursor, and it is the fold\'s')
  assert.match(body, /follow\(chatsRef\.current\[id\]\?\.foldedSeq \?\? null\)/)
})

test('pointing at another daemon clears what the last one answered', () => {
  const connect = between('const connect', 'const disconnect')
  const disconnect = between('const disconnect', 'One way in for everything')
  assert.match(connect, /resetDaemonData\(\)/, 'a switch resets the daemon-owned lists')
  assert.match(disconnect, /resetDaemonData\(\)/, 'and so does a disconnect')
})
