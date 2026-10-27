// Stop everything: which chats count as running, the order they are named
// in, the copies the palette shows at each step, and the sentence that
// settles what actually happened. The palette half is a source-text wiring
// test, the style this repo uses where no renderer exists.

import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import {
  NAMED_CAP,
  elsewhereAside,
  isRunning,
  namedChats,
  orderForStop,
  runningLabel,
  stopQuestion,
  stopSummary,
  stopTargets,
  stoppingLine,
} from './stop-everything.js'

const session = (over = {}) => ({
  id: 's1',
  title: 'Triage the failing tests',
  harness: 'claude',
  status: 'working',
  created_at: 100,
  updated_at: 900,
  device_id: null,
  ...over,
})

test('running is working or waiting, and nothing else', () => {
  assert.equal(isRunning(session()), true)
  assert.equal(isRunning(session({ status: 'waiting' })), true)
  for (const status of ['starting', 'idle', 'stopped', 'failed', undefined]) {
    assert.equal(isRunning(session({ status })), false, String(status))
  }
  assert.equal(isRunning(null), false)
})

test('the oldest work is named first', () => {
  const list = [
    session({ id: 'b', created_at: 200 }),
    session({ id: 'c', created_at: 100 }),
    session({ id: 'a', created_at: 300 }),
  ]
  assert.deepEqual(orderForStop(list).map((s) => s.id), ['c', 'b', 'a'])
})

test('ties fall back to last activity, then to the title, so the order is stable', () => {
  const list = [
    session({ id: 'x', created_at: 100, updated_at: 500, title: 'b' }),
    session({ id: 'y', created_at: 100, updated_at: 400, title: 'a' }),
    session({ id: 'z', created_at: 100, updated_at: 400, title: 'c' }),
  ]
  assert.deepEqual(orderForStop(list).map((s) => s.id), ['y', 'z', 'x'])
})

test('a chat with no timestamps is named last, not first', () => {
  const list = [session({ id: 'none', created_at: undefined, updated_at: undefined }), session({ id: 'older', created_at: 5 })]
  assert.deepEqual(orderForStop(list).map((s) => s.id), ['older', 'none'])
})

test('a private chat and a chat on this computer are stoppable; another device is named and skipped', () => {
  const { running, stoppable, elsewhere } = stopTargets(
    [
      session({ id: 'here', device_id: null }),
      session({ id: 'this', device_id: 'dev-1' }),
      session({ id: 'there', device_id: 'dev-2' }),
      session({ id: 'idle', status: 'idle' }),
    ],
    { thisDevice: 'dev-1' },
  )
  assert.equal(running.length, 3)
  assert.deepEqual(stoppable.map((s) => s.id), ['here', 'this'])
  assert.deepEqual(elsewhere.map((s) => s.id), ['there'])
})

test('with no device identity, a synced chat is treated as elsewhere rather than guessed at', () => {
  const { stoppable, elsewhere } = stopTargets([session({ id: 'there', device_id: 'dev-2' })], {})
  assert.deepEqual(stoppable, [])
  assert.deepEqual(elsewhere.map((s) => s.id), ['there'])
})

test('the question names the number', () => {
  assert.equal(stopQuestion(1), 'Stop 1 chat?')
  assert.equal(stopQuestion(3), 'Stop 3 chats?')
})

test('the names are capped, and the rest is counted', () => {
  const chats = Array.from({ length: 7 }, (_, i) => session({ id: `s${i}`, title: `Chat ${i}` }))
  const { rows, more } = namedChats(chats)
  assert.equal(rows.length, NAMED_CAP)
  assert.equal(more, 3)
  assert.deepEqual(rows.map((r) => r.name), ['Chat 0', 'Chat 1', 'Chat 2', 'Chat 3'])
  assert.deepEqual(namedChats(chats.slice(0, 2)), { rows: [{ id: 's0', name: 'Chat 0', harness: 'claude' }, { id: 's1', name: 'Chat 1', harness: 'claude' }], more: 0 })
  assert.equal(namedChats([session({ title: null })]).rows[0].name, 'A new task')
})

