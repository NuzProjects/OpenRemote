// Since you last looked: the record per chat, what counts as moved, the
// quiet mark's rules, and the sidebar wiring that applies them. The unit
// half runs on plain objects; the wiring half reads the two source files,
// the style this repo uses for a surface with no renderer.

import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'

const store = new Map()
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
  clear: () => store.clear(),
}

const {
  BUSY_STATUSES,
  SEEN_CAP,
  activityAt,
  isBusy,
  isUnread,
  listHasUnread,
  loadSeen,
  normalizeSeen,
  recordSeen,
  seedSeen,
  storeSeen,
  unreadIds,
} = await import('./unread.js')

const row = (over = {}) => ({ id: 'chat-1', status: 'idle', updatedAt: 200, ...over })

test('a chat that moved after the last look is unread; one that did not is not', () => {
  assert.equal(isUnread({ 'chat-1': 100 }, row()), true)
  assert.equal(isUnread({ 'chat-1': 200 }, row()), false)
  assert.equal(isUnread({ 'chat-1': 300 }, row()), false)
})

test('a chat with no record is not marked: first sight is not news', () => {
  assert.equal(isUnread({}, row()), false)
  assert.equal(isUnread({ 'chat-1': undefined }, row()), false)
})

test('a chat mid-turn is not marked: nothing has arrived to read yet', () => {
  for (const status of BUSY_STATUSES) {
    assert.equal(isBusy(row({ status })), true)
    assert.equal(isUnread({ 'chat-1': 1 }, row({ status })), false)
  }
  // A waiting harness has produced the thing to read, and a failed turn is
  // news too: both mark when they moved.
  assert.equal(isUnread({ 'chat-1': 1 }, row({ status: 'waiting' })), true)
  assert.equal(isUnread({ 'chat-1': 1 }, row({ status: 'failed' })), true)
})

test('the polled status counts too, when the live one is not there', () => {
  assert.equal(isUnread({ 'chat-1': 1 }, row({ status: undefined, polledStatus: 'running' })), false)
  assert.equal(isUnread({ 'chat-1': 1 }, row({ status: undefined, polledStatus: 'waiting' })), true)
})

test('a poll-only mid-turn chat is not marked, though the sidebar calls a missing live status idle', () => {
  // The row Sidebar.jsx actually builds: liveStatus null until the chat has a
  // record, status that null filled in as 'idle', and the poll's own word for
  // what the harness is doing. Reading status before the poll sees 'idle' and
  // marks a turn that has not finished, on the first paint after a load.
  const working = row({ liveStatus: null, status: 'idle', polledStatus: 'running', updatedAt: 200 })
  assert.equal(isBusy(working), true, 'the poll says the harness is mid-turn')
  assert.equal(isUnread({ 'chat-1': 1 }, working), false, 'so nothing has arrived to read yet')
  // The same row, waiting: the question has arrived, so the move marks.
  const waiting = row({ liveStatus: null, status: 'idle', polledStatus: 'waiting', updatedAt: 200 })
  assert.equal(isBusy(waiting), false)
  assert.equal(isUnread({ 'chat-1': 1 }, waiting), true)
})

test('a row with no activity stamp, or no id, is never marked', () => {
  assert.equal(isUnread({ 'chat-1': 1 }, row({ updatedAt: 0 })), false)
  assert.equal(isUnread({ 'chat-1': 1 }, row({ updatedAt: undefined })), false)
  assert.equal(isUnread({ 'chat-1': 1 }, row({ id: null })), false)
  assert.equal(activityAt({ updatedAt: 'later' }), 0)
})

test('first sight seeds a record, and only for chats that have none', () => {
  const first = seedSeen({}, [row({ id: 'a', updatedAt: 500 }), row({ id: 'b', updatedAt: 700 })])
  assert.deepEqual(first, { a: 500, b: 700 })
  // An existing record is not touched: that is the whole point of a record.
  const kept = seedSeen({ a: 100 }, [row({ id: 'a', updatedAt: 500 })])
  assert.deepEqual(kept, { a: 100 })
  // Nothing to add returns the same map, so the caller can skip a write.
  const seen = { a: 100 }
  assert.equal(seedSeen(seen, [row({ id: 'a', updatedAt: 500 })]), seen)
})

test('seeding a backlog leaves nothing unread', () => {
  const rows = [row({ id: 'a', updatedAt: 10 }), row({ id: 'b', updatedAt: 20 })]
  const seen = seedSeen({}, rows)
  assert.equal(unreadIds(seen, rows).size, 0)
  // ...and the same rows moving afterwards are unread.
  const moved = [row({ id: 'a', updatedAt: 11 }), row({ id: 'b', updatedAt: 20 })]
  assert.deepEqual([...unreadIds(seen, moved)], ['a'])
})

test('a look records the stamp it showed and never moves it backwards', () => {
  const one = recordSeen({}, 'chat-1', 200)
  assert.deepEqual(one, { 'chat-1': 200 })
  assert.equal(recordSeen(one, 'chat-1', 100), one, 'a stale window cannot un-read')
  assert.equal(recordSeen(one, 'chat-1', 200), one, 'nothing new, nothing written')
  assert.deepEqual(recordSeen(one, 'chat-1', 300), { 'chat-1': 300 })
  assert.equal(recordSeen(one, null, 300), one)
  assert.equal(recordSeen(one, 'chat-1', Number.NaN), one)
})

