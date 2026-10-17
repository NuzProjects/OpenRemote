// SPDX-License-Identifier: AGPL-3.0-only
//
// Running the system's ssh. Every connection the plugin makes goes through
// run(): its options, its timeout, its share of the four connection slots.
//
// ssh is the user's own client, so their ~/.ssh/config (aliases, jump hosts)
// and their ssh agent work as they do in a terminal. What this module adds on
// top is what makes it safe to hand to an agent: it never prompts, never
// forwards anything, never signs in with a password, and only trusts host keys
// from the plugin's own known_hosts file - which the user fills by pressing
// Verify, never ssh by itself.

'use strict'

const { spawn } = require('node:child_process')
const fs = require('node:fs')
const text = require('./text')

// At most this many ssh connections live at once; more calls wait.
const CONNECTIONS = 4

// How long a call may wait for a free connection before it gives up and says
// so. It is separate from the call's own timeout, which only starts when its
// connection does: a command asked to run for 60 s should get 60 s.
const QUEUE_WAIT_MS = 120_000

// What a killed ssh is given to go quietly before it is made to.
const GRACE_MS = 2000
// After a child exits, how long to wait for its pipes to close. A helper it
// started (a ProxyCommand) can hold them open, and a call must not hang on it.
const PIPE_WAIT_MS = 1500

class BusyError extends text.UserError {}

// A counting gate with a queue: acquire() answers a release function.
class Gate {
  constructor(limit) {
    this.limit = limit
    this.active = 0
    this.waiting = []
  }

  acquire(maxWaitMs) {
    if (this.active < this.limit) {
      this.active += 1
      return Promise.resolve(this.releaser())
    }
    return new Promise((resolve, reject) => {
      const waiter = { resolve }
      waiter.timer = setTimeout(() => {
        this.waiting.splice(this.waiting.indexOf(waiter), 1)
        reject(
          new BusyError(
            `All ${this.limit} ssh connections stayed busy for ${text.seconds(maxWaitMs)}, so this call did not start. Try again in a moment.`,
          ),
        )
      }, maxWaitMs)
      this.waiting.push(waiter)
    })
  }

  releaser() {
    let released = false
    return () => {
      if (released) return
      released = true
      this.active -= 1
      while (this.active < this.limit && this.waiting.length) {
        const next = this.waiting.shift()
        clearTimeout(next.timer)
        this.active += 1
        next.resolve(this.releaser())
      }
    }
  }
}

const gate = new Gate(CONNECTIONS)
const live = new Set()

let program = 'ssh'
let knownHostsFile = null

function configure({ ssh, knownHosts }) {
  if (ssh !== undefined) program = ssh && String(ssh).trim() ? text.expandHome(String(ssh).trim()) : 'ssh'
  if (knownHosts) knownHostsFile = knownHosts
}

// ssh reads an option's value the way it reads a line of its config: quotes
// group words and % starts a token. A path becomes one safe value, with
// forward slashes (Windows' ssh takes them, and a backslash would be an
// escape).
function optionValue(file) {
  const value = String(file).replace(/\\/g, '/').replace(/%/g, '%%')
  if (value.includes('"')) throw new text.UserError("The plugin's data folder has a double quote in its path, which ssh cannot take in an option.")
  return /\s/.test(value) ? `"${value}"` : value
}

// The arguments for one connection to `host`, up to and including its
// address; the caller adds the remote command.
//
// "run" is every real call: the host's key must already be in known_hosts and
// match. "scan" is Verify's one look: an empty scratch file, a new key
// accepted into it (never into the real file), and no login attempted, so
// nothing is offered to a host whose key nobody has checked yet.
function buildArgs(host, { mode, hostsFile }) {
  const scan = mode === 'scan'
  const known = optionValue(hostsFile)
  const args = [
    // No terminal: nothing here is interactive, and a terminal would mix the
    // two output streams and rewrite line endings.
    '-T',
    // No prompts, ever. A passphrase, a password or a yes/no question is a
    // failure with a reason, not a wait.
    '-o', 'BatchMode=yes',
    '-o', 'ConnectTimeout=10',
    '-o', 'ServerAliveInterval=15',
    '-o', 'ServerAliveCountMax=3',
    '-o', `StrictHostKeyChecking=${scan ? 'accept-new' : 'yes'}`,
    '-o', `UserKnownHostsFile=${known}`,
    '-o', `GlobalKnownHostsFile=${known}`,
    // The key is filed under the host's own id, whatever its address or the
    // user's ssh config call it.
    '-o', `HostKeyAlias=${host.id}`,
    '-o', 'CheckHostIP=no',
    '-o', 'UpdateHostKeys=no',
    '-o', 'HashKnownHosts=no',
    '-o', `PreferredAuthentications=${scan ? 'none' : 'publickey'}`,
    '-o', 'PasswordAuthentication=no',
    // What a user's config may set for convenience in a terminal and must
    // not do for an agent: hand over the agent socket, open ports, share a
    // control connection, run a local command.
    '-o', 'ForwardAgent=no',
    '-o', 'ForwardX11=no',
    '-o', 'ClearAllForwardings=yes',
    '-o', 'ControlMaster=no',
    '-o', 'ControlPath=none',
    '-o', 'RemoteCommand=none',
    '-o', 'PermitLocalCommand=no',
    '-o', 'LogLevel=ERROR',
  ]
  if (host.port) args.push('-p', String(host.port))
  if (host.identity_file && !scan) args.push('-i', text.expandHome(host.identity_file), '-o', 'IdentitiesOnly=yes')
  // After --, the address is an address even if it were to start with a dash.
  args.push('--', host.address)
  return args
}

