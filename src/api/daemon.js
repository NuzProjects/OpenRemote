// The daemon API client. Every mutating call carries a client request_id
// (the receipt contract: retries dedup; crashes surface as unknown, never
// resent). SSE subscriptions resume from a cursor. Every call but the
// installer and the event stream carries a timeout, so a daemon that is
// wedged (alive, but not answering) surfaces as an error instead of a
// hang.

const TOKEN_KEY = 'openremote-daemon-token'
const URL_KEY = 'openremote-daemon-url'

// A normal request must answer within this; a daemon that is alive but
// stuck holds every spinner forever without it. The installer is exempt
// (it runs minutes by design), and so is the SSE reader (its lifetime is
// the stream).
const CALL_TIMEOUT_MS = 10000

// Calls whose wait includes a harness boot: creating or resuming a chat
// spawns the harness CLI and waits for its first answer (opencode's serve
// line is capped at 30 s, pi's first RPC at 60 s, claude's model handshake
// at 30 s), so the normal budget would cut a slow cold boot in half and
// a retry would land as a second chat. Well above every daemon-side boot
// cap, still bounded: the poll's own banner (three missed 10 s beats)
// says "not answering" long before this fires.
const BOOT_TIMEOUT_MS = 120000

// The resume cursor of an SSE stream: the highest event seq the client
// already holds. Only a non-negative integer counts (a digit string too,
// since a cursor can survive a round trip through storage or a URL) -
// anything else is "no cursor", one deliberate full replay, so a garbage
// value can never pose as a position and starve the stream of events.
export function parseCursor(value) {
  if (typeof value === 'number') return Number.isInteger(value) && value >= 0 ? value : null
  if (typeof value === 'string' && /^\d+$/.test(value)) return Number(value)
  return null
}

// One line of an SSE frame. The daemon writes each frame as
// `id: <seq>\ndata: <json>` - the id line first, so even a frame whose
// data cannot be parsed has its seq in hand. Returns `{ seq }` for an id
// line, `{ event }` for a well-formed data line, `{ malformed: true }` for
// a data line that is not JSON, and null for everything else (frame
// separators, keep-alive comments, an unreadable id).
export function parseSseLine(line) {
  if (line.startsWith('id: ')) {
    const seq = parseCursor(line.slice(4))
    return seq == null ? null : { seq }
  }
  if (line.startsWith('data: ')) {
    try {
      return { event: JSON.parse(line.slice(6)) }
    } catch {
      return { malformed: true }
    }
  }
  return null
}

export function loadConnection() {
  try {
    return { url: localStorage.getItem(URL_KEY), token: localStorage.getItem(TOKEN_KEY) }
  } catch {
    return { url: null, token: null }
  }
}

export function saveConnection(url, token) {
  try {
    if (url) localStorage.setItem(URL_KEY, url)
    if (token) localStorage.setItem(TOKEN_KEY, token)
  } catch {
    /* storage unavailable */
  }
}

export function clearConnection() {
  try {
    localStorage.removeItem(URL_KEY)
    localStorage.removeItem(TOKEN_KEY)
  } catch {
    /* storage unavailable */
  }
}

export function newRequestId() {
  return globalThis.crypto?.randomUUID?.() ?? `req-${Date.now()}-${Math.random().toString(16).slice(2)}`
}

