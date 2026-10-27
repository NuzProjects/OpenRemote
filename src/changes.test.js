// The review surface's spine: what a chat's tool items say the harness
// changed. Every rule here is a promise the modal keeps on screen, so each
// one is pinned by its own case rather than by one happy-path list.

import assert from 'node:assert/strict'
import test from 'node:test'
import { editOp, fileChanges, hasFileChanges, pathKey } from './changes.js'

// One tool item as the reducer folds it (state/reducer.js): the name, the
// harness's input, and the result once it lands.
const tool = (input, extra = {}) => ({ kind: 'tool', name: 'Edit', input, result: 'ok', state: 'ok', ...extra })
const edit = (path, oldString, newString, extra) =>
  tool({ file_path: path, old_string: oldString, new_string: newString }, extra)
const write = (path, content, extra) => tool({ file_path: path, content }, extra)

test('a replacement is an edit, a whole-file write is an add, an emptied file is a delete', () => {
  assert.equal(editOp({ file_path: 'a.ts', old_string: 'one', new_string: 'two' }), 'edited')
  assert.equal(editOp({ file_path: 'a.ts', content: 'hello' }), 'added')
  assert.equal(editOp({ file_path: 'a.ts', old_string: 'one', new_string: '' }), 'deleted')
})

test('a report that is not a file edit is not counted at all', () => {
  // A command run, a search, a read: real tool calls, none of them a change.
  assert.equal(editOp({ command: 'npm test' }), null)
  assert.equal(editOp({ file_path: 'a.ts', old_string: 'one' }), null)
  assert.equal(editOp({ file_path: 'a.ts', content: '' }), null)
  assert.equal(editOp({ old_string: 'one', new_string: 'two' }), null)
  assert.equal(editOp(null), null)
  assert.equal(editOp('a.ts'), null)
  // The write shape wins when an input somehow carries both sides: the
  // content is what the harness would write.
  assert.equal(editOp({ file_path: 'a.ts', content: 'x', old_string: 'y', new_string: 'z' }), 'added')
})

test('a whole-file write counts its lines, and a final newline is not a line', () => {
  const { files, totals } = fileChanges([write('notes.md', '# Notes\n\n- first\n')])
  assert.equal(files.length, 1)
  assert.equal(files[0].op, 'added')
  assert.equal(files[0].addedLines, 3)
  assert.equal(files[0].removedLines, 0)
  assert.equal(files[0].hunks, 1)
  assert.deepEqual(
    files[0].parts[0].rows.map((row) => row.right.text),
    ['# Notes', '', '- first'],
    'no blank row for the trailing newline',
  )
  assert.equal(totals.addedLines, 3)
})

test('an edit counts the changed block as one hunk, with both sides counted', () => {
  const before = 'const a = 1\nconst b = 2\nconst c = 3\nconst d = 4'
  const after = 'const a = 1\nconst b = 20\nconst c = 30\nconst d = 4'
  const { files, totals } = fileChanges([edit('src/math.ts', before, after)])
  assert.equal(files[0].op, 'edited')
  assert.equal(files[0].hunks, 1, 'one contiguous block is one hunk however many lines it holds')
  assert.equal(files[0].addedLines, 2)
  assert.equal(files[0].removedLines, 2)
  assert.equal(totals.hunks, 1)
})

test('an insert and a pure removal inside an edit still count their lines', () => {
  const inserted = fileChanges([edit('a.ts', 'one\nthree', 'one\ntwo\nthree')])
  assert.equal(inserted.files[0].addedLines, 1)
  assert.equal(inserted.files[0].removedLines, 0)

  const removed = fileChanges([edit('a.ts', 'one\ntwo\nthree', 'one\nthree')])
  assert.equal(removed.files[0].addedLines, 0)
  assert.equal(removed.files[0].removedLines, 1)
})

test('an edit that changes nothing is still a report, with no hunk', () => {
  // Some harnesses re-write a string with the same content; the card draws
  // no changed row, so the count says zero rather than inventing one.
  const { files, totals } = fileChanges([edit('a.ts', 'same', 'same')])
  assert.equal(files[0].op, 'edited')
  assert.equal(files[0].hunks, 0)
  assert.equal(totals.hunks, 0)
  assert.equal(totals.addedLines + totals.removedLines, 0)
})

