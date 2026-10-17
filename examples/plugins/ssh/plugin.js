#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
//
// SSH machines: an OpenRemote process plugin. It adds your VPS hosts - servers
// that run no OpenRemote and no agent of their own - to the Machines tab, and
// gives a chat's agent four tools to work on them: ssh_hosts, ssh_run,
// ssh_read_file and ssh_write_file. The hosts, and the page that manages
// them, are this plugin's; the connections are the system's own ssh.
//
// OpenRemote starts this program the first time something needs it (an agent
// calls a tool, or the Machines tab asks for the hosts) and talks to it over
// stdin and stdout: newline-delimited JSON-RPC 2.0 (docs/plugins/protocol.md).
// Anything for a human goes to stderr or the `log` notification, never stdout.
// When stdin closes OpenRemote is gone, and so is this program - and every ssh
// it started.
//
// What it will not do, by construction (docs/plugins/ssh.md):
//   - sign in with a password: no password is asked for, kept or sent;
//   - trust a host key nobody looked at: keys come from Verify, which shows
//     the fingerprint and records it only when the user says so;
//   - wait for a prompt: every connection is BatchMode, with a timeout, and
//     is killed when its time is up;
//   - write a secret anywhere: a host is an address and a key file's path.
//
// No dependencies: Node.js and the system's ssh.

'use strict'

const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')
const readline = require('node:readline')
const ssh = require('./lib/ssh')
const text = require('./lib/text')
const { Store } = require('./lib/store')

const { UserError } = text

// Reading and writing files are text-sized jobs.
const READ_DEFAULT = 100_000
const READ_MAX = 200_000
const RUN_DEFAULT_S = 60
const RUN_MAX_S = 300
const FILE_TIMEOUT_MS = 60_000
const WRITE_TIMEOUT_MS = 120_000
// A look at a host's key, and a test connection, answer within the 60 s the
// console waits for a page's request.
const UI_TIMEOUT_MS = 25_000
const UI_WAIT_MS = 20_000
// A Verify the user has not answered stops counting after this long.
const GRANT_MS = 5 * 60_000

class RpcError extends Error {
  constructor(code, message) {
    super(message)
    this.code = code
  }
}

// A call that was turned away before anything ran, with the word the audit
// log keeps for it.
class Refusal extends UserError {
  constructor(message, note) {
    super(message)
    this.note = note
  }
}

const send = (message) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`)
const log = (message, level = 'info') => send({ method: 'log', params: { level, message } })

let store = null
let settings = {}

function open(dataDir) {
  if (store) return
  store = new Store(dataDir || process.env.OPENREMOTE_PLUGIN_DATA || path.join(__dirname, '.data'))
  store.open()
  ssh.configure({ knownHosts: store.knownHostsFile, ssh: settings.ssh_path })
}

// ---- what ssh said, as a verdict ----

// How a finished ssh run went, for the agent's answer, the page's Test and
// the host's status alike:
//   no_ssh      there is no ssh to run
//   timeout     the time ran out and ssh was stopped
//   ssh_failed  ssh itself could not get a command run (255 and a complaint)
//   ran         the command ran; its own exit code is in `code`
// A remote command that itself exits 255 with nothing on stderr is "ran".
function verdict(host, result) {
  if (result.spawnError) return { state: 'no_ssh', problem: ssh.missing(result) }
  if (result.timedOut) return { state: 'timeout' }
  const said = text.tailText(result.stderr)
  if (result.code === 255 && said.trim()) return { state: 'ssh_failed', problem: text.explain(said, host.name) }
  return { state: 'ran', code: result.code, signal: result.signal }
}

// What a run says about whether the host can be reached. A command that ran
// proves the way there works; a refusal proves what it says; a timeout and a
// missing ssh prove nothing about the host.
function noteReach(host, v) {
  if (v.state === 'ran') store.noteReach(host, null)
  else if (v.state === 'ssh_failed') store.noteReach(host, v.problem)
}

// ---- the tools ----

const reply = (message, isError = false) => ({ content: [{ type: 'text', text: message }], isError })

function hostFor(name) {
  const wanted = typeof name === 'string' ? name.trim() : ''
  const host = store.find(wanted)
  if (host) return host
  const names = store.hosts.map((h) => h.name)
  throw new Refusal(
    names.length
      ? `There is no SSH host named "${text.brief(wanted, 60)}". The hosts are: ${names.join(', ')}.`
      : 'The user has not set up any SSH hosts yet. They add them in Machines > SSH in OpenRemote.',
    'no such host',
  )
}

// A host an agent may use: its key was verified, and its key file (when it
// has one) is there. Both fail before anything is sent anywhere.
function usable(host) {
  if (!store.isVerified(host)) {
    throw new Refusal(
      `${host.name} has not been verified yet, so nothing was sent. Ask the user to open Machines > SSH in OpenRemote and press Verify on ${host.name} (it shows the host's key fingerprint to check), then try again.`,
      'not verified',
    )
  }
  if (host.identity_file && !fs.existsSync(text.expandHome(host.identity_file))) {
    throw new Refusal(text.explain('no such identity', host.name).message, 'key file missing')
  }
}

