// A key the shell caught while a page had focus (`browser:key`, a chord in
// shortcuts.js's form) played back to the app as the keypress it was, so
// the app's own keyboard layer decides what it means. Pure: tested without
// a DOM.

const CODES = {
  '\\': 'Backslash',
  '/': 'Slash',
  ',': 'Comma',
  '.': 'Period',
  ';': 'Semicolon',
  "'": 'Quote',
  '[': 'BracketLeft',
  ']': 'BracketRight',
  '-': 'Minus',
  '=': 'Equal',
  '`': 'Backquote',
  Up: 'ArrowUp',
  Down: 'ArrowDown',
  Left: 'ArrowLeft',
  Right: 'ArrowRight',
  Home: 'Home',
  End: 'End',
  PageUp: 'PageUp',
  PageDown: 'PageDown',
  Esc: 'Escape',
  Enter: 'Enter',
  Space: 'Space',
  Tab: 'Tab',
  Backspace: 'Backspace',
  Delete: 'Delete',
}

// The KeyboardEvent fields that spell a chord, or null for a key it can't.
export function keyEventInit(chord, mac = false) {
  const parts = String(chord ?? '').split('+')
  const key = parts.pop()
  let code = CODES[key]
  if (/^[A-Z]$/.test(key)) code = `Key${key}`
  else if (/^\d$/.test(key)) code = `Digit${key}`
  else if (/^F([1-9]|1[0-2])$/.test(key)) code = key
  if (!code || !key) return null
  const has = (mod) => parts.includes(mod)
  return {
    code,
    // The printed key for a character, the key's own name otherwise
    // (ArrowLeft, Tab, F5): the layer reads `code`, this is for anyone else.
    key: key.length === 1 ? key.toLowerCase() : code,
    ctrlKey: mac ? has('Ctrl') : has('Mod') || has('Ctrl'),
    metaKey: mac && has('Mod'),
    altKey: has('Alt'),
    shiftKey: has('Shift'),
    bubbles: true,
    cancelable: true,
  }
}
