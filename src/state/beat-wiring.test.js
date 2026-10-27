// The beat's cadence and its death rule live in beat.js and are tested
// there with mocked timers. This reads the provider for the two things a
// unit test of the policy cannot see: that the sidebar poll is that loop
// rather than a bare interval, and that the waiting screen's retry asks
// through it instead of starting a second one.

import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'

const source = readFileSync(new URL('./console.jsx', import.meta.url), 'utf8')

test('the sidebar poll is the beat loop, and a retry asks through it', () => {
  assert.match(source, /createBeatLoop\(\{/)
  assert.match(source, /beatLoopRef\.current = beat/)
  assert.match(source, /retryDaemon[\s\S]{0,400}beatLoopRef\.current\?\.kick\(\)/)
  // Two intervals remain, and neither is the sidebar's beat: the waiting
  // screen's ask for a sidecar that is not up yet, and the sign-in relay's
  // poll of the CLI's own view.
  assert.equal(
    (source.match(/setInterval\(/g) ?? []).length,
    2,
    'a third interval means the poll grew a bare timer again',
  )
})

test('a beat carries capabilities, so a harness installed later appears', () => {
  // The beat's call set is what makes an install, a removal or a sign-in
  // show up without a restart; without capabilities in it, the harness rows
  // keep whatever the boot read.
  const beat = source.slice(source.indexOf('createBeatLoop({'))
  assert.match(beat, /api\.capabilities\(\)/)
})
