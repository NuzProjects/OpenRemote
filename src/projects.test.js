import { test } from 'node:test'
import assert from 'node:assert/strict'

import { projectName, projectFor, sections } from './projects.js'

const P1 = { id: 'p1', folders: ['/home/u/website'] }
const P2 = { id: 'p2', folders: ['/home/u/daemon'] }

test('a project is named by its first folder', () => {
  assert.equal(projectName(P1), 'website')
  assert.equal(projectName({ id: 'x', folders: [] }), 'project')
  assert.equal(projectName(null), 'project')
})

test('a chat belongs to the project whose folders hold its workspace', () => {
  assert.equal(projectFor([P1, P2], '/home/u/website')?.id, 'p1')
  assert.equal(projectFor([P1, P2], '/home/u/elsewhere'), null)
  // A project-less chat names no workspace at all.
  assert.equal(projectFor([P1, P2], null), null)
  assert.equal(projectFor([P1, P2], undefined), null)
})

test('sections splits chats into projects and one flat list', () => {
  const rows = [
    { id: 'a', workspace: '/home/u/website' },
    { id: 'b', workspace: null }, // project-less
    { id: 'c', workspace: '/home/u/daemon' },
    { id: 'd', workspace: '/home/u/unregistered' },
  ]
  const out = sections([P1, P2], rows)
  assert.deepEqual(
    out.projects.map((g) => [g.project.id, g.items.map((r) => r.id)]),
    [
      ['p1', ['a']],
      ['p2', ['c']],
    ],
  )
  assert.deepEqual(out.flat.map((r) => r.id), ['b', 'd'])
})

test('a project with no chats still has its group, so its + has a row to press', () => {
  const out = sections([P1, P2], [{ id: 'a', workspace: '/home/u/website' }])
  assert.deepEqual(
    out.projects.map((g) => [g.project.id, g.items.length]),
    [
      ['p1', 1],
      ['p2', 0],
    ],
  )
  assert.deepEqual(out.flat, [])
  // No chats at all: every project is still there.
  assert.equal(sections([P1, P2], []).projects.length, 2)
})

test('without other machines, every chat is grouped by this computer\'s projects, synced or not', () => {
  const rows = [
    { id: 'a', workspace: '/home/u/website', executor: 'me' },
    { id: 'b', workspace: '/home/u/website', executor: null },
  ]
  const out = sections([P1], rows)
  assert.deepEqual(out.projects[0].items.map((r) => r.id), ['a', 'b'])
})

const M1 = { id: 'm1', name: 'Studio PC', projects: [{ id: 'q1', folders: ['/srv/api'] }, { id: 'q2', folders: ['/srv/docs'] }] }
const cloud = { thisDevice: 'me', machines: [M1] }

test('in Cloud a chat on another machine groups under that machine\'s project, never this computer\'s', () => {
  const rows = [
    { id: 'here', workspace: '/home/u/website', executor: 'me' },
    { id: 'there', workspace: '/srv/api', executor: 'm1' },
    // The same path on this computer is a different folder: it never joins the machine's project.
    { id: 'samepath', workspace: '/srv/api', executor: 'me' },
  ]
  const out = sections([P1], rows, cloud)
  assert.deepEqual(
    out.projects.map((g) => [g.key, g.device, g.deviceName, g.items.map((r) => r.id)]),
    [
      ['p1', null, null, ['here']],
      ['m1:q1', 'm1', 'Studio PC', ['there']],
      ['m1:q2', 'm1', 'Studio PC', []],
    ],
  )
  assert.deepEqual(out.flat.map((r) => r.id), ['samepath'])
})

test('a chat on a machine whose projects are not known, or off all of them, stays in the flat list', () => {
  const rows = [
    { id: 'unknown', workspace: '/srv/api', executor: 'm2' },
    { id: 'off', workspace: '/srv/elsewhere', executor: 'm1' },
    { id: 'none', workspace: null, executor: 'm1' },
  ]
  const out = sections([], rows, cloud)
  assert.deepEqual(out.flat.map((r) => r.id), ['unknown', 'off', 'none'])
  // The phone has no projects of its own: its chats group under the machines' alone.
  const phone = sections([], [{ id: 'p', workspace: '/srv/docs', executor: 'm1' }], { thisDevice: 'phone', machines: [M1] })
  assert.deepEqual(phone.projects.map((g) => [g.key, g.items.length]), [['m1:q1', 0], ['m1:q2', 1]])
})
