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
  groupEntriesByCategory,
  isStale,
  notSandboxed,
  pluginInitials,
  resolvePluginBrand,
  searchEntries,
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

test('pluginInitials derives 1-2 uppercase characters or PL fallback', () => {
  assert.equal(pluginInitials('42crunch-api'), '42')
  assert.equal(pluginInitials('agent-sdk'), 'AS')
  assert.equal(pluginInitials('docker'), 'DO')
  assert.equal(pluginInitials(''), 'PL')
  assert.equal(pluginInitials('!!!'), 'PL')
  assert.equal(pluginInitials('a'), 'A')
  assert.equal(pluginInitials(null), 'PL')
})

test('groupEntriesByCategory clusters entries into title-cased categories and General fallback', () => {
  const entries = [
    { name: 'scanner', category: 'security' },
    { name: 'linter', category: 'development' },
    { name: 'debugger', category: 'development' },
    { name: 'misc-tool' },
    { name: 'empty-cat', category: '   ' },
  ]
  const groups = groupEntriesByCategory(entries)
  assert.deepEqual(
    groups.map((g) => ({ category: g.category, label: g.label })),
    [
      { category: 'development', label: 'Development' },
      { category: 'security', label: 'Security' },
      { category: 'general', label: 'General' },
    ],
  )
  assert.deepEqual(groups[0].entries.map((e) => e.name), ['linter', 'debugger'])
  assert.deepEqual(groups[1].entries.map((e) => e.name), ['scanner'])
  assert.deepEqual(groups[2].entries.map((e) => e.name), ['misc-tool', 'empty-cat'])

  assert.deepEqual(groupEntriesByCategory([]), [])
  assert.deepEqual(groupEntriesByCategory(null), [])
})

test('searchEntries ranks exact and prefix matches ahead of description-only matches', () => {
  const entries = [
    { name: 'code-helper', description: 'Includes a lint feature' },
    { name: 'linter', description: 'Checks JavaScript syntax' },
    { name: 'lint', description: 'Exact match tool' },
    { name: 'unrelated', description: 'Does other tasks' },
  ]
  const results = searchEntries(entries, { query: 'lint' })
  assert.deepEqual(results.map((e) => e.name), ['lint', 'linter', 'code-helper'])
})

test('searchEntries handles regex characters safely without throwing', () => {
  const entries = [
    { name: 'regex-special.*[tool]', description: 'Has special.*[regex] characters' },
    { name: 'normal-tool', description: 'Standard description' },
  ]
  assert.doesNotThrow(() => {
    const results = searchEntries(entries, { query: 'special.*[regex]' })
    assert.equal(results.length, 1)
    assert.equal(results[0].name, 'regex-special.*[tool]')
  })
  assert.doesNotThrow(() => {
    const emptyResults = searchEntries(entries, { query: 'notfound.*[pattern]' })
    assert.equal(emptyResults.length, 0)
  })
})

test('searchEntries filters by category and marketplace and sorts alphabetically when query is absent', () => {
  const entries = [
    { name: 'zebra', category: 'tools', marketplace: 'core' },
    { name: 'alpha', category: 'tools', marketplace: 'core' },
    { name: 'beta', category: 'other', marketplace: 'community' },
  ]
  const inTools = searchEntries(entries, { category: 'tools' })
  assert.deepEqual(inTools.map((e) => e.name), ['alpha', 'zebra'])

  const inCommunity = searchEntries(entries, { marketplace: 'community' })
  assert.deepEqual(inCommunity.map((e) => e.name), ['beta'])
})

test('resolvePluginBrand identifies recognized brands from id and name or returns null', () => {
  assert.equal(resolvePluginBrand('gh-cli', 'github-tool'), 'github')
  assert.equal(resolvePluginBrand('org.gitlab.runner', 'GitLab CI'), 'gitlab')
  assert.equal(resolvePluginBrand('docker-compose', 'Docker Compose'), 'docker')
  assert.equal(resolvePluginBrand('android-tools', 'Android Studio Bridge'), 'android')
  assert.equal(resolvePluginBrand('aws-lambda', 'AWS Cloud Tools'), 'aws')
  assert.equal(resolvePluginBrand('slack-notifications', 'Slack Bot'), 'slack')
  assert.equal(resolvePluginBrand('pdf-reader', 'PDF Export'), 'pdf')
  assert.equal(resolvePluginBrand('jupyter-lab', 'Jupyter Notebooks'), 'jupyter')
  assert.equal(resolvePluginBrand('python-runner', 'Python Linter'), 'python')
  assert.equal(resolvePluginBrand('figma-sync', 'Figma Exporter'), 'figma')

  // Case insensitive and partial / token matching
  assert.equal(resolvePluginBrand('GITHUB', 'tool'), 'github')
  assert.equal(resolvePluginBrand(null, 'Slack'), 'slack')
  assert.equal(resolvePluginBrand('docker', null), 'docker')

  // Unrecognized tools return null
  assert.equal(resolvePluginBrand('custom-plugin', 'My Custom Plugin'), null)
  assert.equal(resolvePluginBrand('', ''), null)
  assert.equal(resolvePluginBrand(null, null), null)
})

test('searchEntries and groupEntriesByCategory handle null entries, null filters, and malformed tags defensively', () => {
  const malformedEntries = [
    null,
    undefined,
    { name: 'alpha', category: 'tools', tags: 'not-an-array' },
    { name: 'beta', category: 'tools', tags: null },
    { name: 'gamma', tags: ['good'] },
  ]

  // searchEntries with null filters
  assert.doesNotThrow(() => {
    const res = searchEntries(malformedEntries, null)
    assert.equal(res.length, 3)
    assert.deepEqual(res.map((e) => e.name), ['alpha', 'beta', 'gamma'])
  })

  // searchEntries query on malformed tags and null entries
  assert.doesNotThrow(() => {
    const res = searchEntries(malformedEntries, { query: 'good' })
    assert.equal(res.length, 1)
    assert.equal(res[0].name, 'gamma')
  })

  // groupEntriesByCategory with null/undefined elements
  assert.doesNotThrow(() => {
    const groups = groupEntriesByCategory(malformedEntries)
    assert.equal(groups.length, 2)
  })
})

