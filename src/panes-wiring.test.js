// The pane rules are pure and tested in split.test.js; the App wiring that
// uses them is a component, so this reads its source for the seams that would
// quietly stop working in a refactor: the drop moves instead of copying, the
// cap and the phone share one decision, a beat repairs a dead pane, and a
// phone never restores a stored multi-pane layout.

import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'

const source = readFileSync(new URL('./App.jsx', import.meta.url), 'utf8')

const between = (from, to) => {
  const start = source.indexOf(from)
  const end = source.indexOf(to, start + from.length)
  assert.ok(start >= 0 && end > start, `${from} .. ${to} not found in App.jsx`)
  return source.slice(start, end)
}

test('a drop moves a chat, and a drop on its own pane does nothing', () => {
  const drop = between('const panesCanSplit', '// Right-click in the main area')
  assert.match(drop, /if \(!leaf \|\| leaf\.view === id\) return/, 'the self-drop is refused before anything runs')
  assert.match(drop, /moveLeaf\(l, source\?\.id \?\? null, leafId/, 'the drop moves rather than copies')
  assert.match(drop, /!panesCanSplit/, 'and reads the split decision the tint reads')
})

test('the cap and the phone are one decision, and the pane draws from it', () => {
  assert.match(source, /const panesCanSplit = !isMobile && paneCount\(layout\) < MAX_PANES/)
  assert.match(source, /canSplit=\{panesCanSplit\}/, 'the tint and the drop cannot disagree')
})

test('a beat repairs a pane whose chat is gone', () => {
  const effect = between('const seen = seenIdsRef.current', 'const view = state.history[state.hIndex]')
  assert.match(effect, /setLayout\(\(current\) => reconcilePanes\(current, gone\)\)/)
})

test('a phone never restores a stored multi-pane layout', () => {
  const load = between('function loadLayout()', 'const isChatView')
  assert.match(load, /if \(isMobile\) return newLayout\(\)/, 'a phone starts on one pane')
  assert.match(load, /reconcilePanes\(/, 'and a restored pane holding a static page is repaired before it is drawn')
})
