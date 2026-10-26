// The waiting screen's copy, pinned. It is the only thing the app says
// about a daemon that did not start, so a claim here is a claim the code
// has to keep: the retry button exists only where daemon_restart does,
// and the detail line is whatever the shell said, cleaned.

import assert from 'node:assert/strict'
import test from 'node:test'

import { daemonStatus, detailOf } from './daemon-status.js'

test('no answer yet is the starting state, with a way to start it again', () => {
  for (const info of [null, undefined, {}, { mobile: false }]) {
    const status = daemonStatus(info)
    assert.equal(status.tone, 'starting')
    assert.equal(status.title, 'Waiting for the daemon')
    assert.equal(status.detail, null)
    assert.equal(status.action, 'try-now')
    // A moment is not a promise of forever, and it is not an error.
    assert.match(status.note, /usually takes a moment/)
    assert.doesNotMatch(status.note, /did not start/)
  }
})

test('a reported failure says so, in the shell\'s own words', () => {
  const reason = 'failed to spawn `openremote-daemon`: The system cannot find the file specified. (os error 2)'
  const status = daemonStatus({ error: reason })
  assert.equal(status.tone, 'failed')
  assert.equal(status.title, 'The daemon did not start')
  assert.equal(status.detail, reason)
  assert.equal(status.action, 'try-now')
  // The shell does retry the spawn on its own (desktop.rs backs off to
  // 30s), so the copy may say it does.
  assert.match(status.note, /keeps trying on its own/)
})

test('a blank reason is no reason: no empty detail box', () => {
  for (const error of ['', '   ', '\n\t ', null, undefined, 42]) {
    const status = daemonStatus({ error })
    assert.equal(status.tone, 'starting')
    assert.equal(status.detail, null)
  }
})

test('mobile gets no retry button, because daemon_restart is not there', () => {
  const failed = daemonStatus({ error: 'the daemon stopped (exit code 1)', mobile: true })
  assert.equal(failed.tone, 'failed')
  assert.equal(failed.action, null)
  assert.match(failed.note, /Close OpenRemote and open it again/)
  const starting = daemonStatus({ mobile: true })
  assert.equal(starting.action, null)
  assert.doesNotMatch(starting.note, /try starting it again/)
})

test('the detail is one line and never longer than the cap', () => {
  const messy = 'error:\r\n  could not open file\r\n\tat C:\\Program Files\\OpenRemote'
  assert.equal(detailOf(messy), 'error: could not open file at C:\\Program Files\\OpenRemote')
  const long = 'x'.repeat(1000)
  const capped = detailOf(long)
  assert.equal(capped.length, 240)
  assert.ok(capped.endsWith('...'))
  assert.equal(detailOf(null), null)
})
