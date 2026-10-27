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

test('the form the panel opens can be closed again', () => {
  // The manual branch is the first thing the app renders, so without a way
  // back the panel (which heals by itself and is the only place with Try
  // now) is unreachable until the user connects or reloads.
  const app = source('App.jsx')
  const wizard = source('Onboarding.jsx')
  assert.match(app, /onDismiss=\{\(\) => setManualConnect\(false\)\}/)
  assert.match(wizard, /onDismiss = null/)
  assert.match(wizard, /\{onDismiss && \(/)
  assert.match(wizard, /onClick=\{onDismiss\}/)
})

test('Settings can do what the connection errors point at', () => {
  // "reconnect from Settings" is only true if Settings opens the form that
  // takes an address: the connection row can only forget one, and the
  // address row is read-only.
  const app = source('App.jsx')
  const settings = source('SettingsView.jsx')
  const console = source('state/console.jsx')
  assert.match(app, /<SettingsView[\s\S]{0,400}?onManualConnect=\{\(\) => setManualConnect\(true\)\}/)
  assert.match(settings, /onManualConnect = null/)
  assert.match(settings, /data-stg="daemon-connect"/)
  assert.match(settings, /onClick=\{onManualConnect\}/)
  // The row is hidden while a daemon is connected: the form it opens says the
  // daemon did not answer, which must not be said to a working connection.
  assert.match(settings, /onManualConnect && connection\.state !== 'connected'/)
  // Both sentences that name Settings still name it.
  assert.match(console, /check that it's running, or reconnect from Settings/)
  assert.match(console, /Restart the app, or reconnect from Settings/)
})

test('the shell and the console name the status event the same way', () => {
  const desktop = readFileSync(new URL('../src-tauri/src/desktop.rs', import.meta.url), 'utf8')
  assert.match(desktop, /"daemon:status"/)
  assert.match(source('state/console.jsx'), /listen\('daemon:status'/)
})
