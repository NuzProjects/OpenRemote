// The in-flight guards the endpoint and MCP removals gained, and the rule
// trash's label. Each of these is a source-text rule because the panes need a
// renderer this suite does not have; the behaviour they pin is one press at a
// time, and a second press saying what it is doing.

import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'

const source = (file) => readFileSync(new URL(`./${file}`, import.meta.url), 'utf8')

for (const [file, row] of [
  ['EndpointManager.jsx', 'entry'],
  ['McpServersSection.jsx', 'p'],
]) {
  test(`${file}: one removal at a time, and the button says so`, () => {
    const pane = source(file)
    assert.match(pane, /const \[removing, setRemoving\] = useState\(null\)/)
    assert.match(pane, /if \(removing != null\) return/)
    assert.match(pane, /setRemoving\(id\)/)
    assert.match(pane, /finally \{\s*\n\s*setRemoving\(null\)/)
    // The armed press is disabled while its own removal runs, and every other
    // row's first press is disabled while one is in flight.
    assert.match(pane, new RegExp(`disabled=\\{removing === ${row}\\.id\\}`))
    assert.match(pane, /disabled=\{removing != null\}/)
    assert.match(pane, new RegExp(`removing === ${row}\\.id \\? "Removing…" :`))
  })
}

test('the armed labels carry what goes with the record', () => {
  assert.match(source('EndpointManager.jsx'), /Remove it and its key/)
  assert.match(source('McpServersSection.jsx'), /Remove it and its launch command/)
})

test('the rule trash says the schedule goes with the rule', () => {
  const view = source('AutomationsView.jsx')
  assert.match(view, /Remove it and its schedule/)
  assert.match(view, /The rule and its schedule go, and there is no undo/)
})

test('the armed project row carries its promise as a visible line', () => {
  const side = source('Sidebar.jsx')
  assert.match(side, /className="sb-unregister-note"/)
  assert.match(side, /The project goes; its chats move to Chats and the folder on disk is never touched\./)
  // The tooltip stays, as the hover repeat rather than the only home.
  assert.match(side, /title="Unregister this project\. Its chats move to Chats and the folder on disk is never touched\."/)
  assert.match(source('sidebar.css'), /\.sb-unregister-note \{/)
})