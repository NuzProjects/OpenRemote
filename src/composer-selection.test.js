// What the composer keeps across a Local/Cloud switch: a pick that is still
// valid stays, one that cannot survive is dropped and named. The failure this
// pins is a glance at Cloud costing the project and the machine - the person
// comes back to an empty row and has to pick again.

import assert from 'node:assert/strict'
import test from 'node:test'
import { keepLine, keepSelection } from './composer-selection.js'

const CLOUD_MACHINES = [{ id: 'm1' }, { id: 'm2' }]
const LOCAL_PROJECTS = [{ id: 'p1' }, { id: 'p2' }]

test('Local keeps both, because Local has no machine choice to lose', () => {
  // Going back to Local: the target cannot mean anything there, but the
  // project can.
  const out = keepSelection({ projectId: 'p1', target: 'm1' }, { mode: 'local', machines: [], projects: LOCAL_PROJECTS })
  assert.deepEqual(out.kept, { projectId: 'p1', target: null })
  assert.deepEqual(out.dropped, ['machine'])
  assert.equal(out.kept.projectId, 'p1')
})

test('Cloud keeps both when they still exist there', () => {
  const out = keepSelection(
    { projectId: 'p1', target: 'm2' },
    { mode: 'cloud', machines: CLOUD_MACHINES, projects: null },
  )
  assert.deepEqual(out.kept, { projectId: 'p1', target: 'm2' })
  assert.deepEqual(out.dropped, [])
  assert.equal(keepLine(out.dropped), null)
})

test('a machine that is no longer offered is dropped and named', () => {
  const out = keepSelection({ target: 'gone' }, { mode: 'cloud', machines: CLOUD_MACHINES, projects: null })
  assert.equal(out.kept.target, null)
  assert.deepEqual(out.dropped, ['machine'])
  assert.match(keepLine(out.dropped), /machine did not come across the mode switch/)
})

test('a project the new list does not carry is dropped and named, both named together', () => {
  const out = keepSelection(
    { projectId: 'p9', target: 'm3' },
    { mode: 'cloud', machines: CLOUD_MACHINES, projects: LOCAL_PROJECTS },
  )
  assert.deepEqual(out.kept, { projectId: null, target: null })
  assert.deepEqual(out.dropped, ['machine', 'project'])
  assert.match(keepLine(out.dropped), /machine and project did not come across/)
})

test('nothing picked keeps nothing and says nothing', () => {
  const out = keepSelection({ projectId: null, target: null }, { mode: 'local', machines: [], projects: [] })
  assert.deepEqual(out.kept, { projectId: null, target: null })
  assert.deepEqual(out.dropped, [])
  assert.equal(keepLine(out.dropped), null)
})
