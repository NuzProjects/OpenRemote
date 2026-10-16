// Keyboard shortcuts: the action catalog, key normalization, labels, and
// the user's own bindings. Pure - no DOM, no React - so the rules are
// tested directly; keyboard.jsx wires them to the window.
//
// A combo is a string like `Mod+Shift+A`. `Mod` is the platform's primary
// modifier - Ctrl on Windows and Linux, Cmd on macOS - so one default map
// serves every desktop. `Ctrl` in a combo is only ever the literal
// Control key on macOS (on the others it is `Mod`).

const PREFS_KEY = 'openremote-shortcuts'

// Every action that can carry a key, in the order the cheat sheet and the
// Keyboard settings list them. `keys` is the default (null: unbound by
// default, reachable from the palette and bindable).
export const GROUPS = [
  { id: 'navigation', label: 'Navigation' },
  { id: 'chat', label: 'Chat' },
  { id: 'pickers', label: 'Pickers' },
  { id: 'layout', label: 'Layout' },
  { id: 'browser', label: 'Browser' },
]

const modelSwitches = Array.from({ length: 9 }, (_, i) => ({
  id: `model-${i + 1}`,
  group: 'pickers',
  label: `Switch to model ${i + 1}`,
  keys: `Mod+Alt+${i + 1}`,
}))

export const ACTIONS = [
  { id: 'new-chat', group: 'navigation', label: 'New chat', keys: 'Mod+N' },
  { id: 'palette', group: 'navigation', label: 'Command palette', keys: 'Mod+K' },
  { id: 'cheat-sheet', group: 'navigation', label: 'Keyboard shortcuts', keys: 'Mod+/' },
  { id: 'search-chats', group: 'navigation', label: 'Search chats', keys: 'Mod+F' },
  { id: 'next-chat', group: 'navigation', label: 'Next chat', keys: 'Alt+Down' },
  { id: 'prev-chat', group: 'navigation', label: 'Previous chat', keys: 'Alt+Up' },
  { id: 'first-chat', group: 'navigation', label: 'First chat', keys: 'Alt+Home' },
  { id: 'last-chat', group: 'navigation', label: 'Last chat', keys: 'Alt+End' },
  { id: 'view-settings', group: 'navigation', label: 'Settings', keys: 'Mod+,' },
  { id: 'view-automations', group: 'navigation', label: 'Automations', keys: null },
  { id: 'view-plugins', group: 'navigation', label: 'Plugins', keys: null },
  { id: 'view-machines', group: 'navigation', label: 'Machines', keys: null },
  { id: 'view-account', group: 'navigation', label: 'Account', keys: null },
  { id: 'view-mobile', group: 'navigation', label: 'Mobile', keys: null },
  { id: 'view-metrics', group: 'navigation', label: 'Metrics', keys: null },
  { id: 'focus-composer', group: 'chat', label: 'Focus the composer', keys: 'Mod+L' },
  { id: 'steer', group: 'chat', label: 'Steer', keys: 'Mod+Enter' },
  { id: 'interrupt', group: 'chat', label: 'Interrupt the turn', keys: 'Esc' },
  { id: 'stop', group: 'chat', label: 'Stop the session', keys: 'Mod+Shift+X' },
  { id: 'archive', group: 'chat', label: 'Archive the chat', keys: 'Mod+Shift+A' },
  { id: 'pick-model', group: 'pickers', label: 'Model', keys: 'Mod+M' },
  { id: 'pick-effort', group: 'pickers', label: 'Effort', keys: 'Mod+E' },
  { id: 'pick-permission', group: 'pickers', label: 'Permission', keys: 'Mod+P' },
  { id: 'pick-harness', group: 'pickers', label: 'Harness (new chat)', keys: 'Mod+H' },
  { id: 'toggle-fast', group: 'pickers', label: 'Fast on or off', keys: 'Mod+Shift+F' },
  ...modelSwitches,
  { id: 'toggle-sidebar', group: 'layout', label: 'Show or hide the sidebar', keys: 'Mod+B' },
  { id: 'toggle-mode', group: 'layout', label: 'Switch Local and Cloud', keys: 'Mod+Shift+M' },
  { id: 'split-right', group: 'layout', label: 'Split right', keys: 'Mod+\\' },
  { id: 'split-down', group: 'layout', label: 'Split down', keys: 'Mod+Shift+\\' },
  { id: 'close-pane', group: 'layout', label: 'Close the pane', keys: 'Mod+W' },
]

