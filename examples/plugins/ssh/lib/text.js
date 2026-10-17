// SPDX-License-Identifier: AGPL-3.0-only
//
// Pure helpers for the SSH plugin: no files, no processes. Everything an
// agent or the page types reaches a command line or a remote shell through
// here, so the rules for it (what a host may be called, how a path is quoted,
// how much output comes back) live in one place that can be read and checked
// on its own.

'use strict'

const crypto = require('node:crypto')
const os = require('node:os')
const path = require('node:path')

// What the docs promise.
const OUTPUT_CAP = 200_000
// A command rides on ssh's command line. Windows stops a whole command line
// at 32,767 characters (and doubles every quote and backslash on the way), so
// this stays well under it on every system. A longer script is written with
// ssh_write_file and run.
const MAX_COMMAND = 12_000
const MAX_PATH = 4_096
const MAX_WRITE_BYTES = 2_000_000
const MAX_NOTE = 200
const MAX_NAME = 40

// A message for the person (or the agent talking to one): plain words, safe to
// show as they are. Anything else that is thrown is a bug, and is not shown.
class UserError extends Error {}

// ---- what a host is made of ----

const NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
// user@host, a name or address, an IPv6 literal, or a name from the user's
// ssh config. No spaces, slashes or leading dash: it is handed to ssh as one
// argument after `--` and never reaches a shell, and this keeps what it can
// say small enough to read.
const ADDRESS = /^(?:[A-Za-z0-9._+-]+@)?[A-Za-z0-9._:%[\]-]+$/

function checkName(value) {
  const name = typeof value === 'string' ? value.trim() : ''
  if (!name) throw new UserError('A host needs a name, like web-1: it is what agents call it by.')
  if (name.length > MAX_NAME || !NAME.test(name)) {
    throw new UserError(
      `A host's name uses lowercase letters, digits and single dashes (like web-1), up to ${MAX_NAME} characters.`,
    )
  }
  return name
}

function checkAddress(value) {
  const address = typeof value === 'string' ? value.trim() : ''
  if (!address) throw new UserError('A host needs an address: user@host, or a name from your ssh config.')
  if (address.length > 255 || address.startsWith('-') || !ADDRESS.test(address)) {
    throw new UserError(
      'That does not look like an ssh address. Use user@host, a host name or IP address, or a name from your ssh config: no spaces, slashes or options.',
    )
  }
  return address
}

function checkPort(value) {
  if (value === null || value === undefined || value === '') return null
  const port = typeof value === 'number' ? value : Number(String(value).trim())
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new UserError('A port is a whole number from 1 to 65535, or left empty for the usual 22.')
  }
  return port
}

// A key file's path, never the key. A private key pasted in by mistake must
// not be kept anywhere, so it is refused before it is stored.
function checkIdentity(value) {
  if (value === null || value === undefined || value === '') return null
  const file = typeof value === 'string' ? value.trim() : ''
  if (/-----BEGIN|PRIVATE KEY|^(?:ssh-(?:rsa|ed25519|dss)|ecdsa-sha2-|sk-)/.test(file)) {
    throw new UserError(
      'That looks like a key itself. Give the path of the key file (like ~/.ssh/id_ed25519): the key is never typed or kept here.',
    )
  }
  // eslint-disable-next-line no-control-regex
  if (!file || file.length > 1024 || /[\u0000-\u001f]/.test(file)) {
    throw new UserError('The key file is a path on this computer, like ~/.ssh/id_ed25519.')
  }
  return file
}

function checkNote(value) {
  if (value === null || value === undefined || value === '') return ''
  const note = typeof value === 'string' ? value.trim() : ''
  // eslint-disable-next-line no-control-regex
  if (note.length > MAX_NOTE || /[\u0000-\u001f]/.test(note)) {
    throw new UserError(`A note is one line of up to ${MAX_NOTE} characters.`)
  }
  return note
}

// ~ and ~/x in a local path, the way a shell would expand them. ssh does this
// itself for -i, but the plugin also checks the file exists first.
function expandHome(file) {
  if (file === '~') return os.homedir()
  if (file.startsWith('~/') || file.startsWith('~\\')) return path.join(os.homedir(), file.slice(2))
  return file
}

// ---- the agent's words, on their way to a remote shell ----

