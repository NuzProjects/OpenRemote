// The drag's rule lives in split.js and is tested there (one commit per
// gesture, paint on every move). This reads the pane component for the half
// a unit test cannot see: that the move handler paints and does not commit,
// and that setLayout appears exactly once in the gesture.

import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'

const source = readFileSync(new URL('./SplitArea.jsx', import.meta.url), 'utf8')

const startDrag = source.slice(
  source.indexOf('const startDrag'),
  source.indexOf('return (', source.indexOf('const startDrag')),
)

test('a divider drag commits the layout once, on release', () => {
  assert.equal(
    (startDrag.match(/setLayout\(/g) ?? []).length,
    1,
    'a second commit in the gesture is the pointer-rate re-render this fix removed',
  )
  assert.match(startDrag, /if \(delta !== 0\) setLayout/, 'and only when the strip actually moved')
  assert.match(startDrag, /drag\.release\(\)/, 'the committed delta is the whole gesture')
})

test('while the pointer moves, the strip is repainted without a commit', () => {
  assert.match(startDrag, /style\.flex/, 'the two cells are painted in place')
  assert.match(startDrag, /cells\[index\]\.style\.flex/)
  assert.match(startDrag, /cells\[index \+ 1\]\.style\.flex/)
})
