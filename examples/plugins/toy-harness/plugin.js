#!/usr/bin/env node
// toy-harness: an example OpenRemote process plugin. It drives toy-cli.js
// as a harness (pickers list "Toy CLI" beside the built-in six) and gives
// chats' agents one tool, word_count.
//
// OpenRemote starts this program the first time something needs it and
// talks to it over stdin and stdout: newline-delimited JSON-RPC 2.0, one
// message per line (docs/plugins/protocol.md). Anything for a human goes
// to stderr or the `log` notification, never stdout. When stdin closes,
// OpenRemote is gone: the program exits.
//
// No dependencies: Node.js alone.

const { spawn } = require('node:child_process')
const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')
const readline = require('node:readline')

const CLI = path.join(__dirname, 'toy-cli.js')

let settings = {}
let dataDir = process.env.OPENREMOTE_PLUGIN_DATA || path.join(__dirname, '.data')
// The chats this plugin drives, by the session handle OpenRemote chose.
const sessions = new Map()

class RpcError extends Error {
  constructor(code, message) {
    super(message)
    this.code = code
  }
}

const send = (message) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n')
const notify = (method, params) => send({ method, params })
const log = (message, level = 'info') => notify('log', { level, message })
const emit = (session, event) => notify('harness/event', { session, event })

function session(handle) {
  const state = sessions.get(handle)
  if (!state) throw new RpcError(-32602, `no session ${handle}`)
  return state
}

// Conversations are kept in the plugin's own data folder, so a chat that
// is stopped and resumed (even after OpenRemote restarts) picks up its
// history - the way a real CLI's own session files work.
const conversationFile = (id) => path.join(dataDir, 'conversations', `${id}.json`)

function saveConversation(state) {
  fs.mkdirSync(path.dirname(conversationFile(state.ref)), { recursive: true })
  fs.writeFileSync(conversationFile(state.ref), JSON.stringify({ turns: state.turns }, null, 2))
}

function countWords(text) {
  return text.trim() ? text.trim().split(/\s+/).length : 0
}

// One run of the toy CLI for one prompt, its output turned into harness
// events as it arrives.
function run(handle, text, loud) {
  const state = session(handle)
  const args = [CLI, '--model', state.model, '--greeting', settings.greeting || 'Hello']
  if (loud) args.push('--loud')
  args.push('--', text)
  const child = spawn(process.execPath, args, { cwd: state.cwd, stdio: ['ignore', 'pipe', 'pipe'] })
  state.child = child
  state.interrupted = false
  emit(handle, { type: 'reasoning', text: settings.token ? 'A token is set.' : 'No token is set.' })
  const lines = readline.createInterface({ input: child.stdout })
  lines.on('line', (line) => {
    let step
    try {
      step = JSON.parse(line)
    } catch {
      return
    }
    if (step.kind === 'thinking') emit(handle, { type: 'reasoning', text: step.text })
    if (step.kind === 'tool') {
      const id = crypto.randomUUID()
      emit(handle, { type: 'tool_started', id, name: step.name, input: step.input })
      emit(handle, { type: 'tool_result', id, name: step.name, text: step.output })
    }
    if (step.kind === 'reply') {
      emit(handle, { type: 'text', text: step.text })
      state.turns.push({ prompt: text, reply: step.text })
      saveConversation(state)
    }
  })
  child.stderr.on('data', (chunk) => emit(handle, { type: 'stderr', line: String(chunk).trim() }))
  child.on('close', (code) => {
    state.child = null
    const used = state.turns.reduce((n, t) => n + t.prompt.length + t.reply.length, 0)
    emit(handle, { type: 'context', used: Math.ceil(used / 4) })
    if (state.interrupted) emit(handle, { type: 'turn_completed', outcome: 'interrupted' })
    else if (code === 0) emit(handle, { type: 'turn_completed', outcome: 'completed' })
    else emit(handle, { type: 'turn_completed', outcome: 'failed', error: `the toy exited with ${code}` })
  })
}

