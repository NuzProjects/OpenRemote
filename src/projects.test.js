import { test } from 'node:test'
import assert from 'node:assert/strict'

import { projectIndex, projectName, projectFor, sections, unreadProjects } from './projects.js'

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

test('a registered project with no chats is still listed, with its count', () => {
  const out = sections([P1, P2], [{ id: 'a', workspace: '/home/u/website' }])
  assert.deepEqual(
    out.projects.map((g) => [g.project.id, g.items.length]),
    [
      ['p1', 1],
      ['p2', 0],
    ],
    'registering a folder must not end with the project missing from the list',
  )
  assert.deepEqual(out.flat, [])
})

test('a project with no chats comes back even when nothing is running', () => {
  const out = sections([P1], [])
  assert.equal(out.projects.length, 1)
  assert.deepEqual(out.projects[0].items, [])
})

// ---- the grouping cost ----

const ROWS = Array.from({ length: 200 }, (_, i) => ({
  id: `c${i}`,
  workspace: i % 2 ? `/work/alpha` : `/work/beta`,
}))

test('sections through an index is one lookup per row, never a scan of every project', () => {
  const projects = [
    { id: 'p1', name: 'Alpha', folders: ['/work/alpha'] },
    { id: 'p2', name: 'Beta', folders: ['/work/beta'] },
  ]
  const index = projectIndex(projects)
  let lookups = 0
  const counting = { get: (key) => (lookups++, index.get(key)) }
  // Once the index exists, a project's folders are never read again: a getter
  // that throws proves the scan is gone.
  for (const project of projects) {
    Object.defineProperty(project, 'folders', {
      get() {
        throw new Error('scanned every project per row')
      },
    })
  }
  const grouped = sections(projects, ROWS, counting)
  assert.equal(lookups, ROWS.length, 'one lookup per row')
  assert.equal(grouped.projects.find((g) => g.project.id === 'p1').items.length, 100)
  assert.equal(grouped.projects.find((g) => g.project.id === 'p2').items.length, 100)
})

test('the index and the old scan group identically, first project winning', () => {
  const projects = [
    { id: 'first', name: 'First', folders: ['/work/shared'] },
    { id: 'second', name: 'Second', folders: ['/work/shared'] },
  ]
  const rows = [{ id: 'a', workspace: '/work/shared' }, { id: 'b', workspace: '/work/nowhere' }]
  assert.deepEqual(sections(projects, rows, projectIndex(projects)), sections(projects, rows))
  assert.deepEqual(projectFor(projects, '/work/shared').id, 'first')
  assert.deepEqual(projectIndex(projects).get('/work/shared').id, 'first')
})

test('unread counts are collected in one pass', () => {
  const projects = [
    { id: 'p1', name: 'Alpha', folders: ['/work/alpha'] },
    { id: 'p2', name: 'Beta', folders: ['/work/beta'] },
  ]
  const index = projectIndex(projects)
  const rows = [
    { id: 'c1', workspace: '/work/alpha' },
    { id: 'c2', workspace: '/work/beta' },
    { id: 'c3', workspace: '/work/nowhere' },
    { id: 'c4', workspace: '/work/alpha' },
  ]
  const unread = new Set(['c1', 'c2', 'c3'])
  assert.deepEqual([...unreadProjects(rows, unread, index)].sort(), ['p1', 'p2'])
  assert.equal(unreadProjects(rows, new Set(), index).size, 0)
})