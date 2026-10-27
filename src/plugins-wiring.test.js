// The plugins, MCP and endpoint panes are browser surfaces: their guards
// are one-line conditions inside components that this suite cannot render
// (there is no test renderer in this repo). So the wiring is pinned the
// way the other wiring tests here pin it - the expression that makes the
// behaviour possible has to be present - and the pure part of each guard
// is unit tested in row-confirm.test.js.

import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'

const source = (file) => readFileSync(new URL(`./${file}`, import.meta.url), 'utf8')

test('a dialog that is installing refuses to close, so Esc and the X cannot cancel its stage', () => {
  const modal = source('InstallPluginModal.jsx')
  // Esc, the backdrop and the X all call close(); the guard is inside it.
  assert.match(modal, /const close = \(\) => \{\s*\n\s*if \(busy\) return/)
  assert.match(modal, /useEscLayer\(true, close\)/)
  assert.match(modal, /if \(e\.target === e\.currentTarget\) close\(\)/)
  assert.match(modal, /<button className="dv-modal-close" onClick=\{close\}/)
})

test('the Discover tab stays mounted, so its search and filters survive a trip to Installed', () => {
  const view = source('PluginsView.jsx')
  assert.doesNotMatch(view, /tab === 'discover' &&/)
  assert.match(view, /hidden=\{tab !== 'discover'\}/)
  assert.match(view, /<PluginDiscover onInstall=/)
})

test('a failed plugin refresh is kept and shown with a retry', () => {
  const view = source('PluginsView.jsx')
  const console = source('state/console.jsx')
  assert.match(view, /pluginsError &&/)
  assert.match(view, /onClick=\{\(\) => refreshPlugins\(\)\}/)
  // Set on failure and cleared on success, in both refreshes.
  assert.equal((console.match(/setPluginsError\(null\)/g) ?? []).length, 2)
  assert.equal((console.match(/setPluginsError\(err/g) ?? []).length, 2)
  assert.match(console, /pluginsError,\s*\n\s*refreshPlugins,/)
})

test('the installed Remove button is disabled while its own removal runs', () => {
  const view = source('PluginsView.jsx')
  assert.match(view, /disabled=\{removing === p\.id\}/)
  assert.match(view, /setRemoving\(p\.id\)/)
  assert.match(view, /removing === p\.id \? 'Removing…' : 'Remove it'/)
  // No second removal can start behind the first: every other row's
  // first press is disabled while one is in flight.
  assert.match(view, /disabled=\{removing != null\}/)
})

test('an endpoint removal is a two-step confirm, and every other press disarms it', () => {
  const pane = source('EndpointManager.jsx')
  assert.match(pane, /import \{ armRow, clearRow, rowIsArmed \} from '\.\/row-confirm\.js'/)
  assert.match(pane, /setArmed\(\(curr\) => armRow\(curr, entry\.id\)\)/)
  assert.match(pane, /rowIsArmed\(armed, entry\.id\)/)
  // The daemon call exists once, in the armed branch, so the first press
  // cannot reach it.
  assert.equal((pane.match(/remove\(entry\.id\)/g) ?? []).length, 1)
  assert.match(pane, /className="pn-btn pn-btn--danger"[\s\S]{0,120}remove\(entry\.id\)/)
  // Editing, testing, enabling and defaulting all disarm the row.
  assert.equal((pane.match(/setArmed\(clearRow\(\)\)/g) ?? []).length, 7)
})

test('an MCP server removal is a two-step confirm too', () => {
  const pane = source('McpServersSection.jsx')
  assert.match(pane, /import \{ armRow, clearRow, rowIsArmed \} from '\.\/row-confirm\.js'/)
  assert.match(pane, /setArmed\(\(curr\) => armRow\(curr, p\.id\)\)/)
  assert.match(pane, /rowIsArmed\(armed, p\.id\)/)
  assert.equal((pane.match(/remove\(p\.id\)/g) ?? []).length, 1)
  assert.match(pane, /className="pn-btn pn-btn--danger"[\s\S]{0,120}remove\(p\.id\)/)
  // Enable, disable, add-key and removal each disarm first.
  assert.equal((pane.match(/setArmed\(clearRow\(\)\)/g) ?? []).length, 2)
})
