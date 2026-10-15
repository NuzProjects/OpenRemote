// The composer's / and @ menus: when one opens, what it offers for what
// was typed, what a pick puts in the text, and - when the message is sent
// - the OpenRemote commands taken out of it to run in the app. A pick is
// plain text: what you see is what is sent. Pure: tested without a DOM.

// OpenRemote's own commands. They run in the app when the message is
// sent and never reach the harness; on a name the harness also has
// (claude's /model, /effort, /fast, /rename) OpenRemote's takes over, so
// the app's own model, effort and name stay true. `arg` names what
// follows the command; `chat` ones need a running chat; `cloud` ones need
// Cloud.
export const OPENREMOTE_COMMANDS = [
  { name: 'model', arg: 'model', description: 'Switch the model for this chat' },
  { name: 'effort', arg: 'effort', description: 'Set how hard the model thinks' },
  { name: 'fast', arg: 'fast', description: 'Turn fast mode on or off' },
  { name: 'permissions', arg: 'permission', description: 'Set the permission mode' },
  { name: 'stop', description: 'Stop the chat', chat: true },
  { name: 'resume', description: 'Resume a stopped chat', chat: true },
  { name: 'rename', arg: 'title', description: 'Rename the chat: /rename "New name"' },
  { name: 'sync', description: 'Put the chat on Cloud - your other devices see it, it keeps running here', cloud: true },
  { name: 'cloud', description: 'Put the chat on Cloud (the same as /sync)', cloud: true },
]

const OWN = new Map(OPENREMOTE_COMMANDS.map((c) => [c.name, c]))

// The words of a text with where each starts and ends; a "quoted string"
// is one word.
export function words(text) {
  const out = []
  const re = /"[^"]*"|\S+/g
  let match
  while ((match = re.exec(text))) out.push({ word: match[0], start: match.index, end: match.index + match[0].length })
  return out
}

