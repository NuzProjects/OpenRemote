// The dialog family's plumbing, pinned by source text because focus, inert and
// the Tab loop only exist in a browser. Every overlay that says
// role="dialog" gets it from dialog-focus.js - focus in on open, Tab kept
// inside, the rest of the app inert, focus back on the opener, and the Esc
// stack joined - so a modal cannot ship with a backdrop and no behaviour. A
// modal added later fails this test until it adopts the hook.

import assert from 'node:assert/strict'
import test from 'node:test'
import { readdirSync, readFileSync } from 'node:fs'

const dir = new URL('./', import.meta.url)
const source = (file) => readFileSync(new URL(file, dir), 'utf8')
const files = readdirSync(dir).filter((name) => name.endsWith('.jsx'))

// Not the dialog family, each for a reason:
// - the three plugin-lane modals belong to that agent tonight and are its to
//   convert (this list is the handback, not an exemption forever)
// - the command palette is its own overlay with its own focus and its own Esc
//   (it backs one page before it closes), so the shared hook would regress it
// - keyboard.jsx only names the selector in a string
const EXCLUDED = {
  'EndpointManager.jsx': 'plugin lane owns this file tonight',
  'InstallPluginModal.jsx': 'plugin lane owns this file tonight',
  'PluginDetailModal.jsx': 'plugin lane owns this file tonight',
  'CommandPalette.jsx': 'own focus and own Esc paging, not a dv-modal',
  'keyboard.jsx': 'names the selector, is not a dialog',
}

test('every dialog in the console adopts the shared plumbing', () => {
  const dialogs = files.filter((name) => source(name).includes('role="dialog"'))
  // A sanity line: if the family shrank to nothing, the scan or the markup is
  // wrong, and a passing empty list would hide it.
  assert.ok(dialogs.length >= 10, `only ${dialogs.length} dialogs found; the scan is wrong`)
  const missing = dialogs.filter((name) => !(name in EXCLUDED) && !source(name).includes('useDialog('))
  assert.deepEqual(missing, [], `dialogs with no shared plumbing: ${missing.join(', ')}`)
})

test('an adopting dialog gives the hook a panel it can focus and trap', () => {
  const adopters = files.filter((name) => source(name).includes('useDialog('))
  const loose = adopters.filter((name) => !/ref=\{panelRef\}/.test(source(name)))
  assert.deepEqual(loose, [], `dialogs that pass no panel ref: ${loose.join(', ')}`)
  const unfocusable = adopters.filter((name) => !source(name).includes('tabIndex={-1}'))
  assert.deepEqual(unfocusable, [], `dialogs without a focusable panel: ${unfocusable.join(', ')}`)
})

test('the plumbing joins the Esc stack instead of answering the key itself', () => {
  const module = source('dialog-focus.js')
  assert.match(module, /import \{ useEscLayer \} from '\.\/esc-layer\.js'/, 'holds a layer from the stack')
  assert.match(module, /useEscLayer\(open && esc, onClose\)/, 'and passes its own open state')
  assert.ok(!module.includes("'Escape'"), 'the module never listens for the key itself')
  // The tab loop is the module's, and it is the tested rule that wraps the ends.
  assert.match(module, /tabTarget\(nodes\.length/, 'Tab goes through the tested rule')
})
