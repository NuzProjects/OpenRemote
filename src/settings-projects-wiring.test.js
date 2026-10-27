// Removing a registered project from Settings used to take one click, on a
// chip two pixels from a neighbour chip, with no undo and no second question.
// It asks once now, through the same armed-row rules the sidebar and the panes
// use, and the row's own sentence says what the removal does and does not
// touch. The view is JSX, so this reads it rather than rendering it.

import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'

const source = readFileSync(new URL('./SettingsView.jsx', import.meta.url), 'utf8')

test('the project chip arms the row instead of removing it', () => {
  assert.ok(
    source.includes("from './row-confirm.js'"),
    'the settings row uses the shared armed-row rules',
  )
  assert.ok(
    source.includes('armRow(current, p.id)'),
    'the first press arms the project it names',
  )
  const chip = source.indexOf('armRow(current, p.id)')
  const block = source.slice(Math.max(0, chip - 600), chip)
  assert.equal(
    /onClick=\{\(\) => removeProject\(/.test(source),
    false,
    'no click removes a project outright any more',
  )
  assert.ok(block.length > 0, 'the arm handler lives in the project chip')
})

test('the confirm says what it does and what it leaves alone', () => {
  assert.ok(source.includes('Remove it'), 'the second press has its own word')
  assert.ok(source.includes('pn-btn--danger'), 'and wears the console\'s one destructive style')
  assert.ok(source.includes('Keep'), 'and there is a way out that is not Escape')
  assert.ok(
    source.includes('The project goes; its chats move to Chats and the folder on disk is never touched.'),
    'the sentence names both halves, in the row that asks',
  )
})
