import assert from 'node:assert/strict'
import test from 'node:test'
import { samePayload } from './same.js'

test('a re-read payload that did not change is the same payload', () => {
  const caps = [{ id: 'claude', status: 'ready', models: ['opus'] }]
  // Two separate responses of the same list: different identities, same
  // values. This is the case the beat sees on a healthy daemon, and it is
  // what must not hand the harness rows a new array every 2.5 s.
  assert.equal(samePayload(caps, [{ id: 'claude', status: 'ready', models: ['opus'] }]), true)
  assert.equal(samePayload([], []), true, 'an empty answer equals the empty answer')
  assert.equal(samePayload(null, null), true)
})

test('any changed value is a new payload', () => {
  const before = [{ id: 'claude', status: 'ready' }]
  assert.equal(samePayload(before, [{ id: 'claude', status: 'signed-out' }]), false)
  assert.equal(samePayload(before, []), false, 'a harness that disappeared is a change')
  assert.equal(samePayload([], before), false, 'and one that appeared is a change')
  assert.equal(samePayload(null, before), false, 'a first answer is a change')
  assert.equal(samePayload(before.length, null), false)
  // A payload that cannot be serialised is never the one on screen.
  const cyclic = {}
  cyclic.self = cyclic
  const other = {}
  other.self = other
  assert.equal(samePayload(cyclic, other), false)
})
