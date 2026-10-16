// The words the Plugins page and its Install dialog use for a plugin -
// one place, so the approval screen and the installed row never disagree.
// Pure: tested without a DOM.

export const RUNTIME_LABEL = {
  process: 'Program',
  js: 'JavaScript, sandboxed',
  wasm: 'WebAssembly, sandboxed',
  content: 'Claude plugin',
}

// Each power in plain words, as the user approves it.
export const POWER_LABEL = {
  run_programs: 'Run programs on this computer',
  read_chats: 'Read chats and project files',
  agent_tools: 'Give agents tools, and start, steer and stop chats',
  network: 'Reach the internet',
  microphone: 'Use the microphone',
}

export const POWER_SHORT = {
  run_programs: 'Runs programs',
  read_chats: 'Reads chats',
  agent_tools: 'Agent tools',
  network: 'Network',
  microphone: 'Microphone',
}

export const CLAUDE_PART_LABEL = {
  skills: 'skills',
  agents: 'agents',
  commands: 'commands',
  hooks: 'hooks',
  mcp: 'MCP servers',
}

// Who a plugin is for, as the install screen offers it.
export const SCOPE_LABEL = {
  global: 'Every device',
  machine: 'This machine',
  project_local: 'One project, outside its repo',
  project: 'One project, in its repo',
}

// What each scope means, under the picker.
export const SCOPE_HINT = {
  global: 'Approved once for your account and installed on each of your devices. Any device can turn it off for itself.',
  machine: 'Only this computer gets it.',
  project_local: "Only chats in the project get it. Its files stay in OpenRemote's folder.",
  project:
    'Only chats in the project get it. Its files go into the project at .openremote/plugins, so whoever clones it has them - and reviews it before it runs.',
}

// The scope an installed row shows; a project install names its project.
export function scopeLabel(plugin, projectName) {
  const project = projectName ? `Project ${projectName}` : 'A project'
  if (plugin.scope === 'project_local') return project
  if (plugin.scope === 'project') return `${project}, in its repo`
  return SCOPE_LABEL[plugin.scope] ?? plugin.scope
}

// The scope the install screen starts on: where the copy it replaces is,
// the project it was read from, else this machine - if allowed.
export function defaultScope(staged) {
  const allowed = staged?.scopes ?? ['machine']
  const wanted = staged?.installed_scope ?? (staged?.for_project ? 'project' : 'machine')
  return allowed.includes(wanted) ? wanted : allowed.includes('machine') ? 'machine' : allowed[0]
}

// What a plugin adds to OpenRemote, a line per kind, for the review.
export function contributionLines(contributes) {
  const c = contributes ?? {}
  const names = (list, key) => (list ?? []).map((x) => x[key]).join(', ')
  const lines = []
  if (c.harnesses?.length) lines.push(`${c.harnesses.length === 1 ? 'A harness' : 'Harnesses'}: ${names(c.harnesses, 'name')}`)
  if (c.tools?.length) lines.push(`Agent tool${c.tools.length === 1 ? '' : 's'}: ${names(c.tools, 'name')}`)
  if (c.composer_inputs?.length)
    lines.push(`Composer button${c.composer_inputs.length === 1 ? '' : 's'}: ${names(c.composer_inputs, 'label')}`)
  if (c.views?.length) lines.push(`View${c.views.length === 1 ? '' : 's'}: ${names(c.views, 'title')}`)
  if (c.settings?.length) lines.push(`Setting${c.settings.length === 1 ? '' : 's'}: ${names(c.settings, 'label')}`)
  return lines
}

// A plugin that runs programs itself - a program, or a Claude plugin's
// hooks and MCP servers - runs as the user, outside any sandbox. JS and
// WebAssembly plugins are sandboxed whatever they ask for.
export function notSandboxed(plugin) {
  return (
    (plugin.powers ?? []).includes('run_programs') &&
    (plugin.runtime === 'process' || plugin.runtime === 'content')
  )
}

// Where a plugin came from, in a line.
export function sourceLabel(source) {
  if (!source) return ''
  if (source.kind === 'folder') return `Folder: ${source.path}`
  if (source.kind === 'git') return `Git: ${source.url}`
  if (source.kind === 'archive') return `Archive: ${source.location}`
  if (source.kind === 'marketplace') return `${source.marketplace}: ${source.from}`
  return ''
}

// Plugins of one name that are on at once. Their skills and commands
// carry the same name, so a Claude chat may mix them up - the Installed
// tab and the home screen say so. Each clash: the name and its ids.
export function clashes(installed) {
  const byName = new Map()
  for (const p of installed ?? []) {
    if (!p.enabled) continue
    byName.set(p.name, [...(byName.get(p.name) ?? []), p.id])
  }
  return [...byName]
    .filter(([, ids]) => ids.length > 1)
    .map(([name, ids]) => ({ name, ids }))
}

// A catalog is fetched again when Discover opens and its copy is over a
// day old (or was never fetched). Nothing refreshes in the background.
export const STALE_MS = 24 * 60 * 60 * 1000

export function isStale(record, now = Date.now()) {
  return Boolean(record?.enabled) && (!record.refreshed_at || now - record.refreshed_at > STALE_MS)
}

// Discover's filters: every word somewhere in the name, description,
// author, category or tags; one category; one marketplace.
export function filterEntries(entries, { query = '', category = '', marketplace = '' } = {}) {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean)
  return (entries ?? []).filter((e) => {
    if (category && e.category !== category) return false
    if (marketplace && e.marketplace !== marketplace) return false
    if (!words.length) return true
    const hay = [e.name, e.display_name, e.description, e.author, e.category, ...(e.tags ?? [])]
      .filter(Boolean)
      .join(' ')
      .toLowerCase()
    return words.every((w) => hay.includes(w))
  })
}

export function categories(entries) {
  return [...new Set((entries ?? []).map((e) => e.category).filter(Boolean))].sort()
}

// A Discover entry's install, as the daemon takes it. A command entry
// stages only with the exact command the user was shown.
export function entrySource(entry, approveCommand = null) {
  return {
    kind: 'marketplace',
    marketplace: entry.marketplace,
    plugin: entry.name,
    ...(approveCommand ? { approve_command: approveCommand } : {}),
  }
}

// Where an entry stands: can't be installed, not installed, installed,
// or installed with something newer on offer.
export function entryState(entry) {
  if (!entry.installable) return 'unavailable'
  if (!entry.installed) return 'available'
  return entry.update ? 'update' : 'installed'
}

// When its catalog was last fetched, in a few words.
export function fetchedLabel(record, now = Date.now()) {
  if (!record?.refreshed_at) return 'Not fetched yet'
  const minutes = Math.round((now - record.refreshed_at) / 60_000)
  if (minutes < 1) return 'Fetched just now'
  if (minutes < 60) return `Fetched ${minutes} min ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `Fetched ${hours} h ago`
  return `Fetched ${Math.round(hours / 24)} d ago`
}

// The Install dialog's source as the daemon takes it; null until there
// is something to read.
export function sourceRequest(kind, value) {
  const v = (value ?? '').trim()
  if (!v) return null
  if (kind === 'folder') return { kind: 'folder', path: v }
  if (kind === 'git') return { kind: 'git', url: v }
  if (kind === 'archive') return { kind: 'archive', location: v }
  return null
}
