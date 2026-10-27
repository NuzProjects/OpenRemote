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
  // The confirm takes the keyboard when it replaces the trash, so the keyboard
  // path lands on it rather than at the start of the document. The panes' armed
  // rows do the same through use-armed-row's callback ref.
  assert.ok(handler.includes('autoFocus'), 'the confirm is focused where it appears')
})

test('a registered project with no chats keeps its row and says so', () => {
  // The count is a sentence now, not a numeral: a collapsed head says what it
  // holds ("0 chats" included, which is what tells a person the project is
  // empty without expanding it), and the expanded head says nothing unless
  // something is waiting. projects.js owns the copy; the view renders parts.
  assert.ok(
    source.includes("projectLine({ chats: items.length, waiting: waitingIn.get(project.id) ?? 0 }, { collapsed: isCollapsed })"),
    'the head reads its line from the shared rule',
  )
  assert.ok(source.includes('{held && ('), 'and draws it only when there is something to say')
  assert.ok(
    source.includes("part.kind === 'waiting' ? ' is-waiting' : ''"),
    'the waiting part wears the status colour',
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

test('the chat list is one Tab stop, and the arrows walk it', () => {
  // A Tab per row plus a Tab per row's hover archive button put the view's
  // first control 40-odd Tabs away once the list held a few dozen chats, which
  // made the console unusable from the keyboard. One row carries the stop and
  // the arrows move inside the list, the way a listbox behaves.
  assert.match(source, /const \[rovingId, setRovingId\] = useState\(null\)/, 'the roving stop has a home')
  assert.match(source, /const rovingRow = rovingId && order\.includes\(rovingId\) \? rovingId : order\[0\]/)
  assert.match(source, /data-chat-row=\{row\.id\}/, 'a row can be found again after a re-render')
  assert.match(source, /tabIndex=\{rovingRow === row\.id \? 0 : -1\}/, 'exactly one row is in the Tab order')
  assert.match(source, /moveRoving\(row\.id, to\)/, 'the arrows move between rows')
  assert.match(source, /'ArrowDown' \? 1 : e\.key === 'ArrowUp' \? -1/, 'up and down walk the list')
  // The hover archive button is a pointer shortcut: archiving from the
  // keyboard is Mod+Shift+A or the palette's row, and leaving the button in
  // the order would double the cost of every row again.
  assert.match(source, /className="chat-archive"[\s\S]{0,220}tabIndex=\{-1\}/, 'the archive button stays out of the Tab order')
})
test('a row that vanishes under the keyboard hands its place to its neighbour', () => {
  // The roving stop already falls back to the first row; this is the person's
  // place. The effect watches the drawn order and acts only when the row that
  // held the keyboard has gone and focus was dropped to the body - a focus
  // that landed on another control clears the memory instead, so a list nobody
  // has touched never takes the keyboard.
  assert.ok(source.includes("const orderKey = order.join('|')"), 'one effect per order, not per render')
  assert.ok(
    source.includes('if (!held || order.includes(held)) return'),
    'a row that is still drawn is left exactly where it is',
  )
  assert.ok(
    source.includes('if (document.activeElement && document.activeElement !== document.body) {'),
    'a person who moved on is not pulled back',
  )
  assert.ok(source.includes('const at = before.indexOf(held)'), 'the index the row held')
  assert.ok(
    source.includes('order[Math.min(Math.max(at, 0), order.length - 1)]'),
    'the neighbour at the same index, clamped, or the first row',
  )
  assert.ok(
    source.includes('[data-chat-row="${CSS.escape(target)}"]'),
    'and the row that took its place receives the keyboard',
  )
  assert.ok(source.includes('}, [orderKey])'), 'keyed on the order string, not the array')
  assert.ok(source.includes('focusedRow.current = row.id'), 'the row says it holds the keyboard')
})