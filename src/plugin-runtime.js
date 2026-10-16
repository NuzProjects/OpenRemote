// The JavaScript plugin runtime's rules, kept free of React and the DOM so
// they are tested directly: what a plugin's openremote.json contributes to
// the console, which calls a plugin's powers answer, where text a plugin
// writes lands in a composer, and the page every plugin frame boots from.

// The icons a plugin may name for its sidebar tile and composer button,
// drawn from the console's own icon set (plugin-icons.jsx). Any other
// name gets the plugin piece.
export const PLUGIN_ICONS = [
  'microphone',
  'waveform',
  'translate',
  'sparkle',
  'magic-wand',
  'note-pencil',
  'notebook',
  'book-open',
  'list-checks',
  'chat-circle',
  'camera',
  'image',
  'paperclip',
  'globe',
  'code',
  'terminal',
  'robot',
  'lightning',
  'clock',
  'calendar',
  'chart-bar',
  'puzzle-piece',
]

export const SETTING_TYPES = ['string', 'secret', 'boolean', 'number', 'enum']

// A plugin adds at most this much to the console: a composer foot has
// little room, and a sidebar group of a dozen tiles is a second sidebar.
export const MAX_INPUTS = 3
export const MAX_VIEWS = 6

const ID = /^[a-z0-9][a-z0-9-]{0,39}$/
const KEY = /^[a-z0-9_]{1,64}$/

// The calls a frame's API makes, and the power each one needs. A call not
// here needs nothing beyond being the plugin's own: its settings, its
// files, its toasts and views.
export const CALL_POWER = {
  'chats.list': 'read_chats',
  'chats.read': 'read_chats',
  'chats.start': 'agent_tools',
  'chats.steer': 'agent_tools',
  'chats.stop': 'agent_tools',
  fetch: 'network',
}
const OWN_CALLS = new Set(['settings.get', 'files.read', 'ui.toast', 'ui.openView', 'ui.openSettings'])
const COMPOSER_CALLS = new Set(['composer.insert', 'composer.attach', 'composer.setState'])

const POWER_WORDS = {
  run_programs: 'run programs',
  read_chats: 'read chats',
  agent_tools: 'start, steer and stop chats',
  network: 'reach the internet',
  microphone: 'use the microphone',
}

// A path inside the plugin's folder, the way the daemon's files route
// takes it: relative, forward slashes, never climbing out.
export function insidePath(path) {
  return (
    typeof path === 'string' &&
    path.length > 0 &&
    !path.startsWith('/') &&
    !path.includes('\\') &&
    !path.includes(':') &&
    path.split('/').every((part) => part !== '..')
  )
}

const text = (value, max = 60) =>
  typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : null

const iconName = (value) => (PLUGIN_ICONS.includes(value) ? value : 'puzzle-piece')

// A plugin's name as people read it: its own displayName, else its id's
// name with the first letter raised ("dictation" reads "Dictation").
export function displayName(manifest, plugin) {
  const own = text(manifest?.displayName, 40)
  if (own) return own
  const name = plugin?.name ?? ''
  return name ? name[0].toUpperCase() + name.slice(1).replace(/-/g, ' ') : 'Plugin'
}

// The settings a plugin declares, as the form draws them. A malformed
// entry is left out rather than breaking the plugin's whole page.
export function readSettings(list) {
  const seen = new Set()
  const out = []
  for (const raw of Array.isArray(list) ? list : []) {
    if (!raw || typeof raw !== 'object') continue
    if (!KEY.test(raw.key ?? '') || seen.has(raw.key) || !SETTING_TYPES.includes(raw.type)) continue
    const options =
      raw.type === 'enum'
        ? (Array.isArray(raw.options) ? raw.options : [])
            .map((o) =>
              typeof o === 'string'
                ? { value: o, label: o }
                : o && typeof o.value === 'string'
                  ? { value: o.value, label: text(o.label, 60) ?? o.value }
                  : null,
            )
            .filter(Boolean)
        : []
    if (raw.type === 'enum' && !options.length) continue
    seen.add(raw.key)
    out.push({
      key: raw.key,
      type: raw.type,
      label: text(raw.label, 60) ?? raw.key,
      help: text(raw.help, 300),
      placeholder: text(raw.placeholder, 80),
      default: raw.default ?? null,
      options,
      min: typeof raw.min === 'number' ? raw.min : null,
      max: typeof raw.max === 'number' ? raw.max : null,
      sendTo: raw.type === 'secret' && typeof raw.sendTo === 'string' ? raw.sendTo : null,
    })
  }
  return out
}

