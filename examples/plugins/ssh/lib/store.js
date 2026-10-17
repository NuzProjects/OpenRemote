// SPDX-License-Identifier: AGPL-3.0-only
//
// What the plugin keeps, in its own data folder (OPENREMOTE_PLUGIN_DATA):
//
//   data.json     the hosts, and the audit log of the agent's calls
//   known_hosts   the host keys the user verified, in OpenSSH's own format
//
// Nothing else, and nothing secret: a host is an address and, at most, the
// path of a key file - never the key, never a password. One program owns the
// folder, so writes are whole-file and atomic (a crash leaves the old file or
// the new one, never half of one).

'use strict'

const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')
const text = require('./text')

const MAX_HOSTS = 100
// The audit log is the last 200 calls an agent made, not a history.
const AUDIT_KEEP = 200

function pause(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

// The new file is written beside the old and moved over it. On Windows the
// move can fail for a moment when something (a scanner, an indexer) has the
// old file open, so it is tried a few times.
function writeAtomic(file, content) {
  const temp = `${file}.${process.pid}.tmp`
  fs.writeFileSync(temp, content, { mode: 0o600 })
  for (let attempt = 0; ; attempt += 1) {
    try {
      fs.renameSync(temp, file)
      return
    } catch (err) {
      if (attempt >= 6 || !['EPERM', 'EBUSY', 'EACCES'].includes(err.code)) {
        try {
          fs.unlinkSync(temp)
        } catch {
          /* nothing to clean up */
        }
        throw err
      }
      pause(25 * (attempt + 1))
    }
  }
}

class Store {
  constructor(dir) {
    this.dir = dir
    this.file = path.join(dir, 'data.json')
    this.knownHostsFile = path.join(dir, 'known_hosts')
    this.scratch = path.join(dir, 'scratch')
    this.data = { version: 1, hosts: [], audit: [], next_seq: 1 }
  }

  open() {
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 })
    let loaded = null
    try {
      loaded = JSON.parse(fs.readFileSync(this.file, 'utf8'))
    } catch (err) {
      if (err.code !== 'ENOENT') {
        // A file that cannot be read is kept aside, not overwritten: the
        // hosts in it are the user's, and may be mended by hand.
        try {
          fs.renameSync(this.file, `${this.file}.unreadable-${Date.now()}`)
        } catch {
          /* it stays where it is */
        }
        this.note = 'The saved hosts could not be read, so the list started empty. The old file was kept beside it.'
      }
    }
    if (loaded && Array.isArray(loaded.hosts)) {
      this.data.hosts = loaded.hosts.filter((h) => h && typeof h.id === 'string' && typeof h.name === 'string')
      this.data.audit = Array.isArray(loaded.audit) ? loaded.audit.slice(-AUDIT_KEEP) : []
      this.data.next_seq = Number.isInteger(loaded.next_seq) ? loaded.next_seq : this.data.audit.length + 1
    }
    // A call that was running when the program stopped did not finish as far
    // as anyone can tell: the log says so rather than leaving it "running".
    let changed = false
    for (const entry of this.data.audit) {
      if (entry.state === 'running') {
        entry.state = 'done'
        entry.note = 'interrupted'
        changed = true
      }
    }
    if (changed) this.save()
    // Scratch files are only ever the host-key scans of a Verify that was
    // under way when the program stopped.
    fs.rmSync(this.scratch, { recursive: true, force: true })
  }

  save() {
    writeAtomic(this.file, `${JSON.stringify(this.data, null, 2)}\n`)
  }

  // ---- hosts ----

  get hosts() {
    return this.data.hosts
  }

  find(name) {
    return this.data.hosts.find((h) => h.name === name) ?? null
  }

  byId(id) {
    return this.data.hosts.find((h) => h.id === id) ?? null
  }

  // What the user typed, checked. `except` is the host being edited, so it
  // may keep its own name.
  read(input, except = null) {
    const fields = {
      name: text.checkName(input?.name),
      address: text.checkAddress(input?.address),
      port: text.checkPort(input?.port),
      identity_file: text.checkIdentity(input?.identity_file),
      note: text.checkNote(input?.note),
    }
    const clash = this.find(fields.name)
    if (clash && clash !== except) throw new text.UserError(`There is already a host named ${fields.name}.`)
    return fields
  }

  add(input) {
    if (this.data.hosts.length >= MAX_HOSTS) throw new text.UserError(`That is ${MAX_HOSTS} hosts, which is the most.`)
    const host = {
      // The id is what the host's key is filed under in known_hosts (as its
      // HostKeyAlias), so renaming a host never loses its verification and
      // two hosts at one address keep their own keys.
      id: `h-${crypto.randomBytes(4).toString('hex')}`,
      ...this.read(input),
      added: Date.now(),
      key: null,
      last_ok: null,
      last_error: null,
    }
    this.data.hosts.push(host)
    this.save()
    return host
  }

  update(name, input) {
    const host = this.find(name)
    if (!host) throw new text.UserError(`There is no host named ${name}.`)
    const fields = this.read(input, host)
    // A different address or port can be a different machine, so what was
    // verified no longer says anything about it.
    const moved = fields.address !== host.address || fields.port !== host.port
    Object.assign(host, fields)
    if (moved) {
      this.forgetKey(host)
      host.key = null
      host.last_ok = null
      host.last_error = null
    }
    this.save()
    return { host, moved }
  }

  remove(name) {
    const host = this.find(name)
    if (!host) throw new text.UserError(`There is no host named ${name}.`)
    this.forgetKey(host)
    this.data.hosts.splice(this.data.hosts.indexOf(host), 1)
    this.save()
  }

  // The outcome of the last real attempt to reach a host.
  noteReach(host, error) {
    if (!this.byId(host.id)) return
    if (error) host.last_error = { at: Date.now(), kind: error.kind, message: error.message }
    else {
      host.last_ok = Date.now()
      host.last_error = null
    }
    this.save()
  }

  // ---- host keys ----

  knownHosts() {
    try {
      return text.parseKnownHosts(fs.readFileSync(this.knownHostsFile, 'utf8'))
    } catch {
      return []
    }
  }

  // Verified means two things agree: the user pressed Trust (the host's
  // record says when, and which key), and the key is in the file ssh reads.
  isVerified(host) {
    return Boolean(host.key) && this.knownHosts().some((k) => text.fieldIsFor(k.hosts, host.id))
  }

  // The lines are exactly what ssh wrote when it met the host, kept as it
  // wrote them: ssh will look for them the way it filed them.
  recordKey(host, lines, fingerprint, type) {
    this.forgetKey(host, false)
    let existing = ''
    try {
      existing = fs.readFileSync(this.knownHostsFile, 'utf8')
    } catch {
      /* the first key */
    }
    const base = existing && !existing.endsWith('\n') ? `${existing}\n` : existing
    writeAtomic(this.knownHostsFile, `${base}${lines.join('\n')}\n`)
    host.key = { fingerprint, type, at: Date.now() }
    host.last_error = null
    this.save()
  }

  forgetKey(host, andSave = false) {
    let existing
    try {
      existing = fs.readFileSync(this.knownHostsFile, 'utf8')
    } catch {
      return
    }
    const kept = existing
      .split(/\r?\n/)
      .filter((line) => {
        const [hosts] = line.trim().split(/\s+/)
        return !(hosts && text.fieldIsFor(hosts, host.id))
      })
      .join('\n')
    writeAtomic(this.knownHostsFile, kept.trim() ? `${kept.replace(/\n+$/, '')}\n` : '')
    if (andSave) this.save()
  }

  // A fresh, private place for one host-key scan.
  scanFile() {
    fs.mkdirSync(this.scratch, { recursive: true, mode: 0o700 })
    const file = path.join(this.scratch, `scan-${crypto.randomBytes(6).toString('hex')}`)
    fs.writeFileSync(file, '', { mode: 0o600 })
    return file
  }

  // ---- the audit log ----

  // The log keeps what the agent asked for and how it ended - never what a
  // file said or what a command printed. An entry is written before the call
  // runs, so a call that never finishes is still on record.
  auditBegin({ host, tool, detail }) {
    const entry = {
      seq: this.data.next_seq,
      at: Date.now(),
      host,
      tool,
      detail: text.brief(detail),
      state: 'running',
      exit: null,
      note: null,
      ms: null,
    }
    this.data.next_seq += 1
    this.data.audit.push(entry)
    if (this.data.audit.length > AUDIT_KEEP) this.data.audit.splice(0, this.data.audit.length - AUDIT_KEEP)
    this.save()
    return entry
  }

  auditEnd(entry, { exit = null, note = null }) {
    entry.state = 'done'
    entry.exit = exit
    entry.note = note
    entry.ms = Date.now() - entry.at
    this.save()
  }

  // A call that was refused before anything ran.
  auditRefused(call, note) {
    this.auditEnd(this.auditBegin(call), { note })
  }
}

module.exports = { AUDIT_KEEP, Store }
