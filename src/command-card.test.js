import assert from 'node:assert/strict'
import test from 'node:test'
import { isCommandRun } from './command-card.js'

test('a command string with an optional description is a command run', () => {
  assert.equal(isCommandRun({ command: 'npm test' }), true)
  assert.equal(
    isCommandRun({ command: 'Remove-Item -Recurse -Force "$env:TEMP\\x"', description: 'Clean the temp path' }),
    true,
  )
  assert.equal(isCommandRun({ command: '' }), false, 'an empty command is nothing to show')
})

test('other tool inputs are not command runs - by shape, never by name', () => {
  assert.equal(isCommandRun(null), false)
  assert.equal(isCommandRun('plain string'), false)
  assert.equal(isCommandRun({ file_path: '/a', old_string: 'x', new_string: 'y' }), false)
  assert.equal(isCommandRun({ query: 'select *' }), false)
  assert.equal(isCommandRun({}), false)
})