test('a file emptied by an edit reads deleted and counts the lines it lost', () => {
  const { files, totals } = fileChanges([edit('src/old.ts', 'line one\nline two\n', '')])
  assert.equal(files[0].op, 'deleted')
  assert.equal(files[0].removedLines, 2)
  assert.equal(files[0].addedLines, 0)
  assert.equal(totals.deleted, 1)
})

test('the same file reported across turns is one row, edits and lines summed', () => {
  const { files, totals } = fileChanges([
    edit('src/app.tsx', 'a', 'b'),
    tool({ command: 'npm test' }),
    edit('src/app.tsx', 'c', 'd', { name: 'Edit' }),
  ])
  assert.equal(files.length, 1)
  assert.equal(files[0].edits, 2)
  assert.equal(files[0].hunks, 2, 'two reports are two hunks')
  assert.equal(files[0].addedLines, 2)
  assert.equal(files[0].removedLines, 2)
  assert.deepEqual(
    files[0].parts.map((p) => p.op),
    ['edited', 'edited'],
    'the parts stay in the order the harness reported them',
  )
  assert.equal(totals.edits, 2)
})

test('separator spellings of one path are one row, keeping the first spelling', () => {
  const { files } = fileChanges([
    write('C:\\repo\\src\\a.ts', 'x'),
    edit('C:/repo/src/a.ts', 'x', 'y'),
    edit('./C:/repo/src/a.ts', 'y', 'z'),
  ])
  assert.equal(files.length, 1, 'a harness that switches separators did not touch three files')
  assert.equal(files[0].path, 'C:\\repo\\src\\a.ts', 'the row shows the harness spelling it saw first')
  assert.equal(files[0].key, 'C:/repo/src/a.ts')
  assert.equal(files[0].edits, 3)
})

test('case is not folded: two spellings may be two real files', () => {
  // A case-sensitive machine can hold A.ts and a.ts at once, so merging
  // them would claim a change the user's disk does not have.
  const { files } = fileChanges([write('src/A.ts', 'x'), write('src/a.ts', 'y')])
  assert.equal(files.length, 2)
  assert.deepEqual(files.map((f) => f.path), ['src/A.ts', 'src/a.ts'])
})

test('pathKey folds separators and a leading dot slash, and nothing else', () => {
  assert.equal(pathKey('a\\b\\c.ts'), 'a/b/c.ts')
  assert.equal(pathKey('./a/b.ts'), 'a/b.ts')
  assert.equal(pathKey('a//b.ts'), 'a/b.ts')
  assert.equal(pathKey('a b/c.d.ts'), 'a b/c.d.ts')
})

test('files come back in path order, not in the order they were touched', () => {
  const { files } = fileChanges([write('src/zebra.ts', 'z'), write('src/apple.ts', 'a'), write('docs/guide.md', 'g')])
  assert.deepEqual(files.map((f) => f.key), ['docs/guide.md', 'src/apple.ts', 'src/zebra.ts'])
})

test('a file created and then removed reads deleted; one created and edited reads added', () => {
  const created = fileChanges([write('new.ts', 'x'), edit('new.ts', 'x', 'y')])
  assert.equal(created.files[0].op, 'added', 'the chat created this file')

  const gone = fileChanges([write('new.ts', 'x'), edit('new.ts', 'x', '')])
  assert.equal(gone.files[0].op, 'deleted', 'it is not there at the end')
  assert.equal(gone.totals.added, 0)
  assert.equal(gone.totals.deleted, 1)
})

test('a report carrying only one side of an edit is not a change at all', () => {
  assert.equal(editOp({ file_path: 'a.ts', old_string: 'one' }), null, 'a missing new side is an incomplete input, not a delete')
  assert.equal(editOp({ file_path: 'a.ts', new_string: 'two' }), null)
})

