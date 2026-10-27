// The first thirty seconds: three rules that keep the boot from lying,
// flashing, or throwing away what the person typed before the session list
// arrives. The behaviour lives in the provider and the shell, which the test
// runner cannot import (JSX, React state), so these pin the source the way the
// other wiring tests do.

import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'

const source = (file) => readFileSync(new URL(`./${file}`, import.meta.url), 'utf8')

test('the shell does not dial the address the last run saved', () => {
  // The saved address is the previous daemon's port. Building the client from
  // it made every launch fetch a dead port before the shell had answered, and
  // the refusal was shown as a daemon failure.
  const console = source('state/console.jsx')
  assert.match(console, /const saved = hasTauri \? \{\} : loadConnection\(\)/)
  assert.match(console, /new DaemonApi\(saved\.url, saved\.token\)/)
  // And the connect effect has to stay guarded: an empty client never dials.
  assert.match(console, /if \(!api\.ready \|\| connection\.state === 'connected'\) return undefined/)
})

test('a connecting state becomes the waiting screen after a grace, never a verdict', () => {
  const console = source('state/console.jsx')
  // A constant, not a literal buried in the effect.
  const grace = console.match(/const BOOT_GRACE_MS = (\d+)/)
  assert.ok(grace, 'BOOT_GRACE_MS must exist')
  const ms = Number(grace[1])
  // Long enough that a warm start (address in the first daemon_info answer)
  // or a half-second boot never shows the screen; short enough that a person
  // does not sit in front of a wordless app.
  assert.ok(ms >= 2000 && ms <= 4000, `the grace is ${ms}ms`)
  // Only `connecting` may become the waiting screen: a first run is `new` and
  // must keep the wizard.
  assert.match(
    console,
    /c\.state === 'connecting' \? \{ state: 'waiting-daemon', error: null \} : c/,
  )
  // The flip is not a failure: no error is attached, so the waiting screen
  // shows its patient copy rather than "the daemon did not start".
  assert.match(console, /setConnection\(\(c\) =>\s*c\.state === 'connecting'/)
  assert.match(console, /clearTimeout\(slow\)/)
})

test('the New chat composer waits for the boot seed to resolve', () => {
  const app = source('App.jsx')
  // The seed is a chat id the session list cannot validate yet; drawing the
  // live composer there loses whatever was typed when the view moves.
  assert.match(app, /bootSeed && !sessionsAnswered \?/)
  assert.match(app, /Opening your chat\.\.\./)
  // The quiet panel is the one the missing-chat pane already uses.
  assert.match(app, /className="cv-none"/)
  // A split pane's New chat is a deliberate one, not a seed: its branch
  // (`paneContent`) must not be guarded by the seed.
  const pane = app.match(/const paneContent = \(leaf\) => \{[\s\S]*?\n  \}/)
  assert.ok(pane, 'paneContent must exist')
  assert.doesNotMatch(pane[0], /bootSeed/)
})
