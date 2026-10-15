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

// Whether a stream close means the session itself is gone: the daemon
// answered 404 ("no such session"), a chat deleted here or on another
// device. No retry can outlive that - every other close (a dropped
// connection, a wedged daemon, another HTTP error) deserves another
// attempt.
export function sessionGone(err) {
  return err?.status === 404
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

  async call(method, path, body, { timeoutMs = CALL_TIMEOUT_MS, signal = null } = {}) {
    let response
    let text = ''
    // The timeout and the caller's own stop (an unmounting folder
    // picker, say) each end the request, whichever fires first. The
    // two aborts are told apart by who aborted: the timeout's error is
    // "not answering", the caller's is a deliberate cancel the stopper
    // ignores.
    let timedOut = false
    let controller = null
    let forward = null
    let fetchSignal = null
    if (timeoutMs != null) {
      const timeoutSignal = AbortSignal.timeout(timeoutMs)
      controller = new AbortController()
      const onTimeout = () => {
        timedOut = true
        controller.abort()
      }
      if (timeoutSignal.aborted) onTimeout()
      else timeoutSignal.addEventListener('abort', onTimeout, { once: true })
      fetchSignal = controller.signal
    }
    if (signal != null) {
      controller ??= new AbortController()
      forward = () => controller.abort()
      if (signal.aborted) controller.abort()
      else signal.addEventListener('abort', forward, { once: true })
      fetchSignal = controller.signal
    }
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
        signal: fetchSignal ?? undefined,
      })
      text = await response.text()
    } catch (err) {
      // A timed-out request reads as "not answering": the signal aborts
      // both the headers wait and a stalled body read, and callers only
      // have err.message to show - the browser's own "signal timed out"
      // says nothing. A caller's own stop is a deliberate cancel, not a
      // failure: the raw error rides through and the stopper ignores it.
      if (timedOut) {
        throw new Error('The daemon did not answer in time')
      }
      if (signal?.aborted) {
        throw err
      }
      if (err?.name === 'TimeoutError' || err?.name === 'AbortError') {
        throw new Error('The daemon did not answer in time')
      }
      throw err
    } finally {
      if (forward != null && signal != null) signal.removeEventListener('abort', forward)
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

  // The one route that answers a document rather than JSON: the
  // third-party notices, served as plain text because they are read,
  // not parsed. Same token as everything else.
  async notices() {
    const response = await fetch(`${this.url}${this.prefix}/notices`, {
      headers: { Authorization: `Bearer ${this.token}` },
      signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
    })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    return response.text()
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

  // The receipt contract covers these too: a retry (or a double-firing
  // mount effect) with the same request_id is one mutation, not two.
  // The daemon's cloud routes read what they know and ignore the rest.

  /** Starts a moreweb sign-in; `open` has the daemon open the browser. */
  cloudSignIn({ open = true } = {}) {
    return this.call('POST', '/cloud/signin', { request_id: newRequestId(), open })
  }

  cloudSignInCancel() {
    return this.call('POST', '/cloud/signin/cancel', { request_id: newRequestId() })
  }

  cloudSignOut() {
    return this.call('POST', '/cloud/signout', { request_id: newRequestId() })
  }

  cloudDevices() {
    return this.call('GET', '/cloud/devices')
  }

  setDeviceKind(id, kind) {
    return this.call('POST', `/cloud/devices/${id}/kind`, { request_id: newRequestId(), kind })
  }

  removeDevice(id) {
    return this.call('DELETE', `/cloud/devices/${id}?request_id=${encodeURIComponent(newRequestId())}`)
  }

  createEnrollment() {
    return this.call('POST', '/cloud/enrollments', { request_id: newRequestId() })
  }

  /** The subfolders of `path` (default: home) on the device this aims at.
   *  `signal` is the caller's own stop for a navigation that no longer
   *  matters (the folder picker moved on or unmounted). */
  fsDirs(path, { signal = null } = {}) {
    return this.call('GET', `/fs/dirs${path ? `?path=${encodeURIComponent(path)}` : ''}`, null, { signal })
  }

  prompt(id, text) {
    return this.call('POST', `/sessions/${id}/prompts`, { request_id: newRequestId(), text })
  }

  // Model, effort, and fast on a live chat. A harness that only accepts the
  // change when the chat starts answers 409 - the composer says so. The
  // permission word is the same shape: start-time only, so a live chat's
  // change conflicts and a stopped chat's lands on resume.
  updateSettings(id, { model, effort, fast, permissionMode }) {
    return this.call('POST', `/sessions/${id}/settings`, {
      request_id: newRequestId(),
      ...(model ? { model } : {}),
      ...(effort ? { effort } : {}),
      ...(fast != null ? { fast } : {}),
      ...(permissionMode ? { permission_mode: permissionMode } : {}),
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

  // The chat's queue - the daemon keeps it, so every device sees the same
  // one. A queued message runs as its own turn when the running one ends.
  queue(id, text) {
    return this.call('POST', `/sessions/${id}/queue`, { request_id: newRequestId(), text })
  }

  queueRemove(id, item) {
    return this.call('POST', `/sessions/${id}/queue/${item}/remove`, { request_id: newRequestId() })
  }

  // Steer may start a stopped chat first - the boot budget, like resume.
  queueSteer(id, item) {
    return this.call(
      'POST',
      `/sessions/${id}/queue/${item}/steer`,
      { request_id: newRequestId() },
      { timeoutMs: BOOT_TIMEOUT_MS },
    )
  }

  queueResume(id) {
    return this.call('POST', `/sessions/${id}/queue/resume`, { request_id: newRequestId() }, { timeoutMs: BOOT_TIMEOUT_MS })
  }

  // A message straight into the running turn, never through the queue.
  steer(id, text) {
    return this.call('POST', `/sessions/${id}/steer`, { request_id: newRequestId(), text }, { timeoutMs: BOOT_TIMEOUT_MS })
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

  // ---- plugins (Plugins) ----

  plugins() {
    return this.call('GET', '/plugins')
  }

  // Reading a plugin fetches it first - a clone or a download can take a
  // while - and installs nothing; the answer is what it asks for.
  stagePlugin(source) {
    return this.call('POST', '/plugins/stage', { request_id: newRequestId(), source }, { timeoutMs: 180_000 })
  }

  installStagedPlugin(stageId) {
    return this.call('POST', `/plugins/stage/${stageId}/install`, { request_id: newRequestId() })
  }

  cancelStagedPlugin(stageId) {
    return this.call('POST', `/plugins/stage/${stageId}/cancel`, { request_id: newRequestId() })
  }

  setPluginEnabled(name, enabled) {
    return this.call('POST', `/plugins/${name}/enabled`, { request_id: newRequestId(), enabled })
  }

  removePlugin(name) {
    return this.call('POST', `/plugins/${name}/remove`, { request_id: newRequestId() })
  }

  // ---- MCP servers (Settings > MCP servers) ----

  mcpServers() {
    return this.call('GET', '/mcp-servers')
  }

  mcpMarketplace() {
    return this.call('GET', '/mcp-servers/marketplace')
  }

  addMcpServer(machineId, { catalogId, name, detail, command, needsKey }) {
    return this.call('POST', '/mcp-servers', {
      request_id: newRequestId(),
      machine: machineId,
      ...(catalogId ? { catalog_id: catalogId } : { name, detail, command, needs_key: needsKey }),
    })
  }

  removeMcpServer(id) {
    return this.call('DELETE', `/mcp-servers/${id}?request_id=${encodeURIComponent(newRequestId())}`)
  }

  setMcpServerEnabled(id, enabled) {
    return this.call('POST', `/mcp-servers/${id}/enabled`, {
      request_id: newRequestId(),
      enabled,
    })
  }

  acknowledgeMcpServerKey(id) {
    return this.call('POST', `/mcp-servers/${id}/key`, { request_id: newRequestId() })
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
      ...(rule.permission_mode ? { permission_mode: rule.permission_mode } : {}),
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
  // the last cursor through `onClose(cursor, err)` so the caller can resume
  // with `after` - or stop retrying when `err` carries the daemon's own
  // "no such session" (see sessionGone). Returns a stop function.
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
        if (!response.ok || !response.body) {
          // The status rides the error (the same shape as call()): the
          // close callback must be able to tell a dead session from a
          // dead connection, or a deleted chat retries forever.
          const error = new Error(`SSE HTTP ${response.status}`)
          error.status = response.status
          throw error
        }
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
        // An aborted stop is not a close. Anything else reports the last
        // cursor, and the error itself rides along as the second argument
        // so the caller can stop retrying when the session is gone.
        if (err?.name !== 'AbortError') onClose?.(lastId ?? cursor, err)
      }
    }
    run()
    return () => controller.abort()
  }
}