// Every call that names a host is logged before it runs and again when it
// ends - with what was asked and how it ended, never what came back.
async function audited(hostName, tool, detail, body) {
  const entry = store.auditBegin({ host: text.brief(typeof hostName === 'string' ? hostName.trim() : '', 80), tool, detail })
  try {
    const outcome = await body()
    store.auditEnd(entry, { exit: outcome.exit ?? null, note: outcome.note ?? null })
    return outcome.reply
  } catch (err) {
    store.auditEnd(entry, { note: err.note ?? (err instanceof UserError ? 'refused' : 'failed') })
    throw err
  }
}

function section(label, part) {
  if (!part.text && !part.cutBytes) return `--- ${label} ---\n(empty)`
  const cut = part.cutBytes
    ? `[${label} was longer than the ${text.withCommas(text.OUTPUT_CAP)}-character limit: the first ${text.withCommas(part.cutBytes)} bytes are left out, the end is shown]\n`
    : ''
  return `--- ${label} ---\n${cut}${part.text}`
}

function renderOutput(result) {
  const shaped = text.shapeOutput(result.stdout, result.stderr)
  return `${section('stdout', shaped.stdout)}\n\n${section('stderr', shaped.stderr)}`
}

async function toolRun(args) {
  const command = text.clean(args.command, 'The command', text.MAX_COMMAND)
  const seconds = text.clampInt(args.timeout_s, 1, RUN_MAX_S, RUN_DEFAULT_S)
  return audited(args.host, 'ssh_run', command, async () => {
    const host = hostFor(args.host)
    usable(host)
    const result = await ssh.run(host, { command, timeoutMs: seconds * 1000 })
    const v = verdict(host, result)
    noteReach(host, v)
    const where = `on ${host.name}`
    if (v.state === 'no_ssh') return { reply: reply(v.problem.message, true), note: 'ssh missing' }
    if (v.state === 'timeout') {
      return {
        reply: reply(
          `The command did not finish within ${seconds} s, so the connection was closed ${where}. It may still be running there. What it printed so far:\n\n${renderOutput(result)}`,
          true,
        ),
        note: 'timed out',
      }
    }
    if (v.state === 'ssh_failed') {
      return {
        reply: reply(`The command was not run ${where}. ${v.problem.message}\n\n${renderOutput(result)}`, true),
        note: `ssh: ${v.problem.kind}`,
      }
    }
    const head =
      v.code === null
        ? `ssh was stopped by ${v.signal ?? 'a signal'} before the command ended ${where}`
        : `exit code ${v.code} ${where} (${text.seconds(result.ms)})`
    return { reply: reply(`${head}\n\n${renderOutput(result)}`, v.code !== 0), exit: v.code }
  })
}

