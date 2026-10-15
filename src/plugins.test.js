import assert from 'node:assert/strict'
import test from 'node:test'
import {
  POWER_LABEL,
  RUNTIME_LABEL,
  STALE_MS,
  categories,
  clashes,
  entrySource,
  entryState,
  fetchedLabel,
  filterEntries,
  isStale,
  notSandboxed,
  sourceLabel,
  sourceRequest,
} from './plugins.js'

test('a plugin that runs programs itself is labelled not sandboxed', () => {
  assert.equal(notSandboxed({ runtime: 'process', powers: ['run_programs'] }), true)
  assert.equal(notSandboxed({ runtime: 'content', powers: ['run_programs'] }), true)
  // A Claude plugin of skills alone runs nothing.
  assert.equal(notSandboxed({ runtime: 'content', powers: [] }), false)
  // JS and WebAssembly are sandboxed, whatever they ask for.
  assert.equal(notSandboxed({ runtime: 'js', powers: ['run_programs', 'microphone'] }), false)
  assert.equal(notSandboxed({ runtime: 'wasm', powers: ['run_programs'] }), false)
})

test('every power and runtime the daemon names has words', () => {
  for (const p of ['run_programs', 'read_chats', 'agent_tools', 'network', 'microphone']) {
    assert.ok(POWER_LABEL[p], p)
  }
  for (const r of ['process', 'js', 'wasm', 'content']) assert.ok(RUNTIME_LABEL[r], r)
})

test('the source reads back in a line, and the dialog asks for nothing empty', () => {
  assert.equal(sourceLabel({ kind: 'git', url: 'https://x/y' }), 'Git: https://x/y')
  assert.equal(sourceLabel({ kind: 'folder', path: 'C:\\p' }), 'Folder: C:\\p')
  assert.equal(
    sourceLabel({ kind: 'marketplace', marketplace: 'team', plugin: 'fmt', from: 'github.com/a/fmt' }),
    'team: github.com/a/fmt',
  )
  assert.deepEqual(sourceRequest('archive', ' https://x/a.zip '), { kind: 'archive', location: 'https://x/a.zip' })
  assert.equal(sourceRequest('git', '   '), null)
})

test('two plugins of one name both on are a clash; one turned off is not', () => {
  const installed = [
    { id: 'toy@local', name: 'toy', enabled: true },
    { id: 'toy@team', name: 'toy', enabled: true },
    { id: 'fmt@team', name: 'fmt', enabled: true },
    { id: 'fmt@local', name: 'fmt', enabled: false },
  ]
  assert.deepEqual(clashes(installed), [{ name: 'toy', ids: ['toy@local', 'toy@team'] }])
  assert.deepEqual(clashes([]), [])
})

test('a catalog is fetched again only when it is over a day old, and only if on', () => {
  const now = 10 * STALE_MS
  assert.equal(isStale({ enabled: true, refreshed_at: null }, now), true)
  assert.equal(isStale({ enabled: true, refreshed_at: now - STALE_MS - 1 }, now), true)
  assert.equal(isStale({ enabled: true, refreshed_at: now - 1000 }, now), false)
  assert.equal(isStale({ enabled: false, refreshed_at: null }, now), false)
  assert.equal(fetchedLabel({ refreshed_at: null }, now), 'Not fetched yet')
  assert.equal(fetchedLabel({ refreshed_at: now - 5 * 60_000 }, now), 'Fetched 5 min ago')
  assert.equal(fetchedLabel({ refreshed_at: now - 3 * 3_600_000 }, now), 'Fetched 3 h ago')
})

test('Discover filters by words, category and marketplace', () => {
  const entries = [
    { name: 'linter', description: 'Lints code', category: 'development', marketplace: 'a', tags: ['ci'] },
    { name: 'notes', description: 'Keeps notes', category: 'productivity', marketplace: 'b', author: 'Ann' },
  ]
  assert.deepEqual(filterEntries(entries, { query: 'lint' }).map((e) => e.name), ['linter'])
  assert.deepEqual(filterEntries(entries, { query: 'ci code' }).map((e) => e.name), ['linter'])
  assert.deepEqual(filterEntries(entries, { query: 'ann' }).map((e) => e.name), ['notes'])
  assert.deepEqual(filterEntries(entries, { category: 'productivity' }).map((e) => e.name), ['notes'])
  assert.deepEqual(filterEntries(entries, { marketplace: 'a' }).map((e) => e.name), ['linter'])
  assert.equal(filterEntries(entries).length, 2)
  assert.deepEqual(categories(entries), ['development', 'productivity'])
})

test('an entry installs by its marketplace and name, a command only once approved', () => {
  const entry = { name: 'gen', marketplace: 'team' }
  assert.deepEqual(entrySource(entry), { kind: 'marketplace', marketplace: 'team', plugin: 'gen' })
  assert.deepEqual(entrySource(entry, 'tool path'), {
    kind: 'marketplace',
    marketplace: 'team',
    plugin: 'gen',
    approve_command: 'tool path',
  })
  assert.equal(entryState({ installable: false }), 'unavailable')
  assert.equal(entryState({ installable: true, installed: null }), 'available')
  assert.equal(entryState({ installable: true, installed: {}, update: false }), 'installed')
  assert.equal(entryState({ installable: true, installed: {}, update: true }), 'update')
})
