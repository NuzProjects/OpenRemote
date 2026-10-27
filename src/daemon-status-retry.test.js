// The waiting screen's one action: restarting the daemon. The shell closes
// the old daemon's stdin and waits for it to stop the harnesses it started,
// so the action takes seconds by design and the panel keeps its words while
// it runs. A button that stays live there takes a second press, and a second
// press starts a second restart (4177a13 made that visible: the first press
// now has a real, quiet rest of a few seconds). This pins the guard.

import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'

const source = readFileSync(new URL('./DaemonStatus.jsx', import.meta.url), 'utf8')

test('the retry button is one press while a restart is in flight', () => {
  assert.match(source, /disabled=\{retrying\}/)
  // The press has to show somewhere: the panel's words do not change.
  assert.match(source, /retrying \? 'Restarting\.\.\.' : 'Try now'/)
  // And the handler itself refuses a second press, not only the disabled
  // attribute (a programmatic call, a keyboard repeat before the first
  // render lands).
  assert.match(source, /if \(retrying\) return/)
})

test('the busy state clears by itself, and clears its timer on the way out', () => {
  assert.match(source, /const RETRY_BUSY_MS = \d+/)
  assert.match(source, /setTimeout\(\(\) => setRetrying\(false\), RETRY_BUSY_MS\)/)
  assert.match(source, /clearTimeout\(timer\)/)
})
