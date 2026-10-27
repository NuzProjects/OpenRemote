// Esc closes one layer, the top one. A modal that answers the key with a
// window listener of its own closes the window it was opened over at the
// same moment, because both listeners are on `window` and the newer one
// cannot stop the older one: only the layer stack can tell them apart. So
// every modal that closes on Esc holds a layer from esc-layer.js, and this
// pins the family. A modal added later belongs in the list.

import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'

// The four that showed the way, then the nine that used to answer the key
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

// The shapes a real call takes: the shared dialog hook (dialog-focus.js) holds
// the layer for the family now, and it takes the same conditions the raw hook
// did - always open, a picker over it, or waiting on an entry. A modal that
// still calls the raw hook directly is accepted too: the layer is what this
// file pins, and the adoption itself is pinned in dialog-focus-wiring.test.js.
const WIRED = [
  'useDialog(',
  'useEscLayer(true,',
  'useEscLayer(!',
  'useEscLayer(Boolean(',
]

test('every modal that closes on Esc holds a layer', () => {
  const missing = MODALS.filter((file) => !WIRED.some((shape) => source(file).includes(shape)))
  assert.deepEqual(missing, [], `modals that hold no Esc layer: ${missing.join(', ')}`)
})

test('no modal answers Esc with a window listener of its own', () => {
  const answering = MODALS.filter((file) => source(file).includes("'Escape'"))
  assert.deepEqual(answering, [], `modals that answer Esc themselves: ${answering.join(', ')}`)
})