const methods = {
  initialize(params) {
    settings = params.settings || {}
    if (params.plugin?.data) dataDir = params.plugin.data
    log(`started for OpenRemote ${params.openremote} on ${params.platform}`)
    return { protocol: 1, contributes: { harnesses: ['toy'], tools: ['word_count'] } }
  },

  'tools/call'({ name, arguments: args }) {
    if (name !== 'word_count') throw new RpcError(-32602, `no tool named ${name}`)
    const text = String(args?.text ?? '')
    const lines = text ? text.split(/\r?\n/).length : 0
    return {
      content: [
        { type: 'text', text: `${countWords(text)} words, ${lines} lines, ${[...text].length} characters` },
      ],
    }
  },

  'harness/spawn'(params) {
    let ref = params.resume
    let turns = []
    if (ref) {
      try {
        turns = JSON.parse(fs.readFileSync(conversationFile(ref), 'utf8')).turns
      } catch {
        throw new RpcError(-32000, `the toy has no conversation ${ref} to resume`)
      }
    } else {
      ref = crypto.randomUUID()
    }
    sessions.set(params.session, {
      ref,
      turns,
      cwd: params.cwd,
      model: params.model || 'toy-echo',
      permission: params.permission_mode || 'ask',
      child: null,
      pending: null,
    })
    return { session_ref: ref, model: params.model || 'toy-echo', permission_mode: params.permission_mode || 'ask' }
  },

  'harness/prompt'({ session: handle, text }) {
    const state = session(handle)
    // Shouting needs the user's yes, unless the chat allows it: the ask
    // becomes a decision card in the chat, answered with harness/answer.
    if (/shout/i.test(text) && state.permission !== 'allow') {
      const ref = crypto.randomUUID()
      state.pending = { ref, text }
      emit(handle, {
        type: 'approval',
        ref,
        tool_name: 'Shout',
        summary: 'Shout the reply?',
        options: [
          { id: 'allow', label: 'Shout it' },
          { id: 'deny', label: 'Keep it quiet' },
        ],
        request: { prompt: text },
      })
      return {}
    }
    run(handle, text, false)
    return {}
  },

  'harness/answer'({ session: handle, ref, choice }) {
    const state = session(handle)
    if (!state.pending || state.pending.ref !== ref) throw new RpcError(-32602, 'that question is no longer open')
    const { text } = state.pending
    state.pending = null
    run(handle, text, choice === 'allow')
    return { interrupts_turn: false }
  },

  'harness/settings'({ session: handle, model, fast }) {
    const state = session(handle)
    if (fast) throw new RpcError(-32000, 'the toy has no fast mode')
    if (model) state.model = model
    return {}
  },

  'harness/interrupt'({ session: handle }) {
    const state = session(handle)
    if (state.child) {
      state.interrupted = true
      state.child.kill()
    } else if (state.pending) {
      state.pending = null
      emit(handle, { type: 'turn_completed', outcome: 'interrupted' })
    }
    return {}
  },

  'harness/stop'({ session: handle }) {
    const state = sessions.get(handle)
    if (state?.child) state.child.kill()
    sessions.delete(handle)
    return { exit_code: 0 }
  },
}

const notifications = {
  // New values from Settings > Plugins: the next run uses them.
  'settings/changed'(params) {
    settings = params.settings || {}
  },
}

async function handle(message) {
  if (message.id === undefined) {
    notifications[message.method]?.(message.params || {})
    return
  }
  const method = methods[message.method]
  if (!method) {
    send({ id: message.id, error: { code: -32601, message: `no method ${message.method}` } })
    return
  }
  try {
    send({ id: message.id, result: await method(message.params || {}) })
  } catch (err) {
    send({ id: message.id, error: { code: err.code ?? -32000, message: err.message } })
  }
}

readline.createInterface({ input: process.stdin }).on('line', (line) => {
  if (!line.trim()) return
  let message
  try {
    message = JSON.parse(line)
  } catch {
    process.stderr.write('toy-harness: a line that is not JSON was ignored\n')
    return
  }
  handle(message)
})
// stdin closing means OpenRemote is gone.
process.stdin.on('end', () => process.exit(0))
