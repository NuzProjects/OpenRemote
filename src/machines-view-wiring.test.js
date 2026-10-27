// The Machines list sorts whatever the daemon sent. A device row without a
// name used to take `localeCompare` down with a TypeError, and the boundary
// then showed the whole view as an error card. The fix is the same rule the
// machine picker follows, so this pins that the view uses the pair from
// shape.js rather than a second convention of its own.

import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'

const view = readFileSync(new URL('./MachinesView.jsx', import.meta.url), 'utf8')

test('the machines list takes its rows and names through shape.js', () => {
  assert.match(view, /import \{ list as asList, text \} from '\.\/shape\.js'/)
  assert.match(view, /const list = asList\(devices\)\.sort\(/)
  assert.match(view, /text\(a\.name\)\.localeCompare\(text\(b\.name\)\)/)
  // No raw list or raw name is left in the comparator.
  assert.doesNotMatch(view, /\[\.\.\.\(devices \?\? \[\]\)\]/)
  assert.doesNotMatch(view, /a\.name\.localeCompare/)
})
