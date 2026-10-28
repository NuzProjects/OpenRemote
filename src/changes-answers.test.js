// The two answers the changes surface could not give: an edit it could not read, and a
// headline that counted lines which never reached the disk.
import test from 'node:test'
import assert from 'node:assert/strict'

import { fileChanges } from './changes.js'

// The fold reads the tool's own report: `state: 'failed'` is a report that failed,
// `result: null` is one still in flight, and a result is one that landed.
const edit = (filePath, { oldString = 'a', newString = 'b', result = { ok: true }, state } = {}) => ({
  kind: 'tool',
  name: 'Edit',
  state,
  result,
  input: { file_path: filePath, old_string: oldString, new_string: newString },
})

test('a report it cannot read is counted, not dropped', () => {
  // An edit whose input carries a path and one truncated string names a file and folds
  // to nothing. The surface used to answer "no file changes", the opposite of what the
  // harness reported.
  const unreadable = { kind: 'tool', name: 'Edit', input: { file_path: 'src/a.js', content_truncated: 'x' } }
  const folded = fileChanges([unreadable])
  assert.equal(folded.files.length, 0)
  assert.equal(folded.unread, 1)
  assert.equal(folded.empty, 'no-edit')
  // A transcript with no tool items at all is still the other answer.
  assert.equal(fileChanges([]).unread, 0)
  assert.equal(fileChanges([{ kind: 'text', input: null }]).unread, 0)
})

test('the headline counts what landed, and names the rest aside', () => {
  const ok = edit('src/a.js')
  const failed = edit('src/b.js', { oldString: 'x\ny', newString: 'x\ny\nz', state: 'failed' })
  const folded = fileChanges([ok, failed])
  assert.equal(folded.totals.files, 2)
  // The landed report's lines are in the headline; the failed one is counted aside.
  assert.ok(folded.totals.addedLines > 0, `landed lines in the headline (${folded.totals.addedLines})`)
  assert.equal(folded.unlandedEdits, 1, 'the failed report is named')
  assert.ok(folded.unlandedLines > 0, `and its lines counted aside (${folded.unlandedLines})`)
  const landed = fileChanges([ok])
  assert.equal(landed.unlandedEdits, 0)
  assert.equal(landed.unlandedLines, 0)
})