test('while the stops land, the line says so', () => {
  assert.equal(stoppingLine(3), 'Stopping 3.')
  assert.equal(stoppingLine(1), 'Stopping 1.')
})

test('the outcome sentence says what actually happened', () => {
  // The sentence from the plan, word for word.
  assert.equal(
    stopSummary({ stopped: 2, elsewhere: 1 }),
    'Stopped 2. One is on another computer, so it kept running.',
  )
  assert.equal(stopSummary({ stopped: 3 }), 'Stopped 3.')
  assert.equal(
    stopSummary({ stopped: 0, elsewhere: 2 }),
    'Nothing was stopped. Two are on other computers, so they kept running.',
  )
  assert.equal(stopSummary({ stopped: 2, gone: 1 }), 'Stopped 2. One was already gone.')
  assert.equal(stopSummary({ stopped: 2, gone: 2 }), 'Stopped 2. Two were already gone.')
  assert.equal(stopSummary({ stopped: 2, failed: 1 }), 'Stopped 2. One did not answer.')
  assert.equal(
    stopSummary({ stopped: 1, elsewhere: 1, gone: 1, failed: 1 }),
    'Stopped 1. One is on another computer, so it kept running. One was already gone. One did not answer.',
  )
})

test('the palette row says how much work it would end', () => {
  assert.equal(runningLabel(1), '1 running')
  assert.equal(runningLabel(4), '4 running')
})

test('chats that will keep running are said before the question is answered', () => {
  assert.equal(elsewhereAside(0), '')
  assert.equal(elsewhereAside(1), 'One more is on another computer and will keep running.')
  assert.equal(elsewhereAside(2), 'Two more are on other computers and will keep running.')
})

// ---- the palette wiring ----

const palette = readFileSync(new URL('./CommandPalette.jsx', import.meta.url), 'utf8')

test('the command is in the palette, and only while something is running', () => {
  assert.match(palette, /from '\.\/stop-everything\.js'/)
  assert.match(palette, /stopTargets\(sessions \?\? \[\], \{ thisDevice \}\)/)
  assert.match(palette, /targets\.running\.length\r?\n\s+\?/)
  assert.match(palette, /name: 'Stop all running chats'/)
  assert.match(palette, /run: \{ stopAll: true \}/)
})

test('choosing it asks inside the palette, and the safe answer is the first row', () => {
  assert.match(palette, /if \(r\.stopAll\) \{/)
  const keep = palette.indexOf("name: 'Keep them running'")
  const stop = palette.indexOf("name: 'Stop them'")
  assert.ok(keep > 0 && stop > keep, 'cancel comes before stop, so a stray Enter cancels')
  assert.match(palette, /stopQuestion\(/)
  assert.match(palette, /namedChats\(/)
  assert.match(palette, /elsewhereAside\(/)
})

test('it stops through the action a single chat already uses, once per chat', () => {
  assert.match(palette, /stopChat \} = useConsole\(\)/)
  assert.match(palette, /await stopChat\(chat\.id\)/)
  assert.equal((palette.match(/stopChat\(/g) ?? []).length, 1, 'one call site, per chat in the loop')
})

test('a stop that is already gone is skipped, not failed', () => {
  assert.match(palette, /sessionGone\(err\)/)
  assert.match(palette, /stopSummary\(\{ stopped, elsewhere: plan\.elsewhere\.length, gone, failed \}\)/)
})

test('it says stopping first, then settles', () => {
  assert.match(palette, /stoppingLine\(/)
  assert.match(palette, /setStopPhase\('stopping'\)/)
  assert.match(palette, /setStopPhase\('done'\)/)
})

test('the Changes row the palette already had is still there', () => {
  assert.match(palette, /name: 'Changes in this chat'/)
  assert.match(palette, /run: \{ changes: reviewChat\.id \}/)
  assert.match(palette, /else if \(r\.changes\) openChanges\(r\.changes\)/)
})