// One ssh run: answers when it ends, however it ends. Never throws for a
// failed connection; a missing free slot is the one thing it rejects with.
//   command   what the host's shell runs
//   input     a Buffer for the command's stdin, or null (then ssh gets none)
//   timeoutMs how long it may run once connected to a slot
async function run(host, { command, input = null, timeoutMs, mode = 'run', hostsFile = knownHostsFile, maxWaitMs = QUEUE_WAIT_MS }) {
  const queued = Date.now()
  const release = await gate.acquire(maxWaitMs)
  const started = Date.now()
  try {
    const args = buildArgs(host, { mode, hostsFile })
    // No stdin for ssh to read when there is none to send (-n).
    if (input === null) args.unshift('-n')
    args.push(command)
    return await spawnSsh(args, { input, timeoutMs, queuedMs: started - queued })
  } finally {
    release()
  }
}

function spawnSsh(args, { input, timeoutMs, queuedMs }) {
  return new Promise((resolve) => {
    const out = new text.Tail()
    const err = new text.Tail()
    const began = Date.now()
    let child = null
    let timedOut = false
    let settled = false
    let spawnError = null
    const timers = new Set()
    const later = (fn, ms) => {
      const timer = setTimeout(fn, ms)
      timers.add(timer)
      return timer
    }

    const finish = (code, signal) => {
      if (settled) return
      settled = true
      for (const timer of timers) clearTimeout(timer)
      if (child) {
        live.delete(child)
        child.stdout?.destroy()
        child.stderr?.destroy()
      }
      resolve({ code, signal, timedOut, spawnError, stdout: out, stderr: err, ms: Date.now() - began, queuedMs })
    }

    const stop = () => {
      try {
        child.kill('SIGTERM')
      } catch {
        /* already gone */
      }
      // Windows ends the process at once; elsewhere ssh is given a moment.
      later(() => {
        try {
          child.kill('SIGKILL')
        } catch {
          /* already gone */
        }
        later(() => finish(null, 'SIGKILL'), GRACE_MS)
      }, GRACE_MS)
    }

    try {
      child = spawn(program, args, { stdio: [input === null ? 'ignore' : 'pipe', 'pipe', 'pipe'], windowsHide: true })
    } catch (e) {
      spawnError = e.code === 'ENOENT' ? 'missing' : e.message
      finish(null, null)
      return
    }
    live.add(child)
    child.on('error', (e) => {
      spawnError = e.code === 'ENOENT' ? 'missing' : e.message
      finish(null, null)
    })
    child.stdout.on('data', (chunk) => out.push(chunk))
    child.stderr.on('data', (chunk) => err.push(chunk))
    if (input !== null) {
      // A host that hangs up early closes this pipe under the write; that is
      // the host's answer, not a failure of ours.
      child.stdin.on('error', () => {})
      child.stdin.end(input)
    }
    child.on('exit', (code, signal) => later(() => finish(code, signal), PIPE_WAIT_MS))
    child.on('close', (code, signal) => finish(code, signal))
    later(() => {
      timedOut = true
      stop()
    }, timeoutMs)
  })
}

// The system's ssh, as it introduces itself, or null when there is none.
function version() {
  return new Promise((resolve) => {
    let said = ''
    let child
    try {
      child = spawn(program, ['-V'], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    } catch {
      resolve(null)
      return
    }
    const timer = setTimeout(() => {
      child.kill()
      resolve(null)
    }, 5000)
    child.on('error', () => {
      clearTimeout(timer)
      resolve(null)
    })
    // ssh -V answers on stderr.
    child.stdout.on('data', (c) => (said += c))
    child.stderr.on('data', (c) => (said += c))
    child.on('close', () => {
      clearTimeout(timer)
      resolve(said.trim().split(/\r?\n/)[0] || null)
    })
  })
}

// Verify's look at a host: its key as ssh meets it, never trusted yet.
// Answers { lines, type, fingerprint } or { problem: { kind, message } }.
async function scanKey(host, store, { timeoutMs = 25_000, maxWaitMs = 20_000 } = {}) {
  const file = store.scanFile()
  try {
    const result = await run(host, { command: 'true', timeoutMs, mode: 'scan', hostsFile: file, maxWaitMs })
    if (result.spawnError) return { problem: missing(result) }
    const keys = text.parseKnownHosts(fs.readFileSync(file, 'utf8'))
    if (keys.length) {
      // ssh files one key (and, with a check of the address, a second line
      // of the same key): the first is the one to show.
      const first = keys[0]
      const same = keys.filter((k) => k.blob === first.blob)
      return {
        lines: same.map((k) => k.line),
        type: text.KEY_LABEL[first.type] ?? first.type,
        fingerprint: text.fingerprintOf(first.blob),
      }
    }
    if (result.timedOut) {
      return { problem: { kind: 'timeout', message: `${host.name} did not answer in time, so no host key could be read.` } }
    }
    return { problem: text.explain(text.tailText(result.stderr), host.name) }
  } finally {
    fs.rmSync(file, { force: true })
  }
}

// ssh could not be started at all.
function missing(result) {
  if (result.spawnError === 'missing') {
    return {
      kind: 'no_ssh',
      message:
        'ssh was not found on this computer. Install the OpenSSH client (it comes with macOS and most Linux systems; on Windows, add the "OpenSSH Client" optional feature), or set where it is in Settings > Plugins > SSH machines.',
    }
  }
  return { kind: 'no_ssh', message: `ssh could not be started: ${result.spawnError}` }
}

// Stop everything this module started: the program is going away.
function stopAll() {
  for (const child of live) {
    try {
      child.kill()
    } catch {
      /* already gone */
    }
  }
}

module.exports = { BusyError, CONNECTIONS, Gate, QUEUE_WAIT_MS, buildArgs, configure, missing, run, scanKey, stopAll, version }
