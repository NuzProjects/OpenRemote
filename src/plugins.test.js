import assert from 'node:assert/strict'
import test from 'node:test'
import { POWER_LABEL, RUNTIME_LABEL, notSandboxed, sourceLabel, sourceRequest } from './plugins.js'

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
  assert.deepEqual(sourceRequest('archive', ' https://x/a.zip '), { kind: 'archive', location: 'https://x/a.zip' })
  assert.equal(sourceRequest('git', '   '), null)
})
