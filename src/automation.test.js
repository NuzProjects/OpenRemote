// The automation vocabulary the views share: the trigger sentence a rule row
// shows, and the dirty test that keeps the rule editor from throwing away a
// half-written rule on a stray click.

import assert from 'node:assert/strict'
import test from 'node:test'
import { formDiffers, whenSentence } from './automation.js'

test('a rule reads as the sentence a person wrote it in', () => {
  assert.equal(whenSentence({ kind: 'schedule', time: '07:30' }), 'Every day at 07:30')
  assert.equal(whenSentence({ kind: 'webhook' }), 'A webhook arrives')
  // A rule saved without a time still reads as the default it will run at.
  assert.equal(whenSentence({ kind: 'schedule' }), 'Every day at 09:00')
})

test('an untouched form is not dirty, whatever the snapshot holds', () => {
  const initial = { name: 'Nightly', task: 'Triage the failing tests', enabled: true }
  assert.equal(formDiffers({ ...initial }, initial), false)
  // No snapshot means nothing to compare, and nothing to lose.
  assert.equal(formDiffers(initial, null), false)
})

test('any changed field makes the form dirty, and a change back clears it', () => {
  const initial = { name: 'Nightly', task: 'Triage the failing tests', enabled: true, machineId: 'm1' }
  assert.equal(formDiffers({ ...initial, name: 'Nightly ' }, initial), true, 'a trailing space is a change')
  assert.equal(formDiffers({ ...initial, task: '' }, initial), true, 'erasing the task counts')
  assert.equal(formDiffers({ ...initial, enabled: false }, initial), true, 'a flipped switch counts')
  assert.equal(formDiffers({ ...initial, machineId: 'm2' }, initial), true, 'a picker pick counts')
  // A field the snapshot never held is the snapshot's business, not the
  // comparison's: adding it there is how a new field joins the guard.
  assert.equal(formDiffers({ ...initial, model: 'opus' }, initial), false)
})
