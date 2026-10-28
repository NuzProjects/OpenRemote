// Two projects can share a basename; the sidebar has to say which folder each one is,
// and a project whose folder is gone is not a live project called "project".
import test from 'node:test'
import assert from 'node:assert/strict'

import { duplicatedNames, folderless, projectName } from './projects.js'

test('names two projects share are marked, unique names are not', () => {
  const projects = [
    { id: 'a', folders: ['C:\\work\\app'] },
    { id: 'b', folders: ['C:\\home\\app'] },
    { id: 'c', folders: ['/srv/other'] },
  ]
  const shared = duplicatedNames(projects)
  assert.deepEqual([...shared], ['app'], 'only the shared basename is marked')
  assert.equal(projectName(projects[0]), 'app')
  assert.equal(projectName(projects[2]), 'other')
  // One project, one name: nothing to disambiguate.
  assert.equal(duplicatedNames([projects[2]]).size, 0)
  assert.equal(duplicatedNames(null).size, 0)
})

test('a project with no folder is its own case', () => {
  assert.equal(folderless({ id: 'a', folders: [] }), true)
  assert.equal(folderless({ id: 'a' }), true)
  assert.equal(folderless({ id: 'a', folders: ['C:\\work\\app'] }), false)
  // The name rule still answers something (the sidebar draws the case itself).
  assert.equal(projectName({ id: 'a', folders: [] }), 'project')
})
