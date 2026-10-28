// The DOM smoke is the only gate that reads the running console, so its own
// coverage has to be pinned: a view added to the app without a walk in the smoke
// would quietly shrink what "every view draws" means.
//
// Source text, because the smoke needs a window and this suite has none. What this
// proves is that the lists agree, not that the walk works; the walk itself is
// proved by running the gate.

import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'

const read = (name) => readFileSync(new URL(`./${name}`, import.meta.url), 'utf8')
const smoke = read('../scripts/smoke.mjs')
const app = read('App.jsx')

const staticViews = (() => {
  const line = app.match(/const STATIC_VIEWS = \[([^\]]+)\]/)
  assert.ok(line, 'App.jsx declares STATIC_VIEWS')
  return [...line[1].matchAll(/'([^']+)'/g)].map((m) => m[1])
})()

test('every static view is walked by the smoke', () => {
  assert.ok(staticViews.length >= 8, `STATIC_VIEWS lists the views (found ${staticViews.length})`)
  // The walk names a view one of three ways: a hash route, a sidebar tile match,
  // or a label in the list of views opened from the sidebar's popup. Anything the
  // app can navigate to has to appear as at least one of them.
  const cap = (v) => v.charAt(0).toUpperCase() + v.slice(1)
  const missed = staticViews.filter(
    (view) =>
      !smoke.includes(`#${view}`) &&
      !smoke.includes(`name: '${view}'`) &&
      !smoke.includes(`label: '${cap(view)}'`),
  )
  assert.deepEqual(missed, [], `these views are in the app and never walked: ${missed.join(', ')}`)
})

test('the run still ends with its tally line and an honest exit code', () => {
  assert.match(smoke, /checks passed/, 'the summary line exists')
  assert.match(smoke, /skipped \(\$\{skips\.map/, 'and names every skip')
  assert.match(smoke, /process\.exit\(passed === results\.length \? 0 : 1\)/, 'a FAIL is a non-zero exit')
})