// The built-in browser's keys: Chrome's, acting only while the browser has
// focus (its tab strip, toolbar or page). They live in a scope of their
// own, so Ctrl+W can close a tab in the browser and the pane everywhere
// else; a key moves between actions only inside its scope.
export const BROWSER_ACTIONS = [
  { id: 'browser-new-tab', group: 'browser', label: 'New tab', keys: 'Mod+T' },
  { id: 'browser-private-tab', group: 'browser', label: 'New private tab', keys: 'Mod+Shift+N' },
  { id: 'browser-close-tab', group: 'browser', label: 'Close the tab', keys: 'Mod+W' },
  { id: 'browser-reopen-tab', group: 'browser', label: 'Reopen the closed tab', keys: 'Mod+Shift+T' },
  { id: 'browser-next-tab', group: 'browser', label: 'Next tab', keys: 'Mod+Tab' },
  { id: 'browser-prev-tab', group: 'browser', label: 'Previous tab', keys: 'Mod+Shift+Tab' },
  { id: 'browser-address', group: 'browser', label: 'Go to the address bar', keys: 'Mod+L' },
  { id: 'browser-back', group: 'browser', label: 'Back', keys: 'Alt+Left' },
  { id: 'browser-forward', group: 'browser', label: 'Forward', keys: 'Alt+Right' },
  { id: 'browser-reload', group: 'browser', label: 'Reload', keys: 'Mod+R' },
  { id: 'browser-reload-key', group: 'browser', label: 'Reload, second key', keys: 'F5' },
  { id: 'browser-find', group: 'browser', label: 'Find in page', keys: 'Mod+F' },
  { id: 'browser-bookmark', group: 'browser', label: 'Bookmark this tab', keys: 'Mod+D' },
  { id: 'browser-bookmarks-bar', group: 'browser', label: 'Show or hide the bookmarks bar', keys: 'Mod+Shift+B' },
  { id: 'browser-history', group: 'browser', label: 'History', keys: 'Mod+H' },
  { id: 'browser-downloads', group: 'browser', label: 'Downloads', keys: 'Mod+J' },
  { id: 'browser-zoom-in', group: 'browser', label: 'Zoom in', keys: 'Mod+=' },
  { id: 'browser-zoom-out', group: 'browser', label: 'Zoom out', keys: 'Mod+-' },
  { id: 'browser-zoom-reset', group: 'browser', label: 'Actual size', keys: 'Mod+0' },
]

// Every action, app and browser, in the order Settings and the cheat
// sheet list them.
export const CATALOG = [...ACTIONS, ...BROWSER_ACTIONS]

// Where each action's key is looked up: the browser's scope first (its
// actions only answer while it has focus), then the app's.
export const SCOPES = { browser: BROWSER_ACTIONS, app: ACTIONS }

// macOS keeps Cmd+H (hide), Cmd+M (minimize) and Cmd+W (close the
// window) for itself, so those three actions default to Option+Cmd there.
// The browser's keys follow Chrome for the Mac where Cmd+Tab (switching
// apps) or Option+arrows (moving by word) would clash.
const MAC_KEYS = {
  'pick-harness': 'Mod+Alt+H',
  'pick-model': 'Mod+Alt+M',
  'close-pane': 'Mod+Alt+W',
  'browser-close-tab': 'Mod+Alt+W',
  'browser-next-tab': 'Ctrl+Tab',
  'browser-prev-tab': 'Ctrl+Shift+Tab',
  'browser-back': 'Mod+[',
  'browser-forward': 'Mod+]',
  'browser-history': 'Mod+Y',
  'browser-downloads': 'Mod+Shift+J',
}

const ACTION_IDS = new Set(CATALOG.map((a) => a.id))
const BROWSER_IDS = new Set(BROWSER_ACTIONS.map((a) => a.id))

function scopeOf(id) {
  return BROWSER_IDS.has(id) ? SCOPES.browser : SCOPES.app
}

// The default key for an action on this platform.
export function defaultKey(id, mac = false) {
  if (mac && Object.hasOwn(MAC_KEYS, id)) return MAC_KEYS[id]
  return CATALOG.find((a) => a.id === id)?.keys ?? null
}

