// The three behaviours tonight's own review found unpinned: a timeout that now
// carries a status must still read as this app's words, a daemon switch must leave no
// chat behind, and the beat must wait for the boot before owning the lists.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import { errorCopy } from './error-copy.js'

const source = (name) => readFileSync(new URL(`./${name}`, import.meta.url), 'utf8')

test('a timeout is the console talking, never quoted as the daemon', () => {
  // The client marks its timeout with `status: 0` and `code: 'timeout'`. With a status
  // and no code it fell into the refusal branch and put this app's own sentence in the
  // daemon's mouth, which is the one thing error-copy's header forbids.
  const api = new Error('The daemon did not answer in time')
  api.status = 0
  api.code = 'timeout'
  assert.equal(errorCopy(api), 'The console got no answer in time. Try again.')
  // An unmarked status 0 still means nothing came back, not a refusal.
  const bare = new Error('The daemon did not answer in time')
  bare.status = 0
  assert.match(errorCopy(bare), /could not reach its daemon/)
  // A real refusal keeps its own words.
  const refused = new Error('no such chat')
  refused.status = 404
  assert.equal(errorCopy(refused), 'The daemon refused this: “no such chat”.')
})

test('pointing the console at another daemon clears the chat list, and the beat waits', () => {
  // Neither behaviour had a test: a revert would have restored the old chats silently,
  // and the beat would race the boot again.
  const console_ = source('state/console.jsx')
  const reset = console_.slice(console_.indexOf('const resetDaemonData'), console_.indexOf('const connect ='))
  for (const setter of ['setSessions([])', 'setChats({})', 'setWatched([])']) {
    assert.ok(reset.includes(setter), `the reset clears the chat list (${setter})`)
  }
  assert.match(reset, /setBootSettled\(false\)/, 'and a new daemon means a new boot')
  assert.match(console_, /if \(!api\.ready \|\| !bootSettled\) return undefined/, 'the beat waits for the boot')
  assert.match(console_, /\}, \[api, stillCurrent, bootSettled\]\)/, 'and restarts when it settles')
  // The boot settles both ways: a failed boot is when the beat is needed.
  assert.equal((console_.match(/setBootSettled\(true\)/g) || []).length, 2, 'connected, and failed')
})

test('a chat from the other mode does not survive a mode switch into the view', () => {
  const app = source('App.jsx')
  assert.match(app, /import \{ needsSignIn, sessionsForMode \} from '\.\/cloud\.js'/, 'the mode rule is imported')
  const guard = app.slice(app.indexOf('const chatInMode'), app.indexOf('const view ='))
  assert.match(guard, /sessionsForMode\(sessions, mode, thisDevice\)\.some\(\(s\) => s\.id === id\)/)
  // And the resolution consults it for a stored chat.
  assert.match(app, /chats\[stored\] && !chatInMode\(stored\)/)
})
