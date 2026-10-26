// Esc closes one layer, the top one. A modal that answers the key with a
// window listener of its own closes the window it was opened over at the
// same moment, because both listeners are on `window` and the newer one
// cannot stop the older one: only the layer stack can tell them apart. So
// every modal that closes on Esc holds a layer from esc-layer.js, and this
// pins the family. A modal added later belongs in the list.

import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'

// The four that showed the way, then the ten that used to answer the key
// themselves. Settings is not here on purpose: ViewPopup, which wraps it,
// holds the layer, and the Esc handlers inside it belong to its fields.
const MODALS = [
  'AutomationForm.jsx',
  'DeleteChatModal.jsx',
  'EndpointManager.jsx',
  'ViewPopup.jsx',
  'AboutModal.jsx',
  'AddMachineModal.jsx',
  'AddMcpServerModal.jsx',
  'FolderPickerModal.jsx',
  'HarnessManagerModal.jsx',
  'InstallPluginModal.jsx',
  'MachineModal.jsx',
  'PluginDetailModal.jsx',
  'ShortcutSheet.jsx',
]

const source = (file) => readFileSync(new URL(`./${file}`, import.meta.url), 'utf8')

// The shapes a real call takes: one that is always open holds `true`, one a
// picker can sit over holds `!picker`, one that may not have its entry yet
// holds `Boolean(entry)`. Matching the call as written, not the name alone,
// is what keeps a hook called with a condition that can be false - or with
// `false` outright - from passing as wired.
const WIRED = ['useEscLayer(true,', 'useEscLayer(!', 'useEscLayer(Boolean(']

test('every modal that closes on Esc holds a layer', () => {
  const missing = MODALS.filter((file) => !WIRED.some((shape) => source(file).includes(shape)))
  assert.deepEqual(missing, [], `modals that hold no Esc layer: ${missing.join(', ')}`)
})

test('no modal answers Esc with a window listener of its own', () => {
  const answering = MODALS.filter((file) => source(file).includes("'Escape'"))
  assert.deepEqual(answering, [], `modals that answer Esc themselves: ${answering.join(', ')}`)
})