const MOD_ORDER = ['Mod', 'Ctrl', 'Alt', 'Shift']

// e.code, not e.key: the physical key, so a binding survives keyboard
// layouts and Shift never turns `\` into `|` or `1` into `!`.
const CODE_KEYS = {
  Backslash: '\\',
  IntlBackslash: '\\',
  Slash: '/',
  Comma: ',',
  Period: '.',
  Semicolon: ';',
  Quote: "'",
  BracketLeft: '[',
  BracketRight: ']',
  Minus: '-',
  Equal: '=',
  Backquote: '`',
  ArrowUp: 'Up',
  ArrowDown: 'Down',
  ArrowLeft: 'Left',
  ArrowRight: 'Right',
  Home: 'Home',
  End: 'End',
  PageUp: 'PageUp',
  PageDown: 'PageDown',
  Escape: 'Esc',
  Enter: 'Enter',
  NumpadEnter: 'Enter',
  Space: 'Space',
  Tab: 'Tab',
  Backspace: 'Backspace',
  Delete: 'Delete',
}

const MODIFIER_CODES = /^(Shift|Control|Alt|Meta|OS)(Left|Right)?$/

function keyName(code, key) {
  if (!code) {
    // No physical code (some virtual keyboards): the printed character.
    return typeof key === 'string' && key.length === 1 ? key.toUpperCase() : null
  }
  if (MODIFIER_CODES.test(code)) return null
  let m = /^Key([A-Z])$/.exec(code)
  if (m) return m[1]
  m = /^(?:Digit|Numpad)(\d)$/.exec(code)
  if (m) return m[1]
  if (/^F([1-9]|1[0-2])$/.test(code)) return code
  return CODE_KEYS[code] ?? null
}

// The combo a keydown event spells, or null for a lone modifier, an
// unknown key, or the Windows key on Windows/Linux (never ours to take).
export function comboFromEvent(e, mac) {
  if (!mac && e.metaKey) return null
  const key = keyName(e.code, e.key)
  if (!key) return null
  const mods = {
    Mod: mac ? e.metaKey : e.ctrlKey,
    Ctrl: mac ? e.ctrlKey : false,
    Alt: e.altKey,
    Shift: e.shiftKey,
  }
  return [...MOD_ORDER.filter((m) => mods[m]), key].join('+')
}

const COMBO_RE = /^((Mod|Ctrl|Alt|Shift)\+)*[^+]+$/

function validCombo(combo) {
  return typeof combo === 'string' && combo.length > 0 && COMBO_RE.test(combo)
}

const KEY_GLYPHS = { Up: '↑', Down: '↓', Left: '←', Right: '→' }
const MAC_MODS = { Mod: '⌘', Ctrl: '⌃', Alt: '⌥', Shift: '⇧' }

function splitCombo(combo) {
  // Modifiers lead; the key is last (no key name contains a `+`).
  const parts = combo.split('+')
  const key = parts.pop()
  return { mods: parts, key }
}

// What a combo looks like on this platform: `Ctrl+Shift+A` on Windows and
// Linux, `⌘⇧A` on macOS.
export function comboLabel(combo, mac) {
  if (!combo) return ''
  const { mods, key } = splitCombo(combo)
  const k = KEY_GLYPHS[key] ?? key
  if (mac) return mods.map((m) => MAC_MODS[m] ?? m).join('') + k
  return [...mods.map((m) => (m === 'Mod' ? 'Ctrl' : m)), k].join('+')
}

// Whether a combo may fire while the user is typing in a field. A bare
// key (or Shift+key) would eat the character the user meant to type, so
// only combos with Ctrl/Cmd/Alt, Esc, or a function key pass.
export function firesWhileTyping(combo) {
  const { mods, key } = splitCombo(combo)
  return mods.some((m) => m === 'Mod' || m === 'Ctrl' || m === 'Alt') || key === 'Esc' || /^F\d+$/.test(key)
}

// The user's changes to the default map: { actionId: combo | null }, null
// meaning deliberately unbound. Unknown actions and malformed combos are
// dropped, never trusted.
export function loadOverrides() {
  let raw = {}
  try {
    raw = JSON.parse(localStorage.getItem(PREFS_KEY) ?? '{}')
  } catch {
    raw = {}
  }
  const out = {}
  if (raw && typeof raw === 'object') {
    for (const [id, combo] of Object.entries(raw)) {
      if (!ACTION_IDS.has(id)) continue
      if (combo === null || validCombo(combo)) out[id] = combo
    }
  }
  return out
}

