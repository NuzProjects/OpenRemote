// "Since your last look" is a page inside the palette, and it is built on two
// modules that were already there: unread.js says what has been seen and how a
// look is recorded, since-last-look.js says which chats that leaves and what
// each row reads. This reads the palette to prove it uses both rather than
// keeping a second mark of its own.

import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'

const palette = readFileSync(new URL('./CommandPalette.jsx', import.meta.url), 'utf8')

test('the palette renders the page from the two modules, not from its own rules', () => {
  assert.ok(palette.includes("from './since-last-look.js'"), 'the page rules are the module\'s')
  assert.ok(palette.includes("from './unread.js'"), 'and the mark is the unread module\'s')
  assert.ok(
    palette.includes('recordSeen(seen, r.sinceChat.id, r.sinceChat.stamp)'),
    'a look is recorded with the module\'s own rule',
  )
  assert.ok(palette.includes('storeSeen(next)'), 'and stored where the sidebar will find it')
})

test('the page is offered only while something moved, and it is a page', () => {
  assert.ok(palette.includes("name: 'Since your last look'"), 'the row exists')
  assert.ok(palette.includes('moved.length'), 'and only while the module leaves something in it')
  assert.ok(palette.includes("setPage('since')"), 'choosing it opens a page rather than closing')
  assert.ok(palette.includes("if (page === 'since')"), 'and the page has its own list')
})

test('a row says what happened last, and when, and opens the chat', () => {
  assert.ok(palette.includes('whatHappened(row.status)'), 'the sentence is the module\'s')
  assert.ok(palette.includes('whenLabel(row.updatedAt)'), 'the time is the console\'s format')
  assert.ok(palette.includes('onOpenChat(r.sinceChat.id)'), 'and the row opens the chat it names')
})

test('the header names the count in words', () => {
  assert.ok(palette.includes('movedLine(moved.length)'), 'the page header is the count sentence')
})

test('marking everything read acts on the page\'s own list and answers in one sentence', () => {
  assert.ok(palette.includes("name: 'Mark everything as read'"), 'the row exists')
  assert.ok(palette.includes('markAllSeen(moveRows, seen)'), 'with the rules\' own pass, over the same rows')
  assert.ok(palette.includes('if (count > 0)'), 'nothing is stored when nothing was recorded')
  assert.ok(palette.includes("setPage('caught-up')"), 'and the answer is a page, not a silent close')
  assert.ok(palette.includes('All caught up.'), 'saying the sentence it was asked to say')
  // The row lives inside the same guard as the page: nothing unread, no row.
  const guard = palette.indexOf('const sinceRow = moved.length')
  const mark = palette.indexOf("name: 'Mark everything as read'")
  assert.ok(guard >= 0 && mark > guard, 'offered only while something is unread')
})
