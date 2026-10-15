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
  return ''
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