test('a chat deleted and recreated reads as new: its record belonged to the old id', () => {
  const seen = { 'chat-old': 1000 }
  const recreated = row({ id: 'chat-new', updatedAt: 1000 })
  assert.equal(isUnread(seen, recreated), false)
  assert.deepEqual(seedSeen(seen, [recreated]), { 'chat-old': 1000, 'chat-new': 1000 })
})

test('a damaged stored value reads as no records and never throws', () => {
  for (const raw of ['{not json', '["a"]', '"a string"', '42', 'null']) {
    localStorage.clear()
    localStorage.setItem('openremote-chat-seen', raw)
    assert.deepEqual(loadSeen(), {}, raw)
  }
})

test('stored junk entries are dropped and the newest keep their place', () => {
  assert.deepEqual(normalizeSeen({ a: 1, b: 'soon', c: Number.NaN, d: -5, e: 0, '': 9 }), { a: 1 })
  const many = Object.fromEntries(Array.from({ length: SEEN_CAP + 5 }, (_, i) => [`c${i}`, i + 1]))
  const kept = normalizeSeen(many)
  assert.equal(Object.keys(kept).length, SEEN_CAP)
  assert.ok(kept[`c${SEEN_CAP + 4}`], 'the newest stamp is kept')
  assert.equal(kept.c0, undefined, 'the oldest is the one dropped')
})

test('the records round-trip through their own key', () => {
  localStorage.clear()
  const seen = storeSeen({ 'chat-1': 1234 })
  assert.deepEqual(seen, { 'chat-1': 1234 })
  assert.ok(localStorage.getItem('openremote-chat-seen'))
  assert.deepEqual(loadSeen(), { 'chat-1': 1234 })
})

test('a list says it holds something unread, without a count', () => {
  const unread = new Set(['b'])
  assert.equal(listHasUnread([row({ id: 'a' }), row({ id: 'b' })], unread), true)
  assert.equal(listHasUnread([row({ id: 'a' })], unread), false)
  assert.equal(listHasUnread([], unread), false)
  assert.equal(listHasUnread(null, unread), false)
  assert.equal(listHasUnread([row({ id: 'b' })], null), false)
})

// ---- the sidebar wiring ----

const sidebar = readFileSync(new URL('./Sidebar.jsx', import.meta.url), 'utf8')
const css = readFileSync(new URL('./sidebar.css', import.meta.url), 'utf8')

test('the sidebar reads and writes the records through the module', () => {
  assert.match(sidebar, /from '\.\/unread\.js'/)
  assert.match(sidebar, /useState\(\(\) => loadSeen\(\)\)/)
  assert.match(sidebar, /remember\(seedSeen\(seenRef\.current, rows\)\)/)
  assert.match(sidebar, /remember\(recordSeen\(seenRef\.current, row\.id, row\.updatedAt\)\)/)
})

test('looking at a chat marks it read only while the window is being looked at', () => {
  assert.match(sidebar, /if \(!watched \|\| !active\) return/)
  assert.match(sidebar, /const unread = useMemo\(\(\) => unreadIds\(seen, rows\), \[seen, rows\]\)/)
})

test('the mark is on the row, and the list heads carry their own', () => {
  assert.match(sidebar, /data-unread=\{unread\.has\(row\.id\) \? 'true' : undefined\}/)
  assert.match(sidebar, /data-unread=\{unreadIn\.has\(project\.id\) \? 'true' : undefined\}/)
  assert.match(sidebar, /data-unread=\{listHasUnread\(grouped\.flat, unread\) \? 'true' : undefined\}/)
})

test('ordering never consults the mark', () => {
  // The one sort that orders the list stays keyed on activity.
  assert.match(sidebar, /\.sort\(\(a, b\) => b\.updatedAt - a\.updatedAt\)/)
  assert.doesNotMatch(sidebar, /\.sort\([\s\S]{0,160}unread/)
  assert.doesNotMatch(sidebar, /unread[^)]*\.sort\(/)
})

test('the mark is one tint step below hover, and waiting keeps the amber dot', () => {
  const unreadRule = css.slice(css.indexOf(".chat-row[data-unread='true']"), css.indexOf('.chat-row:hover'))
  assert.match(unreadRule, /background: rgba\(255, 255, 255, 0\.03\)/)
  // The tint rule comes before hover, so hover and active still win.
  assert.ok(css.indexOf(".chat-row[data-unread='true']") < css.indexOf('.chat-row:hover'))
  // The status column is untouched: waiting is still the amber accent.
  assert.match(css, /\.dot--waiting \{\s*\r?\n\s*background: var\(--accent\)/)
  // And the list mark is a text tier, not a colour.
  assert.match(css, /\.project-head\[data-unread='true'\][\s\S]{0,120}color: var\(--text-1\)/)
})