export function saveOverrides(overrides) {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(overrides))
  } catch {
    /* storage unavailable */
  }
}

// Every action's live combo within one scope: the user's choice where they
// made one, else the default - but a default never shares a key with a
// user's choice (the user's choice wins; the default is shadowed to
// unbound).
function scopeBindings(list, overrides, mac) {
  const out = {}
  const taken = new Set()
  for (const a of list) {
    if (Object.hasOwn(overrides, a.id)) {
      out[a.id] = overrides[a.id]
      if (overrides[a.id]) taken.add(overrides[a.id])
    }
  }
  for (const a of list) {
    if (Object.hasOwn(out, a.id)) continue
    const key = defaultKey(a.id, mac)
    out[a.id] = key && !taken.has(key) ? key : null
    if (out[a.id]) taken.add(out[a.id])
  }
  return out
}

// The app's own actions and their live keys.
export function effectiveBindings(overrides, mac = false) {
  return scopeBindings(ACTIONS, overrides, mac)
}

// Every scope's live keys: { app, browser }.
export function scopedBindings(overrides, mac = false) {
  return {
    app: scopeBindings(SCOPES.app, overrides, mac),
    browser: scopeBindings(SCOPES.browser, overrides, mac),
  }
}

export function actionForCombo(bindings, combo) {
  for (const [id, c] of Object.entries(bindings)) if (c === combo) return id
  return null
}

// Taking a key another action of the same scope holds moves it: the new
// action gets the key, the other is left unbound. Returns the new
// overrides and the actions that lost their key (for the "moved from"
// message).
export function rebind(overrides, actionId, combo, mac = false) {
  const before = scopeBindings(scopeOf(actionId), overrides, mac)
  const displaced = Object.keys(before).filter((id) => id !== actionId && before[id] === combo)
  const next = { ...overrides, [actionId]: combo }
  for (const id of displaced) next[id] = null
  return { overrides: next, displaced }
}

export function unbind(overrides, actionId) {
  return { ...overrides, [actionId]: null }
}

// Back to the default key. If another action of its scope took that key
// meanwhile, it gives it back and is left unbound - the same rule as a
// rebind.
export function resetOne(overrides, actionId, mac = false) {
  const next = { ...overrides }
  delete next[actionId]
  const key = defaultKey(actionId, mac)
  if (!key) return next
  const live = scopeBindings(scopeOf(actionId), next, mac)
  if (live[actionId] === key) return next
  for (const [id, combo] of Object.entries(live)) {
    if (id !== actionId && combo === key) next[id] = null
  }
  return next
}

export function isOverridden(overrides, actionId) {
  return Object.hasOwn(overrides, actionId)
}

// The palette's ranking: a whole substring beats a scattered match, a
// match at a word's start beats one inside it, and consecutive letters
// beat gaps. Null when the text doesn't contain the query's letters in
// order at all.
export function fuzzyScore(query, text) {
  const q = query.trim().toLowerCase()
  if (!q) return 0
  const t = String(text ?? '').toLowerCase()
  const at = t.indexOf(q)
  if (at !== -1) {
    const wordStart = at === 0 || /[\s\-_/.\\]/.test(t[at - 1])
    return 1000 + (wordStart ? 200 : 0) - at - (t.length - q.length) * 0.1
  }
  let from = 0
  let prev = -2
  let run = 0
  let score = 0
  for (const ch of q) {
    if (ch === ' ') continue
    const found = t.indexOf(ch, from)
    if (found === -1) return null
    const wordStart = found === 0 || /[\s\-_/.\\]/.test(t[found - 1])
    run = found === prev + 1 ? run + 1 : 0
    score += 10 + run * 5 + (wordStart ? 15 : 0) - Math.min(found - from, 10)
    prev = found
    from = found + 1
  }
  return score
}

// Items that match, best first; ties keep their given order.
export function rankMatches(query, items, textOf) {
  return items
    .map((item, i) => ({ item, i, score: fuzzyScore(query, textOf(item)) }))
    .filter((r) => r.score !== null)
    .sort((a, b) => b.score - a.score || a.i - b.i)
    .map((r) => r.item)
}
