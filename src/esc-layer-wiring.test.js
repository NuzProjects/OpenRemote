// Esc closes one layer, the top one. A modal that answers the key with a
// window listener of its own closes the window it was opened over at the
// same moment, because both listeners are on `window` and the newer one
// cannot stop the older one: only the layer stack can tell them apart. So
// every dialog in the console holds its layer through the shared hook
// (dialog-focus.js), and this pins the family.
//
// The family is discovered, not listed: a dialog is anything that declares
// itself as one, so a modal added later is covered without editing this
// file. A floor of names stays here so a discovery that quietly stopped
// finding the dialogs this console already had goes red instead of passing
// on an empty set.

import assert from 'node:assert/strict'
import test from 'node:test'
import { readdirSync, readFileSync } from 'node:fs'

const FILES = readdirSync(new URL('.', import.meta.url)).filter((file) => file.endsWith('.jsx'))
const source = (file) => readFileSync(new URL(`./${file}`, import.meta.url), 'utf8')

// `aria-modal` is the declaration that makes a thing a dialog. Matching it
// rather than a bare role="dialog" keeps keyboard.jsx out of the family: it
// holds a selector string that names other people's dialogs, it paints none.
const DIALOGS = FILES.filter((file) => source(file).includes('aria-modal'))

// The floor: the four that showed the way, the nine that used to answer the
// key themselves, and the five this file's first version missed (the palette,
// sign-in, and the three tonight added). A dialog that leaves this set is a
// dialog that stopped declaring itself one.
const KNOWN = [
  'AboutModal.jsx',
  'AddMachineModal.jsx',
  'AddMcpServerModal.jsx',
  'AutomationForm.jsx',
  'ChangesModal.jsx',
  'CommandPalette.jsx',
  'DeleteChatModal.jsx',
  'EndpointManager.jsx',
  'FolderPickerModal.jsx',
  'HarnessManagerModal.jsx',
  'InstallPluginModal.jsx',
  'MachineModal.jsx',
  'PluginDetailModal.jsx',
  'RaceModal.jsx',
  'RenameChatModal.jsx',
  'ShortcutSheet.jsx',
  'SignInModal.jsx',
  'ViewPopup.jsx',
]

test('every dialog in the console is in the family', () => {
  const missing = DIALOGS.filter((file) => !source(file).includes('useDialog('))
  assert.deepEqual(missing, [], `dialogs that do not hold their layer through the shared hook: ${missing.join(', ')}`)
})

test('the dialogs this console already had are still discovered', () => {
  const lost = KNOWN.filter((file) => !DIALOGS.includes(file))
  assert.deepEqual(lost, [], `known dialogs the family no longer finds: ${lost.join(', ')}`)
})

test('no dialog answers Esc with a window listener of its own', () => {
  const answering = DIALOGS.filter((file) => /window\.addEventListener\(\s*'keydown'/.test(source(file)))
  assert.deepEqual(answering, [], `dialogs that answer Esc themselves: ${answering.join(', ')}`)
})