// What a plugin's openremote.json adds to the console: its page (entry),
// the buttons it puts in the composer's foot, the views it opens in a
// pane, whether its page runs from the start (background), and its
// settings. A composer button or view whose page is missing is left out -
// a control that can do nothing is never drawn.
export function readContributions(manifest) {
  const m = manifest && typeof manifest === 'object' ? manifest : {}
  const entry = insidePath(m.entry) ? m.entry : null
  const contributes = m.contributes && typeof m.contributes === 'object' ? m.contributes : {}
  const ids = new Set()
  const fresh = (item) => item && typeof item === 'object' && ID.test(item.id ?? '') && !ids.has(item.id)
  const inputs = []
  for (const item of Array.isArray(contributes.composer) ? contributes.composer : []) {
    if (!entry || !fresh(item) || inputs.length >= MAX_INPUTS) continue
    ids.add(item.id)
    inputs.push({ id: item.id, label: text(item.label, 40) ?? item.id, icon: iconName(item.icon) })
  }
  const views = []
  for (const item of Array.isArray(contributes.views) ? contributes.views : []) {
    if (!fresh(item) || views.length >= MAX_VIEWS) continue
    const page = insidePath(item.entry) ? item.entry : entry
    if (!page) continue
    ids.add(item.id)
    views.push({ id: item.id, title: text(item.title, 40) ?? item.id, icon: iconName(item.icon), entry: page })
  }
  return {
    entry,
    inputs,
    views,
    background: Boolean(contributes.background) && Boolean(entry),
    settings: readSettings(m.settings),
  }
}

// Why a frame's call is refused, in plain words, or null when the plugin
// may make it. `plugin` is { name, powers, inputs }.
export function refusal(call, { name = 'This plugin', powers = [], inputs = [] } = {}) {
  const power = CALL_POWER[call]
  if (power) {
    return powers.includes(power)
      ? null
      : `${name} may not ${POWER_WORDS[power]}: that power was not approved when it was installed.`
  }
  if (OWN_CALLS.has(call)) return null
  if (COMPOSER_CALLS.has(call)) {
    return inputs.length ? null : `${name} adds nothing to the composer, so it can't write in one.`
  }
  return `There is no openremote call named ${call}.`
}

