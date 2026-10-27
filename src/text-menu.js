// The text-field context menu: what a right-click inside an input, a textarea
// or a contenteditable offers, now that the engine's own menu is off in the
// console.
//
// Clipboard access is the awkward part. Copy and cut work from the field's own
// selection: `navigator.clipboard.writeText` when it is there, and
// `document.execCommand('copy')` as the fallback (deprecated, still the way a
// webview copies without a permission). Paste needs a *read*, which only
// `navigator.clipboard.readText` can do; `execCommand('paste')` is refused by
// Chromium on purpose, so the item is offered only where that read exists
// rather than shown as a button that could never act.
//
// Insertion goes through the native value setter and an `input` event, because
// every field in this console is controlled by React: setting `.value` alone
// would leave the component's state at the old text and the next keystroke
// would restore it.

/// The text-ish input types a caret menu makes sense for. Number, date,
/// colour and file inputs have no selection API worth using here.
const TEXT_TYPES = new Set(['text', 'search', 'url', 'email', 'tel', 'password'])

/// Which kind of text field `el` is, or null. Written from properties rather
/// than `instanceof` so a plain object can stand in for a field in tests.
export function fieldKind(el) {
  if (!el || typeof el !== 'object') return null
  if (el.isContentEditable === true) return 'editable'
  const tag = String(el.tagName ?? '').toUpperCase()
  if (tag === 'TEXTAREA') return 'textarea'
  if (tag === 'INPUT') {
    const type = String(el.type ?? 'text').toLowerCase()
    return TEXT_TYPES.has(type) ? 'input' : null
  }
  return null
}

/// The value with `[start, end)` replaced by `text`, and where the caret goes.
/// Pure, so the paste maths is tested without a DOM.
export function insertAt(value, start, end, text) {
  const from = Math.max(0, Math.min(start, value.length))
  const to = Math.max(from, Math.min(end, value.length))
  return {
    value: value.slice(0, from) + text + value.slice(to),
    caret: from + text.length,
  }
}

/// What is selected in the field, as plain data.
export function selectionOf(el) {
  const kind = fieldKind(el)
  if (kind === 'editable') {
    const text = typeof window === 'undefined' ? '' : String(window.getSelection() ?? '')
    return { start: 0, end: 0, text, editable: true }
  }
  if (!kind) return { start: 0, end: 0, text: '', editable: false }
  const value = String(el.value ?? '')
  const start = Number.isInteger(el.selectionStart) ? el.selectionStart : value.length
  const end = Number.isInteger(el.selectionEnd) ? el.selectionEnd : value.length
  return { start, end, text: value.slice(start, end), editable: false }
}

/// Put the field's value back through React: native setter, then the event a
/// controlled input listens for.
function setValue(el, value) {
  const proto = String(el.tagName).toUpperCase() === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set
  if (!setter) return false
  setter.call(el, value)
  el.dispatchEvent(new Event('input', { bubbles: true }))
  return true
}

/// Insert text at the caret (replacing the selection when there is one).
export function insertText(el, text) {
  const kind = fieldKind(el)
  if (kind === 'editable') {
    // The editable's own insert command fires the input event and keeps the
    // browser's undo stack; a raw Range edit would do neither.
    return document.execCommand('insertText', false, text)
  }
  if (!kind) return false
  const { start, end } = selectionOf(el)
  const next = insertAt(String(el.value ?? ''), start, end, text)
  if (!setValue(el, next.value)) return false
  try {
    el.setSelectionRange(next.caret, next.caret)
  } catch {
    // Some input types refuse a caret; the text is in place regardless.
  }
  return true
}

/// Select the whole field.
export function selectContents(el) {
  const kind = fieldKind(el)
  if (kind === 'editable') {
    if (typeof window === 'undefined') return false
    const range = document.createRange()
    range.selectNodeContents(el)
    const selection = window.getSelection()
    selection?.removeAllRanges()
    selection?.addRange(range)
    return true
  }
  if (!kind) return false
  try {
    el.select()
    return true
  } catch {
    return false
  }
}

async function readClipboard() {
  try {
    if (!navigator.clipboard?.readText) return null
    const text = await navigator.clipboard.readText()
    return typeof text === 'string' ? text : null
  } catch {
    return null
  }
}

async function writeClipboard(text) {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text)
      return true
    }
  } catch {
    // Fall through to the command: a refused permission still leaves the
    // copy path a webview has always had.
  }
  try {
    return document.execCommand('copy')
  } catch {
    return false
  }
}

async function copy(el) {
  const { text } = selectionOf(el)
  if (!text) return false
  return writeClipboard(text)
}

async function cut(el) {
  const { text } = selectionOf(el)
  if (!text) return false
  if (!(await writeClipboard(text))) return false
  // Only delete once the text is safely out: a failed copy must not eat it.
  return insertText(el, '')
}

async function paste(el) {
  const text = await readClipboard()
  if (text == null || text === '') return false
  return insertText(el, text)
}

/// Whether a paste could be attempted here at all: the read API exists.
export function canPaste() {
  return typeof navigator !== 'undefined' && Boolean(navigator.clipboard?.readText)
}

/// The menu's rows for one field. `run` is what the menu calls when a row is
/// chosen; `disabled` is decided at open time from the selection, except Paste,
/// whose clipboard cannot be read without asking. `pasteAvailable` is a
/// parameter so the ordering is testable without a clipboard global.
export function textMenuRows(el, pasteAvailable = canPaste()) {
  const { text } = selectionOf(el)
  const has = text.length > 0
  const rows = [
    { id: 'cut', label: 'Cut', disabled: !has, run: () => cut(el) },
    { id: 'copy', label: 'Copy', disabled: !has, run: () => copy(el) },
  ]
  if (pasteAvailable) rows.push({ id: 'paste', label: 'Paste', disabled: false, run: () => paste(el) })
  rows.push({ id: 'select-all', label: 'Select all', disabled: false, run: () => selectContents(el) })
  return rows
}

/// The field a right click landed in, or null.
export function textFieldOf(target) {
  return fieldKind(target) ? target : null
}

/// The rows in the shape the app's ContextMenu takes.
export function textMenuItems(el) {
  return textMenuRows(el).map(({ label, disabled, run }) => ({
    label,
    disabled,
    onSelect: run,
  }))
}
