// What a chat's harness reported changing, folded into files.
//
// The transcript already draws a good split diff inside each tool card
// (diff.js owns that shape). This module keeps the file-level view the
// transcript throws away: which files the harness touched across every
// turn of one chat, what happened to each, and how much of it.
//
// It is deliberately not a git status. Every number here is lines as the
// harness reported them in its tool input, so an edit the harness reported
// as a replacement counts its whole replaced block, and a harness whose
// edits arrive in a shape this module does not recognise contributes
// nothing rather than a guess. The surface that renders this must say so.

import { editRows, isFileEdit } from './diff.js'

// One file, one row. A chat in one workspace usually spells a path one
// way, but a harness may switch between separators mid-run (a tool that
// echoes the path it was given, another that normalises it), so the group
// key folds separators and a leading `./` while the row keeps the first
// spelling the harness used. Case is left alone: on a case-sensitive
// machine two files really can differ by case, and merging them would be a
// lie about the user's disk.
export function pathKey(path) {
  return String(path)
    .replace(/\\/g, '/')
    .replace(/\/{2,}/g, '/')
    .replace(/^\.\//, '')
}

/// The op word for one harness report, or null when the report is not a
/// file edit this module can read.
///
/// The two edit shapes are `diff.js`'s own rule (`isFileEdit`), so the
/// transcript and this fold never disagree about what counts as an edit.
/// The third shape is the one `isFileEdit` leaves out on purpose: the card
/// cannot draw an Edit whose new text is empty, but a review surface can
/// still say the file was emptied, so it is named here rather than
/// invented twice. It needs both sides present and the new one empty: a
/// report carrying only an old string is an incomplete input, not a delete.
export function editOp(input) {
  if (!input || typeof input !== 'object') return null
  if (isFileEdit(input)) {
    // A whole-file write carries the file's text; a replacement carries
    // both sides. A write that also names an old string is still a write:
    // the input it takes to the harness is the content.
    return typeof input.content === 'string' ? 'added' : 'edited'
  }
  const path = typeof input.file_path === 'string' ? input.file_path : ''
  const old = typeof input.old_string === 'string' ? input.old_string : ''
  const removed = input.new_string
  if (path && old.length > 0 && typeof removed === 'string' && removed.length === 0) return 'deleted'
  return null
}

/// The lines one reported string holds. A trailing newline ends the last
/// line rather than adding an empty one, which is why this is not a bare
/// `split('\n')`: a file written with a final newline would otherwise show
/// a blank green row and count one line too many.
function lines(text) {
  const src = String(text ?? '')
  return (src.endsWith('\n') ? src.slice(0, -1) : src).split('\n')
}

/// The rows one report draws, plus what it added and removed.
function part(input, op) {
  if (op === 'added') {
    const rows = lines(input.content).map((text) => ({
      left: { text: '', kind: null },
      right: { text, kind: 'add' },
    }))
    return { op, rows, addedLines: rows.length, removedLines: 0, hunks: 1 }
  }
  if (op === 'deleted') {
    // The whole removed block is the left side; nothing replaces it.
    const rows = lines(input.old_string).map((text) => ({
      left: { text, kind: 'del' },
      right: { text: '', kind: null },
    }))
    return { op, rows, addedLines: 0, removedLines: rows.length, hunks: 1 }
  }
  // An edit: the same rows the card draws, counted as the card would show
  // them. `editRows` pairs one contiguous changed block, so the block is
  // one hunk however many lines it holds.
  const rows = editRows(input.old_string, input.new_string)
  let addedLines = 0
  let removedLines = 0
  for (const row of rows) {
    if (row.left.kind === 'del') removedLines += 1
    if (row.right.kind === 'add') addedLines += 1
  }
  const changed = addedLines > 0 || removedLines > 0
  return { op, rows, addedLines, removedLines, hunks: changed ? 1 : 0 }
}

/// The status of one report, as the console already tracks it: a tool call
/// that errored failed, one whose result has not landed is in flight, and
/// anything else is what the transcript shows as done.
function reportStatus(item) {
  if (item.state === 'failed') return 'failed'
  if (item.result == null) return 'running'
  return 'ok'
}

/// Whether a chat has anything at all to review, for a caller that wants
/// the yes or no and would pay for a whole fold otherwise (the command
/// palette asks on every stream beat). Same rule as the fold, and it stops
/// at the first report rather than building rows nobody reads.
export function hasFileChanges(items) {
  if (!Array.isArray(items)) return false
  for (const item of items) {
    if (!item || item.kind !== 'tool' || !item.input) continue
    if (editOp(item.input)) return true
  }
  return false
}

/// Fold a chat's items into the files a harness reported changing.
///
/// Returns `{ files, totals, empty }` where `empty` is null when there is
/// something to review and otherwise names why there is not:
///
///   * `'no-transcript'` - the chat has no items in memory at all. That is
///     either a chat that has not started or one whose transcript has not
///     streamed into this window yet, and this module cannot tell those
///     apart. The surface says both rather than claiming "no changes".
///   * `'no-edit'` - the transcript is here and holds no file edit, which
///     is a true answer about this chat.
///
/// Files come back in path order so the list does not reshuffle itself
/// while a turn streams. Each file's `op` says what happened to the file
/// rather than to its latest report: created anywhere in the chat and never
/// removed reads `'added'`; removed at any point reads `'deleted'`; the
/// rest read `'edited'`. A reviewer acts on the file's state, and a file
/// created and then edited is still a file this chat created.
export function fileChanges(items) {
  const list = Array.isArray(items) ? items : []
  const byKey = new Map()
  for (const item of list) {
    if (!item || item.kind !== 'tool' || !item.input) continue
    const op = editOp(item.input)
    if (!op) continue
    const key = pathKey(item.input.file_path)
    const status = reportStatus(item)
    let file = byKey.get(key)
    if (!file) {
      file = {
        key,
        path: String(item.input.file_path),
        added: false,
        deleted: false,
        edits: 0,
        hunks: 0,
        addedLines: 0,
        removedLines: 0,
        status,
        parts: [],
      }
      byKey.set(key, file)
    }
    const drawn = part(item.input, op)
    file.edits += 1
    file.hunks += drawn.hunks
    file.addedLines += drawn.addedLines
    file.removedLines += drawn.removedLines
    file.parts.push(drawn)
    // The file's state is its last report's: an edit that landed and one
    // that errored leave different files behind.
    file.status = status
    // Whether the file exists at the end, and how it got there: a write
    // brings it into existence (again), a delete takes it away, and an
    // edit says nothing about existence either way.
    if (op === 'added') {
      file.added = true
      file.deleted = false
    } else if (op === 'deleted') {
      file.deleted = true
      file.added = false
    }
  }
  const files = [...byKey.values()]
    .map((file) => ({
      key: file.key,
      path: file.path,
      op: file.deleted ? 'deleted' : file.added ? 'added' : 'edited',
      edits: file.edits,
      hunks: file.hunks,
      addedLines: file.addedLines,
      removedLines: file.removedLines,
      status: file.status,
      parts: file.parts,
    }))
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
  const totals = { files: files.length, edits: 0, hunks: 0, addedLines: 0, removedLines: 0, added: 0, edited: 0, deleted: 0 }
  for (const file of files) {
    totals.edits += file.edits
    totals.hunks += file.hunks
    totals.addedLines += file.addedLines
    totals.removedLines += file.removedLines
    totals[file.op] += 1
  }
  const empty = files.length > 0 ? null : list.length === 0 ? 'no-transcript' : 'no-edit'
  return { files, totals, empty }
}
