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
    // The claim is a plain lock set inside the press, not the state: a second
    // press in the same frame reads the pre-render state and would pass a
    // state guard twice (see removal-lock.test.js for that case).
    assert.match(pane, /createRemovalLock\(\)/)
    assert.match(pane, /if \(!lockRef\.current\.claim\(id\)\) return/)
    assert.match(pane, /setRemoving\(id\)/)
    assert.match(pane, /finally \{\s*\n\s*lockRef\.current\.release\(\)\s*\n\s*setRemoving\(null\)/)
    // Every armed press is disabled while any removal runs, so no button looks
    // live and then answers nothing.
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
// ---- the four Settings rows that destroy something ----

const settings = source('SettingsView.jsx')

test('Settings: unregistering a project carries the same promise as the sidebar, safe answer first', () => {
  assert.match(settings, /The project goes; its chats move to Chats and the folder on disk is never touched\./)
  // Keep is offered before the press that removes.
  assert.ok(
    settings.indexOf('>Keep<') < settings.indexOf('Remove it'),
    'the safe answer comes first in the armed pair',
  )
})

test('Settings: forgetting the daemon says what is forgotten and puts Cancel first', () => {
  assert.match(settings, /The saved address and token are forgotten; your chats, plugins and settings stay\./)
  assert.ok(
    settings.indexOf('setConfirmDisconnect(false)}>Cancel</button>') <
      settings.indexOf('onClick={disconnect}>Disconnect</button>'),
    'Cancel comes before Disconnect',
  )
})

test('Settings: signing out puts Cancel first and says what stays', () => {
  assert.ok(
    settings.indexOf('setConfirmSignOut(false)}>Cancel</button>') <
      settings.indexOf('await signOutCloud()'),
    'Cancel comes before Sign out',
  )
  assert.match(settings, /Synced chats stay on/)
})

test('Settings: Reset every shortcut is one press and says what it clears', () => {
  assert.match(settings, />\s*Reset every shortcut\s*</)
  assert.match(settings, /Puts every key back to its default\. Nothing else changes\./)
  // One press is right for a key: no armed row or modal around the reset.
  assert.doesNotMatch(settings, /confirmReset/)
})

test('Settings: the archived Delete goes through the chat delete dialog', () => {
  // A chat delete is the un-undoable one, so it is the family's confirm, not a
  // press on the row.
  assert.match(settings, /onClick=\{\(\) => setDeleting\(s\)\}/)
  assert.match(settings, /<DeleteChatModal/)
})