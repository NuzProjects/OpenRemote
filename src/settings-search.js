// Settings sections and the index behind the settings search. Pure - no
// React, no DOM - so the ranking is tested directly under node:test.
//
// One entry per settings row: the label and detail read as the row reads,
// and `terms` carry the words a person might search for instead (theme,
// shortcut, port). A new row in SettingsView belongs here too, or the
// search cannot find it.

import { ACTIONS, GROUPS, fuzzyScore } from './shortcuts.js'

// The sidebar's category order. A section names its group by id; the tab
// list renders one small label per group.
export const SETTING_GROUPS = [
  { id: 'general', label: 'General' },
  { id: 'system', label: 'System' },
  { id: 'chats', label: 'Chats' },
  { id: 'about', label: 'About' },
]

export const SECTIONS = [
  { id: 'new-tasks', label: 'New tasks', icon: 'sparkle', group: 'general', phone: false },
  { id: 'appearance', label: 'Appearance', icon: 'palette', group: 'general', phone: true },
  { id: 'startup', label: 'Startup', icon: 'power', group: 'general', phone: false },
  { id: 'keyboard', label: 'Keyboard', icon: 'keyboard', group: 'general', phone: false },
  { id: 'cloud', label: 'Cloud', icon: 'cloud', group: 'system', phone: true },
  { id: 'daemon', label: 'Daemon', icon: 'terminal', group: 'system', phone: false },
  { id: 'harnesses', label: 'Harnesses', icon: 'robot', group: 'system', phone: false },
  { id: 'mcp-servers', label: 'MCP servers', icon: 'plugs', group: 'system', phone: false },
  { id: 'models', label: 'Models', icon: 'shapes', group: 'system', phone: false },
  { id: 'archived', label: 'Archived chats', icon: 'archive', group: 'chats', phone: true },
  { id: 'this-install', label: 'This install', icon: 'info', group: 'about', phone: true },
]

// A section's own search result: the tab itself is a destination, even
// before any of its rows have data to show.
const BLURBS = {
  'new-tasks': 'What a new chat starts with.',
  appearance: 'How the console looks and moves.',
  startup: 'What the app does when it opens.',
  keyboard: 'Keys for every action.',
  cloud: 'Your account and this device.',
  daemon: 'The local process chats run through.',
  harnesses: 'What the daemon can drive on this machine.',
  'mcp-servers': 'Tools a session can call.',
  models: 'Custom model endpoints on this computer.',
  archived: 'Chats hidden on this computer.',
  'this-install': 'The build you are running and the first-run steps.',
}

const SECTION_LABEL = Object.fromEntries(SECTIONS.map((s) => [s.id, s.label]))
const GROUP_LABEL = Object.fromEntries(GROUPS.map((g) => [g.id, g.label]))

const row = (key, section, label, detail, terms) => ({ key, section, label, detail, terms })