async function toolReadFile(args) {
  const file = text.clean(args.path, 'The path', text.MAX_PATH)
  const max = text.clampInt(args.max_bytes, 1, READ_MAX, READ_DEFAULT)
  return audited(args.host, 'ssh_read_file', file, async () => {
    const host = hostFor(args.host)
    usable(host)
    // One byte more than asked, to know whether the file goes on.
    const result = await ssh.run(host, {
      command: `head -c ${max + 1} -- ${text.remotePath(file)}`,
      timeoutMs: FILE_TIMEOUT_MS,
    })
    const v = verdict(host, result)
    noteReach(host, v)
    if (v.state === 'no_ssh') return { reply: reply(v.problem.message, true), note: 'ssh missing' }
    if (v.state === 'timeout') {
      return { reply: reply(`${file} was not read within ${text.seconds(FILE_TIMEOUT_MS)} on ${host.name}.`, true), note: 'timed out' }
    }
    if (v.state === 'ssh_failed') return { reply: reply(v.problem.message, true), note: `ssh: ${v.problem.kind}` }
    if (v.code !== 0) {
      const why = text.tailText(result.stderr).trim() || `exit code ${v.code}`
      return { reply: reply(`${file} could not be read on ${host.name}: ${why}`, true), exit: v.code }
    }
    const bytes = result.stdout.bytes()
    if (bytes.includes(0)) {
      return {
        reply: reply(
          `${file} on ${host.name} looks like a binary file (it contains NUL bytes), and ssh_read_file reads text. To look inside it, use ssh_run with file, strings or xxd.`,
          true,
        ),
        exit: 0,
        note: 'binary file',
      }
    }
    const cut = bytes.length > max
    let body = bytes.subarray(0, max).toString('utf8')
    // A character cut in half at the limit is not shown as a stray symbol.
    if (cut) body = body.replace(/�$/, '')
    if (!body && !cut) return { reply: reply(`(${file} is empty)`), exit: 0 }
    const note = cut
      ? `\n\n[${file} is longer than ${text.withCommas(max)} bytes: only the first ${text.withCommas(max)} are shown. Ask for more with max_bytes (up to ${text.withCommas(READ_MAX)}), or read a part of it with ssh_run, using sed -n or tail.]`
      : ''
    return { reply: reply(`${body}${note}`), exit: 0 }
  })
}

async function toolWriteFile(args) {
  const file = text.clean(args.path, 'The path', text.MAX_PATH)
  if (typeof args.content !== 'string') throw new UserError('content is needed (it may be empty).')
  const bytes = Buffer.from(args.content, 'utf8')
  if (bytes.length > text.MAX_WRITE_BYTES) {
    throw new UserError(
      `That is ${text.withCommas(bytes.length)} bytes; ssh_write_file takes up to ${text.withCommas(text.MAX_WRITE_BYTES)}. For more, write it in parts with append, or copy it another way.`,
    )
  }
  const append = args.append === true
  const detail = `${append ? 'append to' : 'write'} ${file} (${text.withCommas(bytes.length)} bytes)`
  return audited(args.host, 'ssh_write_file', detail, async () => {
    const host = hostFor(args.host)
    usable(host)
    const result = await ssh.run(host, {
      command: `cat ${append ? '>>' : '>'} ${text.remotePath(file)}`,
      input: bytes,
      timeoutMs: WRITE_TIMEOUT_MS,
    })
    const v = verdict(host, result)
    noteReach(host, v)
    if (v.state === 'no_ssh') return { reply: reply(v.problem.message, true), note: 'ssh missing' }
    if (v.state === 'timeout') {
      return {
        reply: reply(`Writing ${file} on ${host.name} did not finish within ${text.seconds(WRITE_TIMEOUT_MS)}. The file may be incomplete.`, true),
        note: 'timed out',
      }
    }
    if (v.state === 'ssh_failed') return { reply: reply(v.problem.message, true), note: `ssh: ${v.problem.kind}` }
    if (v.code !== 0) {
      const why = text.tailText(result.stderr).trim() || `exit code ${v.code}`
      return { reply: reply(`${file} was not written on ${host.name}: ${why}`, true), exit: v.code }
    }
    return {
      reply: reply(`${append ? 'Appended' : 'Wrote'} ${text.withCommas(bytes.length)} bytes to ${file} on ${host.name}.`),
      exit: 0,
    }
  })
}

function toolHosts() {
  if (!store.hosts.length) {
    return reply('No SSH hosts are set up yet. The user adds them in Machines > SSH in OpenRemote.')
  }
  const hosts = store.hosts.map((h) => ({
    name: h.name,
    address: h.address,
    ...(h.port ? { port: h.port } : {}),
    verified: store.isVerified(h),
    ...(h.note ? { note: h.note } : {}),
  }))
  const unverified = hosts.some((h) => !h.verified)
    ? '\n\nA host that is not verified cannot be used until the user presses Verify on it in Machines > SSH.'
    : ''
  return reply(`${JSON.stringify(hosts, null, 2)}${unverified}`)
}

