// Every view that shows a caught error builds its sentence with errorCopy, so
// a refusal is quoted as the daemon's words and a bare status code never
// reaches the screen. The audit that opened this work found the same
// `err.message ?? String(err)` shape in fifteen files; this pins the one
// shape that replaced it, and that no converted file went back.

import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'

// The files converted in this pass. Each one imports the module and calls it.
const converted = [
  'AutomationForm.jsx',
  'AddMachineModal.jsx',
  'AddMcpServerModal.jsx',
  'DeleteChatModal.jsx',
  'EndpointManager.jsx',
  'CloudMode.jsx',
  'CloudStateRow.jsx',
  'AutomationsView.jsx',
  'MachinesView.jsx',
  'FolderPickerModal.jsx',
  'HarnessManagerModal.jsx',
  'MachineModal.jsx',
  'McpServersSection.jsx',
  'NewChat.jsx',
  'PluginMarketplaces.jsx',
  'PresetNameModal.jsx',
  'RaceModal.jsx',
  'RenameChatModal.jsx',
  'SaveLayoutModal.jsx',
  'SignInModal.jsx',
]

const source = (file) => readFileSync(new URL(`./${file}`, import.meta.url), 'utf8')

test('every converted view imports errorCopy and uses it for its error', () => {
  for (const file of converted) {
    const text = source(file)
    assert.match(text, /import \{ errorCopy \} from '\.\/error-copy\.js'/, `${file} imports it`)
    assert.match(text, /errorCopy\(err\)/, `${file} calls it`)
  }
})

test('no converted view renders the raw error shape any more', () => {
  for (const file of converted) {
    const text = source(file)
    assert.doesNotMatch(text, /String\(err\)/, `${file} still stringifies the error`)
    assert.doesNotMatch(text, /'HTTP \d/, `${file} still renders a bare status code`)
  }
})
