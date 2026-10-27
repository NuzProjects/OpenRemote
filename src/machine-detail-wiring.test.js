// The machine's harness rows used to print each installer command as the
// loudest line on the surface, under a button that runs it for you. The
// contract says that command is the daemon's own, so it is folded behind a
// disclosure now: still there for the person who would rather run it by hand,
// out of the way for everyone else. The view is JSX, so this reads it.

import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'

const source = readFileSync(new URL('./MachineModal.jsx', import.meta.url), 'utf8')

test('the installer command sits behind a disclosure, not on the row', () => {
  const disclosure = source.indexOf('<details className="dv-install-more">')
  const command = source.indexOf('{spec.command}')
  assert.ok(disclosure >= 0, 'the row has a disclosure for the command')
  assert.ok(
    source.includes('<summary>Show the command</summary>'),
    'the disclosure names what it shows',
  )
  assert.ok(command > disclosure, 'the command is inside the disclosure')
  assert.equal(
    source.slice(0, disclosure).includes('{spec.command}'),
    false,
    'and nowhere above it, where the row used to print it',
  )
})

test('the Install button still runs the installer', () => {
  assert.ok(
    source.includes('install(spec.harness_id)'),
    'the row keeps the button that does the job for the user',
  )
})
