// A daemon that will not start used to leave the app on a setup spinner
// with nothing said: the console set a waiting-daemon state that no
// component read, and the heal poll ran only for connection errors, so a
// sidecar that appeared late needed a restart. This pins the parts that
// make the state reachable, and the event name both sides agree on.

import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'

const source = (file) => readFileSync(new URL(`./${file}`, import.meta.url), 'utf8')

test('App renders the waiting-daemon state', () => {
  const app = source('App.jsx')
  assert.match(app, /connection\.state === 'waiting-daemon'/)
  assert.match(app, /<DaemonStatus/)
})

test('the panel takes its copy from the rule and its button from the rule', () => {
  const panel = source('DaemonStatus.jsx')
  assert.match(panel, /daemonStatus\(daemon\)/)
  assert.match(panel, /status\.action === 'try-now'/)
})

test('the heal poll keeps running for the waiting screen', () => {
  assert.match(
    source('state/console.jsx'),
    /connection\.state !== 'error' && connection\.state !== 'waiting-daemon'/,
  )
})

test('the waiting screen keeps a way in for a daemon the user runs', () => {
  // The panel replaces the wizard, and the wizard's manual form is the only
  // way to reach a daemon the app does not start itself. It is offered to
  // everyone, not just a first run: an address that stopped answering is
  // replaced by typing a new one, and that is the same form.
  const app = source('App.jsx')
  assert.match(app, /<DaemonStatus onManualConnect=\{\(\) => setManualConnect\(true\)\}/)
  assert.doesNotMatch(app, /onManualConnect=\{onboarded \? null/)
  // And the manual branch is the first one: it is not behind `onboarded`.
  assert.match(app, /\{manualConnect \? \(/)
  assert.doesNotMatch(app, /\{!onboarded && manualConnect/)
  assert.match(source('Onboarding.jsx'), /startManual \? 'setup' : 'welcome'/)
})

test('the shell and the console name the status event the same way', () => {
  const desktop = readFileSync(new URL('../src-tauri/src/desktop.rs', import.meta.url), 'utf8')
  assert.match(desktop, /"daemon:status"/)
  assert.match(source('state/console.jsx'), /listen\('daemon:status'/)
})