const tools = {
  ssh_hosts: toolHosts,
  ssh_run: toolRun,
  ssh_read_file: toolReadFile,
  ssh_write_file: toolWriteFile,
}

async function callTool(name, args) {
  const tool = tools[name]
  if (!tool) throw new RpcError(-32602, `no tool named ${name}`)
  try {
    return await tool(args && typeof args === 'object' ? args : {})
  } catch (err) {
    // A refusal is the agent's to read; anything else is this program's bug.
    if (err instanceof UserError) return reply(err.message, true)
    process.stderr.write(`ssh: ${name} failed: ${err.stack || err}\n`)
    return reply(`The SSH plugin hit a problem it did not expect (${err.message}).`, true)
  }
}

// ---- the page's requests ----

let sshInfo = null
let sshInfoAt = 0

// ssh's version, asked for once and again only when it was missing: a user
// who installs it should not have to restart anything.
async function sshFacts() {
  const fresh = sshInfo && (sshInfo.found || Date.now() - sshInfoAt < 10_000)
  if (!fresh) {
    const version = await ssh.version()
    sshInfo = { found: Boolean(version), version }
    sshInfoAt = Date.now()
  }
  return sshInfo
}

function publicHost(h) {
  const verified = store.isVerified(h)
  return {
    name: h.name,
    address: h.address,
    port: h.port ?? null,
    identity_file: h.identity_file ?? null,
    identity_found: h.identity_file ? fs.existsSync(text.expandHome(h.identity_file)) : null,
    note: h.note || '',
    verified,
    fingerprint: verified ? h.key.fingerprint : null,
    key_type: verified ? h.key.type : null,
    verified_at: verified ? h.key.at : null,
    last_ok: h.last_ok ?? null,
    last_error: h.last_error ?? null,
  }
}

const grants = new Map()

function grantFor(token) {
  const now = Date.now()
  for (const [key, grant] of grants) if (grant.expires < now) grants.delete(key)
  return grants.get(String(token)) ?? null
}

function needHost(name) {
  const host = store.find(typeof name === 'string' ? name : '')
  if (!host) throw new UserError(`There is no host named ${text.brief(String(name), 60)}. It may have been removed.`)
  return host
}

