// The checks a form makes before it asks the daemon: each refuses only a shape
// the console is certain cannot work, so none can block a value the daemon
// would have taken.

import assert from 'node:assert/strict'
import test from 'node:test'
import { checkBaseUrl, checkMcpCommand, checkSource } from './form-checks.js'

test('the base URL check still holds its rule', () => {
  assert.equal(checkBaseUrl('http://localhost:4000/v1'), null)
  assert.match(checkBaseUrl('localhost:4000'), /http:\/\/ or https:\/\//)
  assert.equal(checkBaseUrl(''), 'A base URL is required.')
})

test('an empty MCP command says it is required', () => {
  assert.equal(checkMcpCommand('npx -y @modelcontextprotocol/server-filesystem'), null)
  assert.equal(checkMcpCommand('   '), 'The command is required: the machine starts it exactly as written.')
  assert.equal(checkMcpCommand(null), 'The command is required: the machine starts it exactly as written.')
})

test('a folder field refuses a link, and lets a path through', () => {
  // A path (relative or not) may be right; a link certainly is not a folder.
  assert.equal(checkSource('folder', 'C:\\dev\\my-plugin'), null)
  assert.equal(checkSource('folder', '/home/you/plugin'), null)
  assert.equal(checkSource('folder', 'my-plugin'), null)
  assert.match(checkSource('folder', 'https://github.com/owner/plugin'), /a folder is a path/)
})

test('a repo is a link, an ssh address, or an owner/name, and a bare word is none', () => {
  for (const ok of [
    'https://github.com/owner/plugin',
    'git@github.com:owner/plugin.git',
    'owner/plugin',
  ]) {
    assert.equal(checkSource('git', ok), null, ok)
  }
  assert.match(checkSource('git', 'plugin'), /does not name a repo/)
  assert.match(checkSource('git', 'two words'), /does not name a repo/)
})

test('an archive is a link or an archive file, and nothing else', () => {
  assert.equal(checkSource('archive', 'https://example.com/plugin.zip'), null)
  assert.equal(checkSource('archive', 'C:\\tmp\\plugin.tar.gz'), null)
  assert.equal(checkSource('archive', 'plugin.zip'), null)
  assert.match(checkSource('archive', 'plugin'), /does not name an archive/)
})

test('an empty source asks for one, whatever the kind', () => {
  for (const kind of ['folder', 'git', 'archive']) {
    assert.equal(checkSource(kind, '   '), 'Say where the plugin is.')
  }
})