// One word for a POSIX shell: everything inside single quotes is literal,
// and a single quote itself is written as '\'' (close, escaped quote, open).
function shQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`
}

// A remote path as a shell word. A leading ~ is the one thing the agent
// reasonably expects to work, and single quotes would make it a literal tilde:
// it becomes $HOME, spelled by this code and nothing the agent wrote.
function remotePath(value) {
  const file = String(value)
  if (file === '~') return '"$HOME"'
  if (file.startsWith('~/')) return `"$HOME"/${shQuote(file.slice(2))}`
  return shQuote(file)
}

// A string handed to a process as an argument cannot carry a NUL.
function clean(value, what, max) {
  if (typeof value !== 'string' || value === '') throw new UserError(`${what} is needed.`)
  if (value.includes('\u0000')) throw new UserError(`${what} cannot contain a NUL character.`)
  if (value.length > max) throw new UserError(`${what} is longer than ${max.toLocaleString('en-US')} characters.`)
  return value
}

function clampInt(value, min, max, fallback) {
  const n = typeof value === 'number' ? value : Number(value)
  if (value === undefined || value === null || value === '' || !Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, Math.floor(n)))
}

// ---- output: keep the end, say when the start was cut ----

// The last `keep` bytes of a stream, held without ever growing past them: a
// command that prints gigabytes costs this program a megabyte, not the lot.
class Tail {
  constructor(keep = OUTPUT_CAP * 4) {
    this.keep = keep
    this.chunks = []
    this.size = 0
    this.total = 0
  }

  push(chunk) {
    this.total += chunk.length
    this.chunks.push(chunk)
    this.size += chunk.length
    // Whole chunks off the front while what is left still covers the bound.
    while (this.chunks.length > 1 && this.size - this.chunks[0].length >= this.keep) {
      this.size -= this.chunks[0].length
      this.chunks.shift()
    }
  }

  bytes() {
    const all = Buffer.concat(this.chunks)
    return all.length > this.keep ? all.subarray(all.length - this.keep) : all
  }
}

function lastChars(text, count) {
  if (text.length <= count) return text
  const part = text.slice(text.length - count)
  // Never start on the second half of a surrogate pair.
  const first = part.charCodeAt(0)
  return first >= 0xdc00 && first <= 0xdfff ? part.slice(1) : part
}

// A tail decoded as text. A UTF-8 character cut in half at the front is
// dropped rather than shown as a stray symbol.
function tailText(tail) {
  const bytes = tail.bytes()
  let start = 0
  if (tail.total > bytes.length) {
    while (start < 4 && start < bytes.length && (bytes[start] & 0xc0) === 0x80) start += 1
  }
  return bytes.subarray(start).toString('utf8')
}

// Both streams of a command inside one budget, each keeping its end. stderr
// may keep a quarter of the budget even next to a stdout that fills the rest,
// and more when stdout is small: errors are short, and the payload is what
// the command was run for. Answers each as { text, cutBytes }: cutBytes is how
// much of that stream is not in text (0 when all of it is).
function shapeOutput(out, err, cap = OUTPUT_CAP) {
  const outFull = tailText(out)
  const errFull = tailText(err)
  let outKeep = outFull.length
  let errKeep = errFull.length
  if (outKeep + errKeep > cap) {
    errKeep = Math.min(errKeep, Math.max(cap - outKeep, Math.floor(cap / 4)))
    outKeep = Math.min(outKeep, cap - errKeep)
  }
  const outText = lastChars(outFull, outKeep)
  const errText = lastChars(errFull, errKeep)
  return {
    stdout: { text: outText, cutBytes: Math.max(0, out.total - Buffer.byteLength(outText)) },
    stderr: { text: errText, cutBytes: Math.max(0, err.total - Buffer.byteLength(errText)) },
  }
}

// ---- host keys ----

const KEY_LABEL = {
  'ssh-ed25519': 'ED25519',
  'ssh-rsa': 'RSA',
  'ssh-dss': 'DSA',
  'ecdsa-sha2-nistp256': 'ECDSA',
  'ecdsa-sha2-nistp384': 'ECDSA',
  'ecdsa-sha2-nistp521': 'ECDSA',
  'sk-ssh-ed25519@openssh.com': 'ED25519-SK',
  'sk-ecdsa-sha2-nistp256@openssh.com': 'ECDSA-SK',
}

// The fingerprint ssh-keygen -l prints for the same key: SHA256 of the key's
// wire bytes, base64 without padding. It is what a person compares.
function fingerprintOf(blob) {
  const digest = crypto.createHash('sha256').update(Buffer.from(blob, 'base64')).digest('base64').replace(/=+$/, '')
  return `SHA256:${digest}`
}

// The keys in a known_hosts file's text: { hosts, type, blob, line } each.
// Comments, blank lines and @cert-authority / @revoked entries are not keys a
// host presented, so they are left out.
function parseKnownHosts(text) {
  const keys = []
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith('#') || line.startsWith('@')) continue
    const [hosts, type, blob] = line.split(/\s+/)
    if (!hosts || !type || !blob || !/^[A-Za-z0-9+/]+={0,2}$/.test(blob)) continue
    keys.push({ hosts, type, blob, line })
  }
  return keys
}

// Whether a known_hosts host field is for this alias: the alias itself, or
// [alias]:port, in a comma list.
function fieldIsFor(hosts, alias) {
  return hosts.split(',').some((entry) => entry === alias || entry.startsWith(`[${alias}]:`))
}

// ---- ssh's complaints, in plain words ----

// What went wrong with a connection, from what ssh said. `name` is what the
// user calls the host. Answers { kind, message }; the kinds let the page and
// the status line tell "nobody home" from "login refused" from "key changed".
function explain(stderr, name) {
  const said = String(stderr)
  const last = said
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .pop()
  const rules = [
    [
      'hostkey_changed',
      /REMOTE HOST IDENTIFICATION HAS CHANGED|Host key for .+ has changed|host key .*(?:mismatch|does not match)|Offending .+ key in/i,
      `${name}'s host key is not the one that was verified. That happens when the server is reinstalled, and it is also what someone in the way looks like. Nothing was sent. Open Machines > SSH, press Verify on ${name} and compare the new fingerprint with the host's own before trusting it.`,
    ],
    [
      'hostkey_unknown',
      /No (?:\S+ )?host key is known|Host key verification failed/i,
      `${name}'s host key is not recorded. Open Machines > SSH and press Verify on ${name}.`,
    ],
    [
      'identity_perms',
      /UNPROTECTED PRIVATE KEY FILE|Permissions \S+ for .+ are too open|bad permissions/i,
      `ssh will not use the key file set for ${name}: other users can read it. Restrict it to your account (chmod 600 on macOS and Linux) and try again.`,
    ],
    [
      'identity_missing',
      /no such identity|Identity file .+ not accessible/i,
      `The key file set for ${name} was not found on this computer. Check its path in Machines > SSH.`,
    ],
    [
      'auth_many',
      /Too many authentication failures/i,
      `ssh offered more keys than ${name} allows. Set a key file for this host, so only that key is offered.`,
    ],
    [
      'auth',
      /Permission denied/i,
      `${name} refused the login. Only keys are used here, never passwords: the key must be in the host's authorized_keys and loaded in your ssh agent (a key with a passphrase needs ssh-add first, since nothing here can ask for the passphrase), or set a key file for this host.`,
    ],
    [
      'refused',
      /Connection refused/i,
      `Nothing accepts ssh connections at ${name}'s address and port (connection refused). Check them, and that the host's ssh server is running.`,
    ],
    [
      'timeout',
      /Connection timed out|Operation timed out|timed out/i,
      `${name} did not answer in time (connection timed out). Check the address, that the host is up, and any firewall in the way.`,
    ],
    [
      'dns',
      /Could not resolve hostname|nodename nor servname|Name or service not known|No such host is known|Temporary failure in name resolution/i,
      `${name}'s address could not be found. Check its spelling, and that this computer is online.`,
    ],
    [
      'unreachable',
      /Network is unreachable|No route to host|Host is down/i,
      `This computer has no route to ${name}. Check the network or VPN.`,
    ],
    [
      'closed',
      /Connection closed by|Connection reset by|kex_exchange_identification|banner exchange|Broken pipe/i,
      `${name} closed the connection before the login finished. Its ssh server may be restarting or limiting connections, or refusing this account.`,
    ],
    [
      'config',
      /Bad configuration option|Bad option|Unsupported option|Unknown option|command-line line \d+/i,
      "This computer's ssh does not understand an option this plugin sends. It needs OpenSSH 7.6 or newer.",
    ],
  ]
  for (const [kind, pattern, message] of rules) {
    if (pattern.test(said)) return { kind, message }
  }
  return { kind: 'other', message: `ssh could not finish${last ? `: ${last.slice(0, 300)}` : '.'}` }
}

// ---- small ones ----

// A command or path as the audit log keeps it: one string, cut, never output.
function brief(value, max = 1000) {
  const text = String(value)
  return text.length > max ? `${text.slice(0, max)}...` : text
}

function seconds(ms) {
  return ms < 10_000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.round(ms / 1000)} s`
}

const withCommas = (n) => Number(n).toLocaleString('en-US')

module.exports = {
  MAX_COMMAND,
  MAX_PATH,
  MAX_WRITE_BYTES,
  OUTPUT_CAP,
  Tail,
  UserError,
  brief,
  checkAddress,
  checkIdentity,
  checkName,
  checkNote,
  checkPort,
  clampInt,
  clean,
  expandHome,
  explain,
  fieldIsFor,
  fingerprintOf,
  KEY_LABEL,
  lastChars,
  parseKnownHosts,
  remotePath,
  seconds,
  shQuote,
  shapeOutput,
  tailText,
  withCommas,
}