// The menu the caret is in, if any: a / or @ word at the caret that
// starts the message or follows whitespace (both open anywhere), or the
// argument of an OpenRemote command just picked (`/model ` then a model).
export function menuAt(text, caret) {
  let start = caret
  while (start > 0 && !/\s/.test(text[start - 1])) start -= 1
  const word = text.slice(start, caret)
  if (word.startsWith('/') && !word.slice(1).includes('/')) {
    return { kind: '/', query: word.slice(1), start, end: caret }
  }
  if (word.startsWith('@')) {
    return { kind: '@', query: word.slice(1).replace(/^"/, ''), start, end: caret }
  }
  // The word before: an OpenRemote command that takes a pickable argument.
  const before = text.slice(0, start).trimEnd()
  const previous = before.slice(before.search(/\S+$/))
  const command = previous.startsWith('/') ? OWN.get(previous.slice(1)) : null
  if (command?.arg && command.arg !== 'title' && before.length < start) {
    return { kind: 'arg', command: command.name, arg: command.arg, query: word, start, end: caret }
  }
  return null
}

// Put a pick in place of the menu's word. A trailing space follows,
// unless the insertion wants the caret right after it (an MCP server's
// `@server:` waits for its resource).
export function applyPick(text, menu, insertion, { space = true } = {}) {
  const after = text.slice(menu.end)
  const glue = space && !after.startsWith(' ') ? ' ' : ''
  const next = text.slice(0, menu.start) + insertion + glue + after
  return { text: next, caret: menu.start + insertion.length + glue.length }
}

// What a pick inserts.
export function fileInsertion(path) {
  return /\s/.test(path) ? `@"${path}"` : `@${path}`
}

// Claude's own agent mention (`@agent-<name>`, a plugin's scoped
// `@agent-plugin:name`); other harnesses get the name as written.
export function agentInsertion(name, harness) {
  return harness === 'claude' ? `@agent-${name}` : `@${name}`
}

// A chat pointer: its name and the start of its id, which the agent hands
// to the read-a-chat tool. Quotes in the name are dropped so the pointer
// stays one readable phrase.
export function chatInsertion(chat) {
  const title = (chat.title ?? 'untitled').replace(/"/g, '').slice(0, 60)
  return `@chat "${title}" (${String(chat.id).slice(0, 8)})`
}

const CHAT_POINTER = /@chat "[^"]*" \(([0-9a-fA-F-]{6,})\)/g

// The console keeps its chats keyed by id; a plain list reads the same.
export function chatList(chats) {
  if (!chats) return []
  return Array.isArray(chats) ? chats : Object.values(chats)
}

// The chats a message points at: each pointer's id start, matched to a
// chat this console knows.
export function mentionedChats(text, chats) {
  const ids = new Set()
  for (const match of text.matchAll(CHAT_POINTER)) {
    const found = chatList(chats).find((c) => String(c.id).startsWith(match[1]))
    if (found) ids.add(found.id)
  }
  return [...ids]
}

// Which OpenRemote commands this composer offers: no chat-only ones before
// a chat exists, no Cloud ones without Cloud.
export function ownCommands({ inChat = true, cloud = false } = {}) {
  return OPENREMOTE_COMMANDS.filter((c) => (inChat || !c.chat) && (cloud || !c.cloud))
}

function rankBy(query, name, description = '') {
  const q = query.toLowerCase()
  const n = name.toLowerCase()
  if (!q) return 1
  if (n.startsWith(q)) return 3
  if (n.includes(q)) return 2
  if (description.toLowerCase().includes(q)) return 1
  return 0
}

// The / menu: the harness's commands and the plugins' (minus the names
// OpenRemote takes over), then OpenRemote's own, best matches first.
export function commandItems(query, { harnessCommands = [], own = [] } = {}) {
  const taken = new Set(own.map((c) => c.name))
  const items = []
  for (const c of harnessCommands) {
    if (taken.has(c.name)) continue
    const names = [c.name, ...(c.aliases ?? [])]
    const score = Math.max(...names.map((n) => rankBy(query, n, c.description ?? '')))
    if (!score) continue
    items.push({
      key: `cmd:${c.name}`,
      kind: 'command',
      label: `/${c.name}`,
      detail: c.description ?? '',
      hint: c.argument_hint || '',
      badge: c.source === 'plugin' ? 'plugin' : null,
      disabled: c.available === false,
      why: c.why ?? null,
      insertion: `/${c.name}`,
      score,
    })
  }
  for (const c of own) {
    const score = rankBy(query, c.name, c.description)
    if (!score) continue
    items.push({
      key: `own:${c.name}`,
      kind: 'openremote',
      label: `/${c.name}`,
      detail: c.description,
      hint: '',
      badge: 'OpenRemote',
      disabled: false,
      why: null,
      insertion: `/${c.name}`,
      score,
    })
  }
  return items.sort((a, b) => b.score - a.score || a.label.localeCompare(b.label)).slice(0, 50)
}

// The @ menu: files and folders, agents, MCP servers, other chats -
// each group filtered by the query.
export function mentionItems(query, { files = [], agents = [], servers = [], chats = [], harness = '' } = {}) {
  const items = []
  for (const f of files) {
    items.push({
      key: `file:${f.path}`,
      kind: 'file',
      group: 'Files',
      label: f.kind === 'dir' ? `${f.path}/` : f.path,
      detail: '',
      insertion: fileInsertion(f.path),
      disabled: false,
    })
  }
  for (const a of agents) {
    if (!rankBy(query, a.name, a.description ?? '')) continue
    items.push({
      key: `agent:${a.name}`,
      kind: 'agent',
      group: 'Agents',
      label: a.name,
      detail: a.description ?? '',
      badge: a.source === 'plugin' ? 'plugin' : null,
      insertion: agentInsertion(a.name, harness),
      disabled: a.available === false,
      why: a.why ?? null,
    })
  }
  for (const s of servers) {
    if (!rankBy(query, s.name)) continue
    items.push({
      key: `mcp:${s.name}`,
      kind: 'mcp',
      group: 'MCP servers',
      label: `${s.name}:`,
      detail: s.source === 'plugin' ? `from ${s.plugin}` : 'set up in Settings',
      insertion: `@${s.name}:`,
      space: false,
      disabled: false,
    })
  }
  for (const c of chats) {
    if (!rankBy(query, c.title ?? '')) continue
    items.push({
      key: `chat:${c.id}`,
      kind: 'chat',
      group: 'Chats',
      label: c.title ?? 'untitled',
      detail: c.harness ?? '',
      insertion: chatInsertion(c),
      disabled: false,
    })
  }
  return items.slice(0, 80)
}

// The argument menu after an OpenRemote command: the choices it takes.
export function argItems(query, choices = []) {
  return choices
    .filter((c) => rankBy(query, c.id, c.name ?? ''))
    .map((c) => ({
      key: `arg:${c.id}`,
      kind: 'arg',
      label: c.name ?? c.id,
      detail: c.detail ?? '',
      insertion: c.id,
      disabled: false,
    }))
}

// At send: the OpenRemote commands in the message, in order, each with its
// argument, and the message without them. Anything else - the harness's
// own commands included - stays as typed.
export function takeCommands(text, own = OPENREMOTE_COMMANDS) {
  const names = new Map(own.map((c) => [c.name, c]))
  const list = words(text)
  const run = []
  const cut = []
  for (let i = 0; i < list.length; i += 1) {
    const { word, start, end } = list[i]
    if (!word.startsWith('/')) continue
    const command = names.get(word.slice(1))
    if (!command) continue
    let stop = end
    let arg = null
    // /fast's on/off is optional: the next word is its argument only when
    // it is one of the two.
    const takesNext =
      command.arg && list[i + 1] && (command.arg !== 'fast' || /^(on|off)$/i.test(list[i + 1].word))
    if (takesNext) {
      arg = list[i + 1].word.replace(/^"|"$/g, '')
      stop = list[i + 1].end
      i += 1
    }
    run.push({ name: command.name, arg })
    cut.push([start, stop])
  }
  let rest = text
  for (const [start, stop] of cut.reverse()) rest = rest.slice(0, start) + rest.slice(stop)
  return { run, text: rest.replace(/[ \t]{2,}/g, ' ').trim() }
}
