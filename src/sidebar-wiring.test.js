// The sidebar's two claims that only its source can show.
//
// Unregistering a project used to act on the first press, on a 22px trash two
// pixels from the project's new-chat button, with no undo anywhere. It now asks
// once through the shared row-confirm rules, which the plugins, MCP and
// endpoint panes already use, so there is one "armed row" rule in the app and
// not a second one here. And registering a folder must not end in a sidebar
// that dropped it: a registered project keeps its row, its count reads zero,
// and it says it has no chats yet. The view is JSX, so this reads it rather
// than rendering it, the way the other wiring tests do.

import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'

const source = readFileSync(new URL('./Sidebar.jsx', import.meta.url), 'utf8')

test('the project trash asks before it unregisters', () => {
  assert.ok(
    source.includes("from './row-confirm.js'"),
    'the sidebar uses the shared armed-row rules instead of a private confirm',
  )
  assert.ok(
    source.includes('armRow(current, project.id)'),
    'the first press arms the project',
  )
  assert.ok(
    source.includes('rowIsArmed(armed, project.id)'),
    'the armed project is the one the rules name',
  )
  // The arm button is the trash; it must not also act.
  const trash = source.indexOf('className="sb-project-remove"')
  assert.ok(trash >= 0, 'the trash is still the way in')
  const end = source.indexOf('</button>', trash)
  const handler = source.slice(trash, end)
  assert.equal(
    handler.includes('removeProject('),
    false,
    'the first press must not unregister: only the confirm branch may',
  )
})

test('the confirm is the same spot, and Escape keeps the project', () => {
  const confirm = source.indexOf('className="sb-unregister"')
  assert.ok(confirm >= 0, 'the armed row swaps in the word that acts')
  const end = source.indexOf('</button>', confirm)
  const handler = source.slice(confirm, end)
  assert.ok(handler.includes('Escape'), 'Escape disarms')
  assert.ok(handler.includes('clearRow()'), 'and clears through the shared rule')
  assert.ok(handler.includes('removeProject(project.id)'), 'the second press acts')
})

test('a registered project with no chats keeps its row and says so', () => {
  assert.ok(
    source.includes('{items.length}'),
    'the count is drawn for every project, zero included',
  )
  const empty = source.indexOf('items.length === 0')
  assert.ok(empty >= 0, 'an empty project has its own state')
  assert.ok(
    source.slice(empty, empty + 220).includes('No chats yet.'),
    'and says it in one line rather than reading as an absence',
  )
})

test('the generic empty lines yield to a registered project', () => {
  assert.ok(
    source.includes('rows.length === 0 && grouped.projects.length === 0'),
    'with a project on screen, its own line is the one that speaks',
  )
  assert.ok(
    source.includes('grouped.flat.length === 0 && rows.length > 0'),
    'and no line talks about chats outside projects when there are no chats at all',
  )
})
