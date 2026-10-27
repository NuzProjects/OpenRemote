// A rule's last-run stamp is untrusted data: a number in one version, a date
// string in another, garbage after a bad write. The formatter throws on an
// invalid date, and a throw here takes the whole rules list into the error
// boundary, so these cases are the reason the module exists. "Never ran" is
// said only about a rule with no stamp at all; a stamp that cannot be read is
// reported as unknown rather than denied.

import assert from 'node:assert/strict'
import test from 'node:test'
import { ranLabel } from './ran-label.js'

const at = Date.UTC(2026, 9, 27, 12, 0, 0)

test('a real stamp is formatted, as a number or as the digits a JSON echo made', () => {
  assert.match(ranLabel({ last_run: at }), /^ran /)
  assert.equal(ranLabel({ last_run: at }), ranLabel({ last_run: String(at) }))
})

test('no stamp means never ran', () => {
  assert.equal(ranLabel({ last_run: null }), 'never ran')
  assert.equal(ranLabel({ last_run: 0 }), 'never ran')
  assert.equal(ranLabel({ last_run: '' }), 'never ran')
  assert.equal(ranLabel({}), 'never ran')
  assert.equal(ranLabel(undefined), 'never ran')
})

test('an unreadable stamp says unknown instead of throwing the list', () => {
  assert.equal(ranLabel({ last_run: 1e18 }), 'ran at an unknown time')
  assert.equal(ranLabel({ last_run: '1750000000000abc' }), 'ran at an unknown time')
  assert.equal(ranLabel({ last_run: 'nope' }), 'ran at an unknown time')
  assert.equal(ranLabel({ last_run: NaN }), 'ran at an unknown time')
  assert.equal(ranLabel({ last_run: {} }), 'ran at an unknown time')
  assert.doesNotThrow(() => ranLabel({ last_run: 1e18 }))
})