const views = {
  async state() {
    return {
      ssh: await sshFacts(),
      hosts: store.hosts.map(publicHost),
      // Newest first, as the page lists them.
      audit: store.data.audit.slice().reverse(),
      notice: store.note ?? null,
      connections: ssh.CONNECTIONS,
      now: Date.now(),
    }
  },

  async host_save({ original = null, host = {} }) {
    if (original) {
      const { host: saved, moved } = store.update(String(original), host)
      return { host: publicHost(saved), moved }
    }
    return { host: publicHost(store.add(host)), moved: false }
  },

  async host_remove({ name }) {
    const host = needHost(name)
    store.remove(host.name)
    return { removed: host.name }
  },

  // Verify, first half: connect once and show the key. Nothing is trusted
  // here; what was seen is held for the confirm below.
  async verify_start({ name }) {
    const host = needHost(name)
    const found = await ssh.scanKey(host, store, { timeoutMs: UI_TIMEOUT_MS, maxWaitMs: UI_WAIT_MS })
    if (found.problem) {
      if (found.problem.kind !== 'no_ssh') store.noteReach(host, found.problem)
      throw new UserError(found.problem.message)
    }
    const token = crypto.randomBytes(12).toString('hex')
    grants.set(token, {
      id: host.id,
      address: host.address,
      port: host.port,
      lines: found.lines,
      fingerprint: found.fingerprint,
      type: found.type,
      expires: Date.now() + GRANT_MS,
    })
    const recorded = store.isVerified(host)
    const same = recorded && host.key.fingerprint === found.fingerprint
    return {
      token,
      name: host.name,
      type: found.type,
      fingerprint: found.fingerprint,
      // Already verified with this very key: nothing to decide.
      same,
      // Verified before with another: the page says so loudly.
      previous: recorded && !same ? { type: host.key.type, fingerprint: host.key.fingerprint } : null,
    }
  },

  // Verify, second half: the user compared the fingerprint and trusts it.
  async verify_confirm({ name, token }) {
    const grant = grantFor(token)
    if (!grant) throw new UserError('That check ran out. Press Verify again.')
    const host = needHost(name)
    if (host.id !== grant.id || host.address !== grant.address || host.port !== grant.port) {
      throw new UserError(`${host.name} was changed while you were checking it. Press Verify again.`)
    }
    grants.delete(String(token))
    store.recordKey(host, grant.lines, grant.fingerprint, grant.type)
    return { host: publicHost(host) }
  },

  async host_test({ name }) {
    const host = needHost(name)
    if (!store.isVerified(host)) throw new UserError(`${host.name} is not verified yet. Press Verify first.`)
    if (host.identity_file && !fs.existsSync(text.expandHome(host.identity_file))) {
      throw new UserError(text.explain('no such identity', host.name).message)
    }
    const result = await ssh.run(host, { command: 'true', timeoutMs: UI_TIMEOUT_MS, maxWaitMs: UI_WAIT_MS })
    const v = verdict(host, result)
    noteReach(host, v)
    if (v.state === 'no_ssh') return { ok: false, kind: 'no_ssh', message: v.problem.message }
    if (v.state === 'timeout') return { ok: false, kind: 'timeout', message: `${host.name} did not answer within ${text.seconds(UI_TIMEOUT_MS)}.` }
    if (v.state === 'ssh_failed') return { ok: false, kind: v.problem.kind, message: v.problem.message }
    return { ok: v.code === 0, kind: v.code === 0 ? 'ok' : 'other', ms: result.ms, message: v.code === 0 ? null : `The test command ended with code ${v.code}.` }
  },
}

async function uiRequest({ name, params }) {
  const view = views[name]
  if (!view) throw new RpcError(-32601, `no request named ${name}`)
  try {
    return await view(params && typeof params === 'object' ? params : {})
  } catch (err) {
    if (err instanceof UserError) throw new RpcError(-32000, err.message)
    process.stderr.write(`ssh: ${name} failed: ${err.stack || err}\n`)
    throw new RpcError(-32000, `The SSH plugin hit a problem it did not expect (${err.message}).`)
  }
}

// ---- the protocol ----

function applySettings(next) {
  settings = next || {}
  ssh.configure({ ssh: settings.ssh_path })
  // A different ssh may be a different version.
  sshInfo = null
}

const methods = {
  initialize(params) {
    applySettings(params.settings)
    open(params.plugin?.data)
    if (store.note) log(store.note, 'warn')
    log(`started for OpenRemote ${params.openremote} on ${params.platform}`)
    return { protocol: 1 }
  },

  'tools/call'({ name, arguments: args }) {
    open()
    return callTool(name, args)
  },

  'ui/request'(params) {
    open()
    return uiRequest(params)
  },
}

const notifications = {
  'settings/changed'(params) {
    applySettings(params.settings)
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

// OpenRemote is gone (or is going): nothing may be left running on its
// account, ssh connections least of all.
let leaving = false
function leave() {
  if (leaving) return
  leaving = true
  ssh.stopAll()
  process.exit(0)
}

readline.createInterface({ input: process.stdin }).on('line', (line) => {
  if (!line.trim()) return
  let message
  try {
    message = JSON.parse(line)
  } catch {
    process.stderr.write('ssh: a line that is not JSON was ignored\n')
    return
  }
  handle(message)
})
process.stdin.on('end', leave)
process.stdin.on('close', leave)
process.stdin.on('error', leave)
process.stdout.on('error', leave)
process.on('SIGTERM', leave)
process.on('SIGINT', leave)
process.on('exit', () => ssh.stopAll())
// One call's bug is not a reason to drop every other call and every
// connection with it.
process.on('uncaughtException', (err) => process.stderr.write(`ssh: ${err.stack || err}\n`))
process.on('unhandledRejection', (err) => process.stderr.write(`ssh: ${err?.stack || err}\n`))