// Text a plugin writes going in at the cursor, or over the selection. A
// word set right after another word gets a space between them, and one
// before the word that follows, so a dictated phrase never runs into
// what is already there. Answers the new text and where the cursor goes.
export function insertAt(value, start, end, piece) {
  const current = String(value ?? '')
  const s = Math.max(0, Math.min(Number.isInteger(start) ? start : current.length, current.length))
  const e = Math.max(s, Math.min(Number.isInteger(end) ? end : s, current.length))
  const before = current.slice(0, s)
  const after = current.slice(e)
  let middle = String(piece ?? '')
  if (middle && before && !/[\s([{"'“‘]$/u.test(before) && /^[\p{L}\p{N}"'“‘(]/u.test(middle)) {
    middle = ` ${middle}`
  }
  if (middle && after && /^[\p{L}\p{N}]/u.test(after) && !/\s$/u.test(middle)) {
    middle = `${middle} `
  }
  return { text: before + middle + after, caret: before.length + middle.length }
}

// A plugin view's place in the app's navigation: the view id the history,
// the hash and the split panes carry.
export const VIEW_PREFIX = 'plugin:'

export const isPluginView = (view) => typeof view === 'string' && view.startsWith(VIEW_PREFIX)

export function viewKey(pluginId, viewId) {
  return `${VIEW_PREFIX}${pluginId}/${viewId}`
}

export function parseViewKey(key) {
  if (!isPluginView(key)) return null
  const rest = key.slice(VIEW_PREFIX.length)
  const at = rest.lastIndexOf('/')
  if (at <= 0 || at === rest.length - 1) return null
  return { pluginId: rest.slice(0, at), viewId: rest.slice(at + 1) }
}

// The anchor of a plugin's own part of Settings.
export function settingsAnchor(pluginId) {
  return `stg-plugin-${String(pluginId).replace(/[^a-z0-9]+/gi, '-')}`
}

// The policy every plugin frame runs under, on top of the console's own:
// scripts come only from the console's bridge and from the plugin's own
// files (turned into blob: scripts inside the frame), and the frame
// reaches no address itself - the network is openremote.fetch, made by
// the daemon for a plugin given it.
export function frameCsp(consoleOrigin) {
  return [
    "default-src 'none'",
    `script-src ${consoleOrigin} blob:`,
    "style-src 'unsafe-inline' blob: data:",
    'img-src data: blob:',
    'font-src data: blob:',
    'media-src blob: data:',
    "connect-src 'none'",
    "frame-src 'none'",
    'worker-src blob:',
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
  ].join('; ')
}

const attr = (value) => String(value).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;')

// The page a plugin frame boots from: the policy above, then the bridge,
// which asks the console for the plugin's own page and builds it.
export function frameDocument(consoleOrigin) {
  return (
    '<!doctype html><html><head><meta charset="utf-8">' +
    `<meta http-equiv="Content-Security-Policy" content="${attr(frameCsp(consoleOrigin))}">` +
    '<meta name="referrer" content="no-referrer">' +
    `<script src="${attr(consoleOrigin)}/plugin-bridge.js"></script>` +
    '</head><body></body></html>'
  )
}

// The chats as a plugin that may read them lists them: what the sidebar
// shows, nothing of the transcripts. The status is the daemon's own word
// (starting, working, waiting, idle, stopped, failed).
export function chatSummaries(sessions, chats = {}) {
  return (sessions ?? []).map((s) => ({
    id: s.id,
    title: chats[s.id]?.title ?? s.title ?? null,
    harness: s.harness,
    status: s.status ?? null,
    workspace: s.workspace ?? null,
    updatedAt: s.updated_at ?? null,
    synced: Boolean(s.executor),
  }))
}

// What a plugin's message into a chat does, by the chat's status: steer
// it into a working turn, start a turn on a chat at rest, or nothing on
// one that has stopped (it needs Resume first).
export function steerAction(status) {
  if (status === 'working' || status === 'waiting') return 'steer'
  if (status === 'stopped' || status === 'failed') return null
  return 'prompt'
}

// A setting's value as the form shows it: the saved one, else the
// plugin's default.
export function shownValue(setting, values) {
  const saved = values?.[setting.key]
  return saved === undefined || saved === null ? setting.default : saved
}

// The settings as a plugin reads them: every value it declares (its
// default where none was saved) and every secret as 'set' or 'unset' -
// whatever the daemon's answer leaves out.
export function withDefaults(view, settings) {
  const values = { ...(view?.values ?? {}) }
  const secrets = { ...(view?.secrets ?? {}) }
  for (const setting of settings ?? []) {
    if (setting.type === 'secret') secrets[setting.key] ??= 'unset'
    else values[setting.key] = shownValue(setting, values)
  }
  return { values, secrets }
}

// What a field's raw input means for its setting: the value to save (null
// goes back to the plugin's default), or the words for what is wrong.
export function parseInput(setting, raw) {
  if (setting.type === 'number') {
    if (raw === '' || raw == null) return { value: null }
    const n = Number(raw)
    if (!Number.isFinite(n)) return { error: `${setting.label} takes a number.` }
    if (setting.min != null && n < setting.min) return { error: `${setting.label} is at least ${setting.min}.` }
    if (setting.max != null && n > setting.max) return { error: `${setting.label} is at most ${setting.max}.` }
    return { value: n }
  }
  if (setting.type === 'boolean') return { value: Boolean(raw) }
  if (setting.type === 'enum') {
    return setting.options.some((o) => o.value === raw)
      ? { value: raw }
      : { error: `${raw} is not one of ${setting.label}'s choices.` }
  }
  return { value: String(raw ?? '') }
}

// Bytes to base64 and back, for request and answer bodies on their way
// through the daemon's JSON. Large bodies go in slices: one huge
// String.fromCharCode call overflows the stack.
export function toBase64(bytes) {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
  if (typeof view.toBase64 === 'function') return view.toBase64()
  let binary = ''
  for (let i = 0; i < view.length; i += 0x8000) {
    binary += String.fromCharCode.apply(null, view.subarray(i, i + 0x8000))
  }
  return btoa(binary)
}

export function fromBase64(encoded) {
  if (typeof Uint8Array.fromBase64 === 'function') return Uint8Array.fromBase64(encoded ?? '')
  const binary = atob(encoded ?? '')
  const out = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i)
  return out
}