export class DaemonApi {
  // `prefix` points every call at another of the user's devices, through
  // this daemon (`/devices/<id>`): the same API, answered over there.
  constructor(url, token, prefix = '') {
    let clean = url?.replace(/\/+$/, '') ?? null
    // Manual entry often omits the scheme; without one, fetch treats the
    // address as a relative path and fails confusingly.
    if (clean && !/^https?:\/\//.test(clean)) clean = `http://${clean}`
    this.url = clean
    this.token = token
    this.prefix = prefix
  }

  /** The same client, aimed at another of the user's devices. */
  device(id) {
    return id ? new DaemonApi(this.url, this.token, `/devices/${id}`) : this
  }

  get ready() {
    return Boolean(this.url && this.token)
  }

  async call(method, path, body, { timeoutMs = CALL_TIMEOUT_MS } = {}) {
    let response
    let text = ''
    try {
      response = await fetch(`${this.url}${this.prefix}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${this.token}`,
          ...(body ? { 'Content-Type': 'application/json' } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
        // `null` opts out (the calls whose wait is the point); otherwise
        // the request must answer within `timeoutMs`.
        signal: timeoutMs == null ? undefined : AbortSignal.timeout(timeoutMs),
      })
      text = await response.text()
    } catch (err) {
      // A timed-out request reads as "not answering": the signal aborts
      // both the headers wait and a stalled body read, and callers only
      // have err.message to show - the browser's own "signal timed out"
      // says nothing.
      if (err?.name === 'TimeoutError' || err?.name === 'AbortError') {
        throw new Error('The daemon did not answer in time')
      }
      throw err
    }
    let json = null
    try {
      json = text ? JSON.parse(text) : null
    } catch {
      json = null
    }
    if (!response.ok) {
      const error = new Error(json?.error ?? `HTTP ${response.status}`)
      error.status = response.status
      throw error
    }
    return json
  }

  health() {
    return this.call('GET', '/healthz')
  }

  capabilities() {
    return this.call('GET', '/capabilities')
  }

  sessions() {
    return this.call('GET', '/sessions')
  }

  session(id) {
    return this.call('GET', `/sessions/${id}`)
  }

  // Creating the chat boots the harness (up to 60 s of CLI cold start
  // daemon-side) - the boot budget, not the normal one.
  createSession({ harness, workspace, model, effort, permissionMode, fast, deviceId, synced }) {
    return this.call(
      'POST',
      '/sessions',
      {
        request_id: newRequestId(),
        harness,
        workspace,
        ...(model ? { model } : {}),
        ...(effort ? { effort } : {}),
        ...(permissionMode ? { permission_mode: permissionMode } : {}),
        ...(fast ? { fast: true } : {}),
        ...(deviceId ? { device_id: deviceId } : {}),
        ...(synced ? { synced: true } : {}),
      },
      { timeoutMs: BOOT_TIMEOUT_MS },
    )
  }

  /** Syncs a private chat to the user's other devices (it keeps running here). */
  syncSession(id) {
    return this.call('POST', `/sessions/${id}/sync`, { request_id: newRequestId() })
  }

  /** Deletes a synced chat on every device. */
  deleteSession(id) {
    return this.call('DELETE', `/sessions/${id}`)
  }

  // Cloud mode: this computer's account and devices.

  cloud() {
    return this.call('GET', '/cloud')
  }

  /** Starts a moreweb sign-in; `open` has the daemon open the browser. */
  cloudSignIn({ open = true } = {}) {
    return this.call('POST', '/cloud/signin', { open })
  }

  cloudSignInCancel() {
    return this.call('POST', '/cloud/signin/cancel')
  }

  cloudSignOut() {
    return this.call('POST', '/cloud/signout')
  }

  cloudDevices() {
    return this.call('GET', '/cloud/devices')
  }

  setDeviceKind(id, kind) {
    return this.call('POST', `/cloud/devices/${id}/kind`, { kind })
  }

  removeDevice(id) {
    return this.call('DELETE', `/cloud/devices/${id}`)
  }

  createEnrollment() {
    return this.call('POST', '/cloud/enrollments')
  }

  /** The subfolders of `path` (default: home) on the device this aims at. */
  fsDirs(path) {
    return this.call('GET', `/fs/dirs${path ? `?path=${encodeURIComponent(path)}` : ''}`)
  }

  prompt(id, text) {
    return this.call('POST', `/sessions/${id}/prompts`, { request_id: newRequestId(), text })
  }

  // Model, effort, and fast on a live chat. A harness that only accepts the
  // change when the chat starts answers 409 - the composer says so.
  updateSettings(id, { model, effort, fast }) {
    return this.call('POST', `/sessions/${id}/settings`, {
      request_id: newRequestId(),
      ...(model ? { model } : {}),
      ...(effort ? { effort } : {}),
      ...(fast != null ? { fast } : {}),
    })
  }

  stop(id) {
    return this.call('POST', `/sessions/${id}/stop`, { request_id: newRequestId() })
  }

  // Interrupt the running turn - the harness cancels, the session stays
  // alive for the next message. Unlike stop, nothing dies.
  interrupt(id) {
    return this.call('POST', `/sessions/${id}/interrupt`, { request_id: newRequestId() })
  }

  // Resuming boots the harness again (the same cold-start window as
  // creating) - the boot budget.
  resume(id) {
    return this.call('POST', `/sessions/${id}/resume`, { request_id: newRequestId() }, { timeoutMs: BOOT_TIMEOUT_MS })
  }

  decisions(id) {
    return this.call('GET', `/sessions/${id}/decisions`)
  }

  // ---- machines ----

  machines() {
    return this.call('GET', '/machines')
  }

  createMachine({ name, platform }) {
    return this.call('POST', '/machines', { request_id: newRequestId(), name, platform })
  }

  removeMachine(id) {
    return this.call('DELETE', `/machines/${id}?request_id=${encodeURIComponent(newRequestId())}`)
  }

  // The long one: an installer runs minutes - the receipt carries the
  // wait. `withRuntime` is the human's go-ahead to set up a runtime the
  // harness needs (pi's Node.js); the daemon never assumes it. No
  // timeout here: the wait is the contract (the daemon holds its own
  // 600 s limit).
  installHarness(machineId, harnessId, { withRuntime = false } = {}) {
    return this.call(
      'POST',
      `/machines/${machineId}/harnesses`,
      {
        request_id: newRequestId(),
        harness: harnessId,
        with_runtime: withRuntime,
      },
      { timeoutMs: null },
    )
  }

  // ---- plugins ----

  plugins() {
    return this.call('GET', '/plugins')
  }

  pluginMarketplace() {
    return this.call('GET', '/plugins/marketplace')
  }

  installPlugin(machineId, { catalogId, name, detail, command, needsKey }) {
    return this.call('POST', '/plugins', {
      request_id: newRequestId(),
      machine: machineId,
      ...(catalogId ? { catalog_id: catalogId } : { name, detail, command, needs_key: needsKey }),
    })
  }

  removePlugin(pluginId) {
    return this.call('DELETE', `/plugins/${pluginId}?request_id=${encodeURIComponent(newRequestId())}`)
  }

  setPluginEnabled(pluginId, enabled) {
    return this.call('POST', `/plugins/${pluginId}/enabled`, {
      request_id: newRequestId(),
      enabled,
    })
  }

  acknowledgePluginKey(pluginId) {
    return this.call('POST', `/plugins/${pluginId}/key`, { request_id: newRequestId() })
  }

  // ---- automations ----

  automations() {
    return this.call('GET', '/automations')
  }

  // `id` on the body edits; its absence creates.
  saveRule(rule) {
    return this.call('POST', '/automations', {
      request_id: newRequestId(),
      name: rule.name,
      trigger: rule.trigger,
      harness: rule.harness,
      ...(rule.model ? { model: rule.model } : {}),
      workspace: rule.workspace,
      machine: rule.machine,
      task: rule.task,
      ...(rule.id ? { id: rule.id, enabled: rule.enabled } : {}),
    })
  }

  removeRule(ruleId) {
    return this.call(
      'DELETE',
      `/automations/${ruleId}?request_id=${encodeURIComponent(newRequestId())}`,
    )
  }

  setRuleEnabled(ruleId, enabled) {
    return this.call('POST', `/automations/${ruleId}/enabled`, {
      request_id: newRequestId(),
      enabled,
    })
  }

  // Run now creates the chat and delivers the task - a harness boot
  // rides the request, so the boot budget.
  runRule(ruleId) {
    return this.call(
      'POST',
      `/automations/${ruleId}/run`,
      { request_id: newRequestId() },
      { timeoutMs: BOOT_TIMEOUT_MS },
    )
  }

  // ---- projects ----

  /** The registered projects, daemon-side (the same list every surface reads). */
  projects() {
    return this.call('GET', '/projects')
  }

  /** Register a folder as a project. One folder this release; the array is
   *  the multi-folder future. */
  createProject({ folders }) {
    return this.call('POST', '/projects', {
      request_id: newRequestId(),
      folders,
    })
  }

  /** Unregister - the folder on disk and its chats are untouched. */
  removeProject(projectId) {
    return this.call(
      'DELETE',
      `/projects/${projectId}?request_id=${encodeURIComponent(newRequestId())}`,
    )
  }

  // The models a harness advertises, in its own words (empty = the slot
  // stays reserved for that harness). The catalog comes from a
  // short-lived harness CLI (a 30 s handshake daemon-side) - the boot
  // budget, so a cold CLI is not cut off mid-handshake.
  models(harnessId) {
    return this.call('GET', `/harnesses/${harnessId}/models`, null, { timeoutMs: BOOT_TIMEOUT_MS })
  }

  // ---- harness sign-in ----

  // Start the harness's own login command, relayed: the returned view is
  // the first beat; poll signInView for the CLI's words, feed the human's
  // answers through signInInput.
  startSignIn(harnessId) {
    return this.call('POST', `/harnesses/${harnessId}/signin`, {
      request_id: newRequestId(),
    })
  }

  signInView(harnessId) {
    return this.call('GET', `/harnesses/${harnessId}/signin`)
  }

  signInInput(harnessId, text) {
    return this.call('POST', `/harnesses/${harnessId}/signin/input`, {
      request_id: newRequestId(),
      text,
    })
  }

  // Stop a running sign-in relay - the abandoned-browser-flow answer.
  stopSignIn(harnessId) {
    return this.call('POST', `/harnesses/${harnessId}/signin/stop`, {
      request_id: newRequestId(),
    })
  }

  answer(decisionId, choice) {
    return this.call('POST', `/decisions/${decisionId}/answer`, {
      request_id: newRequestId(),
      choice,
    })
  }

  // The live event stream for one session. `onEvent` receives each parsed
  // event; the reader keeps going until the connection drops, then reports
  // the last cursor through `onClose(cursor)` so the caller can resume with
  // `after`. Returns a stop function.
  events(id, { after = null, onEvent, onClose }) {
    const controller = new AbortController()
    const run = async () => {
      // A garbage cursor is deliberately absent: one clean full replay
      // rather than a resume that can never find its position.
      let cursor = parseCursor(after)
      let lastId = cursor
      let skipped = 0
      try {
        const query = cursor == null ? '' : `?after=${cursor}`
        const response = await fetch(`${this.url}/sessions/${id}/events${query}`, {
          headers: { Authorization: `Bearer ${this.token}` },
          // No timeout: this connection's lifetime is the stream itself
          // (the stop handle and the poll decide when it ends).
          signal: controller.signal,
        })
        if (!response.ok || !response.body) throw new Error(`SSE HTTP ${response.status}`)
        const reader = response.body.getReader()
        const decoder = new TextDecoder()
        let buffer = ''
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          buffer += decoder.decode(value, { stream: true })
          let index
          while ((index = buffer.indexOf('\n')) >= 0) {
            const line = buffer.slice(0, index).replace(/\r$/, '')
            buffer = buffer.slice(index + 1)
            const parsed = parseSseLine(line)
            if (parsed?.seq != null) {
              lastId = parsed.seq
            } else if (parsed?.event) {
              // The event's own seq when it carries a sane one; the id
              // line otherwise. Either way the cursor only moves
              // forward to a real position.
              cursor = parseCursor(parsed.event.seq) ?? lastId ?? cursor
              onEvent(parsed.event)
            } else if (parsed?.malformed) {
              // A frame the console cannot read is skipped, not fatal:
              // its seq already arrived on the id: line, so the cursor
              // still moves past it and a reconnect never replays into
              // the same bad line forever.
              skipped += 1
              if (skipped === 1 || skipped === 10) {
                console.error(`OpenRemote: skipped ${skipped} unreadable event frames in session ${id}`)
              }
              cursor = lastId ?? cursor
            }
          }
        }
        onClose?.(lastId)
      } catch (err) {
        if (err?.name !== 'AbortError') onClose?.(lastId ?? cursor)
      }
    }
    run()
    return () => controller.abort()
  }
}