test('a file removed and then written again reads added, because the write brought it back', () => {
  const { files } = fileChanges([edit('a.ts', 'one', ''), write('a.ts', 'two')])
  assert.equal(files[0].op, 'added')
  assert.equal(files[0].edits, 2)
})

test('the file status is its last report: failed, running, or ok', () => {
  const failed = fileChanges([
    edit('a.ts', 'one', 'two'),
    edit('a.ts', 'two', 'three', { state: 'failed', result: 'boom' }),
  ])
  assert.equal(failed.files[0].status, 'failed')

  const running = fileChanges([edit('a.ts', 'one', 'two'), edit('a.ts', 'two', 'three', { result: null })])
  assert.equal(running.files[0].status, 'running')

  const ok = fileChanges([edit('a.ts', 'one', 'two', { state: 'failed', result: 'boom' }), edit('a.ts', 'two', 'three')])
  assert.equal(ok.files[0].status, 'ok', 'a later success settles the file')
})

test('items that are not tools are ignored, whatever they carry', () => {
  const { files, empty } = fileChanges([
    { kind: 'message', role: 'user', text: 'please edit a.ts' },
    { kind: 'reasoning', text: 'thinking about a.ts' },
    { kind: 'note', text: 'a note' },
    { kind: 'decision', input: { file_path: 'a.ts', content: 'x' } },
    null,
    undefined,
  ])
  assert.deepEqual(files, [])
  assert.equal(empty, 'no-edit', 'the transcript is here, it just holds no edit')
})

test('an empty chat gets an empty answer, not a zeroed file list', () => {
  for (const items of [[], null, undefined]) {
    const answer = fileChanges(items)
    assert.deepEqual(answer.files, [])
    assert.equal(answer.empty, 'no-transcript', 'nothing in memory yet, which may mean nothing loaded')
    assert.equal(answer.totals.files, 0)
    assert.equal(answer.totals.edits, 0)
    assert.equal(answer.totals.addedLines, 0)
    assert.equal(answer.totals.removedLines, 0)
    assert.equal(answer.totals.added + answer.totals.edited + answer.totals.deleted, 0)
  }
})

test('a chat whose transcript holds only tools gets a true "no edits" answer', () => {
  const answer = fileChanges([tool({ command: 'ls' }), tool({ query: 'TODO' })])
  assert.equal(answer.empty, 'no-edit')
  assert.equal(answer.totals.files, 0)
})

test('the yes-or-no question the palette asks agrees with the fold', () => {
  // The palette needs a boolean and nothing else; it must never answer
  // "no" for a chat the fold would show files for, or the way in vanishes.
  const cases = [
    [],
    [tool({ command: 'npm test' })],
    [edit('a.ts', 'one', 'two')],
    [write('b.ts', 'x')],
    [edit('c.ts', 'gone', '')],
    [null, { kind: 'message' }, edit('d.ts', 'y', 'z')],
  ]
  for (const items of cases) {
    assert.equal(
      hasFileChanges(items),
      fileChanges(items).files.length > 0,
      `agrees on ${JSON.stringify(items?.length ?? items)}`,
    )
  }
  assert.equal(hasFileChanges(null), false)
  assert.equal(hasFileChanges(undefined), false)
})

test('totals agree with the rows they summarise', () => {
  const answer = fileChanges([
    write('src/new.ts', 'a\nb\n'),
    edit('src/app.ts', 'one\ntwo', 'one\nthree'),
    edit('docs/README.md', 'gone', ''),
    tool({ command: 'npm test' }),
  ])
  const { totals, files } = answer
  assert.equal(totals.files, 3)
  assert.equal(totals.files, files.length)
  assert.equal(totals.edits, 3)
  assert.equal(totals.hunks, 3)
  assert.equal(totals.added, 1)
  assert.equal(totals.edited, 1)
  assert.equal(totals.deleted, 1)
  assert.equal(
    totals.addedLines,
    files.reduce((sum, file) => sum + file.addedLines, 0),
  )
  assert.equal(
    totals.removedLines,
    files.reduce((sum, file) => sum + file.removedLines, 0),
  )
  assert.equal(answer.empty, null)
})
