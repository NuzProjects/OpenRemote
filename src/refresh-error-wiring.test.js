// The two silences the release walk found: a catalogue refresh whose request
// threw, and an endpoint list whose read failed. Both now say what happened in
// the pane's own error style and both offer the retry they need - and the
// retry reads the same call, not a second one.

import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'

const source = (file) => readFileSync(new URL(`./${file}`, import.meta.url), 'utf8')

test('a discover refresh that throws becomes a card with a Try again', () => {
  const pane = source('PluginDiscover.jsx')
  assert.match(pane, /import \{ errorCopy \} from '\.\/error-copy\.js'/)
  assert.match(pane, /setRefreshError\(\{ name, message: errorCopy\(err\) \}\)/)
  // The retry path clears the card before it asks again, so an old failure
  // does not sit beside a fresh attempt.
  assert.match(pane, /setRefreshError\(\(curr\) => \(curr\?\.name === name \? null : curr\)\)/)
  // Same card as the marketplace record errors, with the same button that
  // retries the same call.
  assert.match(pane, /\{refreshError && \(\s*<div className="pg-errors">/)
  assert.match(pane, /className="pg-error-card" role="alert"/)
  assert.match(pane, /Couldn&apos;t refresh \{refreshError\.name\}/)
  assert.match(pane, /\{refreshError\.message\}/)
  assert.match(pane, /onClick=\{\(\) => handleRetry\(refreshError\.name\)\}/)
  assert.match(pane, />\s*Try again\s*</)
})

test('a failed endpoint read is the error state, not the empty state, with a retry', () => {
  const pane = source('EndpointManager.jsx')
  assert.match(pane, /const \[loadError, setLoadError\] = useState\(null\)/)
  assert.match(pane, /setLoadError\(errorCopy\(err\)\)/)
  // A fresh read clears the old sentence before it asks.
  assert.match(pane, /setPending\(true\)\s*\n\s*setLoadError\(null\)/)
  // The skeleton is only for a read still running: a failure comes after it.
  assert.match(pane, /\{pending \? \([\s\S]{0,240}\) : loadError \? \(/)
  assert.match(pane, /The endpoint list could not be read/)
  assert.match(pane, /\{loadError\}/)
  assert.match(pane, /onClick=\{load\}[\s\S]{0,120}Try again/)
  // The empty state cannot appear while the error does: it lives in the branch
  // after the error row.
  const emptyAt = pane.indexOf('No custom endpoints yet')
  const errorAt = pane.indexOf('The endpoint list could not be read')
  assert.ok(errorAt > 0 && emptyAt > errorAt, 'the empty line comes after the error branch')
})