const ROWS = [
  row('new-tasks-harness', 'new-tasks', 'Harness', 'What a new task starts on.', ['default', 'agent', 'cli', 'start']),
  row('new-tasks-model', 'new-tasks', 'Model', "The harness's own catalog.", ['default', 'catalog']),
  row('new-tasks-effort', 'new-tasks', 'Effort', "The model's own reasoning tiers.", ['reasoning', 'tier', 'thinking', 'depth']),
  row('new-tasks-permission', 'new-tasks', 'Permission', 'What the harness may do without asking.', ['approval', 'ask', 'mode']),
  row('new-tasks-projects', 'new-tasks', 'Projects', 'The folders whose chats group under their project.', ['folder', 'workspace', 'group']),

  row('appearance-density', 'appearance', 'Compact density', 'Pulls the rows and gutters in.', ['spacing', 'layout', 'comfortable']),
  row('appearance-motion', 'appearance', 'Reduce motion', 'Stops the running-dot breathe and picker transitions.', ['animation', 'accessibility', 'transition']),
  row('appearance-privacy', 'appearance', 'Privacy mode', 'Blurs titles, paths, and the transcript for recordings.', ['blur', 'recording', 'stream', 'hide', 'screen']),

  row('startup-reopen', 'startup', 'Reopen', 'The view you left, or always New chat.', ['startup', 'last view', 'new chat', 'boot']),
  row('startup-launch', 'startup', 'Launch at login', 'Starts OpenRemote when you sign in to this computer.', ['autostart', 'boot', 'windows']),
  row('startup-tray', 'startup', 'Keep running in the tray', 'Closing the window leaves OpenRemote running.', ['background', 'close', 'quit', 'tray']),

  row('cloud-account', 'cloud', 'Account', "Your moreweb account and this device's place in it.", ['sign in', 'sign out', 'email', 'sync', 'device']),

  row('daemon-connection', 'daemon', 'Daemon connection', 'The local process the chats run through.', ['connect', 'connection', 'token', 'local']),
  row('daemon-chats', 'daemon', 'Chats on record', 'Sessions survive daemon restarts; stopped ones can resume.', ['sessions', 'record', 'history', 'resume']),
  row('daemon-address', 'daemon', 'Daemon address', 'The local address the console talks to.', ['url', 'port', 'data', 'folder', 'path']),
  row('daemon-restart', 'daemon', 'Restart', 'Stops running chats and starts a fresh daemon.', ['stop', 'start', 'daemon']),

  row('mcp-add', 'mcp-servers', 'Add an MCP server', 'Its launch command, as the machine would start it.', ['tool', 'add', 'command', 'server']),
  row('models-endpoint-add', 'models', 'Add a model endpoint', 'A base URL on this machine or network that lists models.', ['endpoint', 'gateway', 'custom', 'model', 'base url', 'relay', 'self-hosted']),

  row('install-version', 'this-install', 'OpenRemote version', 'The build and the daemon it talks to.', ['about', 'build', 'release', 'update', 'daemon']),
  row('install-first-run', 'this-install', 'First-run steps', 'Shows them again. The chats stay.', ['onboarding', 'setup', 'replay', 'welcome']),
]

const KEYBOARD = ACTIONS.map((a) =>
  row(
    `keyboard-${a.id}`,
    'keyboard',
    a.label,
    `Shortcut in the ${GROUP_LABEL[a.group] ?? a.group} group.`,
    ['shortcut', 'hotkey', 'key', 'binding'],
  ),
)

// The section's own result points at the tab's element (data-stg="<id>").
const SECTION_ROWS = SECTIONS.map((s) => row(s.id, s.id, s.label, BLURBS[s.id] ?? '', [s.id]))

export const SETTINGS_ENTRIES = [...SECTION_ROWS, ...ROWS, ...KEYBOARD]

// Which searchable text matched, and how far down the row it sits: the
// label beats a keyword, a keyword beats the row's section name, and the
// detail line is the weakest.
const WEIGHT = { terms: -20, section: -30, detail: -40 }

function scoreEntry(query, entry) {
  const scores = []
  const label = fuzzyScore(query, entry.label)
  if (label !== null) scores.push(label)
  for (const term of entry.terms) {
    const score = fuzzyScore(query, term)
    if (score !== null) scores.push(score + WEIGHT.terms)
  }
  const section = fuzzyScore(query, SECTION_LABEL[entry.section] ?? '')
  if (section !== null) scores.push(section + WEIGHT.section)
  const detail = fuzzyScore(query, entry.detail)
  if (detail !== null) scores.push(detail + WEIGHT.detail)
  return scores.length ? Math.max(...scores) : null
}

export function searchSettings(query, entries = SETTINGS_ENTRIES) {
  const q = query.trim()
  if (!q) return []
  return entries
    .map((entry, index) => ({ entry, index, score: scoreEntry(q, entry) }))
    .filter((r) => r.score !== null)
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map((r) => r.entry)
}

export function visibleSections(mobile) {
  return mobile ? SECTIONS.filter((s) => s.phone) : SECTIONS
}
