// The console's connection and chat state: one daemon connection, a
// polled session list for the sidebar, and one live SSE subscription for
// the open chat (resuming from its cursor across reconnects).

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { DaemonApi, clearConnection, loadConnection, saveConnection, sessionGone } from '../api/daemon.js'
import { chatFromSession, foldEvent, mergeSessionIntoChat, vanishedChatIds } from './reducer.js'
import { isMobile, openExternal } from '../platform.js'
import { loadArchived, saveArchived, withArchived } from '../archive.js'

const ConsoleContext = createContext(null)

const hasTauri = typeof window !== 'undefined' && !!window.__TAURI_INTERNALS__

// How many sign-in poll beats in a row (800 ms each, about 30 s) may
// fail to read the relay's view before the relay is declared dead: one
// dropped read heals, only a view nobody can read over and over is a
// failure.
const SIGNIN_POLL_MISSES = 40

export function ConsoleProvider({ children }) {
  const [api, setApi] = useState(() => {
    const saved = loadConnection()
    return new DaemonApi(saved.url, saved.token)
  })
  const [connection, setConnection] = useState(() => {
    const saved = loadConnection()
    return { state: saved.url && saved.token ? 'connecting' : 'new', error: null }
  })
  const [capabilities, setCapabilities] = useState(null)
  const [sessions, setSessions] = useState([])
  const [machines, setMachines] = useState([])
  const [mcpServers, setMcpServers] = useState([])
  // The Plugins page: the built-in harness plugins and what is installed.
  const [plugins, setPlugins] = useState(null)
  // Plugins > Marketplaces, and Discover's entries from their catalogs.
  const [marketplaces, setMarketplaces] = useState([])
  const [catalog, setCatalog] = useState(null)
  const [automations, setAutomations] = useState([])
  // The registered projects - daemon-side, the one list every surface
  // reads (the sidebar's groups, the composer's picker, the pill).
  const [projects, setProjects] = useState([])
  const [chats, setChats] = useState({})
  const [modelsByHarness, setModelsByHarness] = useState({})
  // Cloud: this computer's account state, and the account's devices.
  const [cloud, setCloud] = useState(null)
  const [devices, setDevices] = useState([])
  const [capabilitiesByDevice, setCapabilitiesByDevice] = useState({})
  // The chats on screen: each holds a live stream while it is watched, so
  // several panes can show running agents at once.
  const [watched, setWatched] = useState([])
  const [archived, setArchived] = useState(loadArchived)
  const streamsRef = useRef(new Map())
  const chatsRef = useRef({})
  // Ids a poll has carried at least once - what tells a chat gone from
  // this beat (deleted elsewhere) from one not yet in any beat (created
  // between polls, fresher than the list).
  const polledIdsRef = useRef(new Set())

  const connect = useCallback((url, token) => {
    saveConnection(url, token)
    setApi(new DaemonApi(url, token))
    setConnection({ state: 'connecting', error: null })
  }, [])

  const disconnect = useCallback(() => {
    clearConnection()
    setApi(new DaemonApi(null, null))
    setConnection({ state: 'new', error: null })
    setSessions([])
    setChats({})
    setWatched([])
  }, [])

  // Fresh capabilities - the harness rows carry the harness's own status
  // words; a sign-in that settled re-reads them.
  const refreshCapabilities = useCallback(async () => {
    try {
      setCapabilities((await api.capabilities()) ?? null)
    } catch {
      /* the poll heals */
    }
  }, [api])

  // In the desktop shell the daemon is a sidecar: ask the shell for its
  // address once on boot before falling back to the saved connection.
  useEffect(() => {
    if (!hasTauri) return
    let cancelled = false
    let attempt = 0
    const ask = async () => {
      try {
        const { invoke } = await import('@tauri-apps/api/core')
        const info = await invoke('daemon_info')
        if (cancelled) return
        if (info?.url && info?.token) {
          connect(info.url, info.token)
        } else if (attempt < 150) {
          // The sidecar is still booting (a freshly built exe can take a
          // slow first run) - keep asking for a long while yet.
          attempt += 1
          setTimeout(ask, 600)
        } else if (!api.ready) {
          setConnection({ state: 'waiting-daemon', error: null })
        }
      } catch {
        /* the shell will report when it can; the wizard remains reachable */
      }
    }
    ask()
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // The desktop shell owns the sidecar: while the connection holds an
  // error, keep asking the shell for the daemon's address - a sidecar
  // that came back on a new port is followed without a reload. The
  // browser has only the address it was given; its error copy says so.
  useEffect(() => {
    if (!hasTauri || connection.state !== 'error') return
    let cancelled = false
    const ask = async () => {
      try {
        const { invoke } = await import('@tauri-apps/api/core')
        const info = await invoke('daemon_info')
        if (cancelled) return
        if (info?.url && info?.token) connect(info.url, info.token)
      } catch {
        /* still gone - the next tick asks again */
      }
    }
    const retry = setInterval(ask, 2500)
    return () => {
      cancelled = true
      clearInterval(retry)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connection.state])

  // Verify the connection, then load capabilities + sessions.
  useEffect(() => {
    if (!api.ready || connection.state === 'connected') return
    let cancelled = false
    ;(async () => {
    try {
      await api.health()
      const caps = await api.capabilities()
      const list = await api.sessions()
      const machineList = await api.machines()
      const mcpList = await api.mcpServers()
      const pluginList = await api.plugins().catch(() => null)
      const marketList = await api.marketplaces().catch(() => [])
      const catalogList = await api.marketplaceCatalog().catch(() => null)
      const rules = await api.automations()
      const projectList = await api.projects().catch(() => [])
      // Cloud is optional: a daemon without it still connects.
      const [cloudView, deviceList] = await Promise.allSettled([api.cloud(), api.cloudDevices()])
      if (cancelled) return
      if (cloudView.status === 'fulfilled') setCloud(cloudView.value)
      if (deviceList.status === 'fulfilled') setDevices(deviceList.value?.devices ?? [])
      setCapabilities(caps)
      setSessions(list ?? [])
      setMachines(machineList ?? [])
      setMcpServers(mcpList ?? [])
      setPlugins(pluginList)
      setMarketplaces(marketList ?? [])
      setCatalog(catalogList)
      setAutomations(rules ?? [])
      setProjects(projectList ?? [])
      setConnection({ state: 'connected', error: null })
    } catch (err) {
        if (cancelled) return
        // A fetch that never answered is the daemon being unreachable -
        // say that, not the browser's own "Failed to fetch". Anything the
        // daemon answered with (a refused token, a status) is its words.
        const unreachable = err instanceof TypeError
        setConnection({
          state: 'error',
          error: unreachable
            ? "The daemon didn't answer - check that it's running, or reconnect from Settings."
            : err.message ?? String(err),
        })
      }
    })()
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, connection.state])

  // Poll the live lists while a daemon is configured (the sidebar's
  // truth; machines, MCP servers, and rules ride the same beat). A single
  // dropped call is nothing - but three beats with no answer at all
  // means the daemon is gone, and the connection says so instead of
  // freezing quietly on stale data. The poll keeps watching: the first
  // answering beat heals it, and no screen has to be reloaded.
  useEffect(() => {
    if (!api.ready) return
    let misses = 0
    const poll = setInterval(async () => {
      const [sessionList, machineList, mcpList, ruleList, projectList, cloudView, deviceList] =
        await Promise.allSettled([
          api.sessions(),
          api.machines(),
          api.mcpServers(),
          api.automations(),
          api.projects(),
          api.cloud(),
          api.cloudDevices(),
        ])
      if (cloudView.status === 'fulfilled') setCloud(cloudView.value)
      if (deviceList.status === 'fulfilled') setDevices(deviceList.value?.devices ?? [])
      if (sessionList.status === 'fulfilled') setSessions(sessionList.value ?? [])
      if (machineList.status === 'fulfilled') setMachines(machineList.value ?? [])
      if (mcpList.status === 'fulfilled') setMcpServers(mcpList.value ?? [])
      if (ruleList.status === 'fulfilled') setAutomations(ruleList.value ?? [])
      if (projectList.status === 'fulfilled') setProjects(projectList.value ?? [])
      const answered = [sessionList, machineList, mcpList, ruleList].some(
        (r) => r.status === 'fulfilled',
      )
      if (answered) {
        misses = 0
        if (connection.state === 'error') setConnection({ state: 'connected', error: null })
      } else {
        misses += 1
        if (misses >= 3 && connection.state === 'connected') {
          setConnection({
            state: 'error',
            error: 'The daemon stopped answering - it may have exited. Restart the app, or reconnect from Settings.',
          })
        }
      }
    }, 2500)
    return () => clearInterval(poll)
  }, [api, connection.state])

  // Keep chat records in step with the polled session list: merge
  // identities (status/workspace) without disturbing folded transcripts.
  // The merge decision lives in reducer.js (mergeSessionIntoChat) so its
  // preserved-field contract is tested: event-folded facts the session
  // payload doesn't carry (the timeline, the context numbers, the
  // running cost and thinking-token totals, the decisions list) survive
  // every beat - the stream owns them. A record whose session left the
  // list goes with it (vanishedChatIds): its pane falls back to "no
  // longer in this workspace", its watch drops, and its stream stops
  // asking for a session the daemon answers 404 for.
  useEffect(() => {
    const polled = polledIdsRef.current
    for (const session of sessions) polled.add(session.id)
    setChats((current) => {
      const next = { ...current }
      for (const session of sessions) {
        const existing = next[session.id]
        if (!existing) continue
        next[session.id] = mergeSessionIntoChat(existing, session)
      }
      for (const id of vanishedChatIds(next, sessions, polled)) delete next[id]
      return next
    })
  }, [sessions])

  chatsRef.current = chats

  // Watch exactly these chats. Order is irrelevant; the same set is a no-op.
  const watchChats = useCallback((ids) => {
    setWatched((current) => {
      const next = [...new Set(ids)].sort()
      return current.length === next.length && current.every((id, i) => id === next[i])
        ? current
        : next
    })
  }, [])

  // One stream per watched chat: load its decisions, replay what it hasn't
  // folded yet, then follow it live, reconnecting from its cursor.
  const openStream = useCallback(
    (id) => {
      const stream = { cancelled: false, stop: null, retry: null, cursor: null }
      const apply = (event) => {
        stream.cursor = event.seq
        setChats((current) => {
          const chat = current[id]
          if (!chat) return current
          return { ...current, [id]: foldEvent({ ...chat, timeline: [...chat.timeline] }, event) }
        })
      }
      const follow = (after) => {
        stream.stop = api.events(id, {
          after,
          onEvent: apply,
          onClose: (_cursor, err) => {
            if (stream.cancelled) return
            // A deleted session is terminal (the daemon answered "no
            // such session"): without this check the pane kept dialing
            // the dead id every 800ms forever. The pane lets go of the
            // chat on its own once the polled session list drops it.
            if (sessionGone(err)) return
            // The daemon replays anything missed from the cursor.
            stream.retry = setTimeout(() => {
              if (!stream.cancelled) follow(stream.cursor ?? chatsRef.current[id]?.foldedSeq ?? null)
            }, 800)
          },
        })
      }
      ;(async () => {
        try {
          const list = await api.decisions(id)
          if (stream.cancelled) return
          setChats((current) => {
            const chat = current[id]
            if (!chat) return current
            return { ...current, [id]: { ...chat, decisionsList: list ?? [] } }
          })
        } catch {
          /* decisions load is best-effort; the stream carries them anyway */
        }
      })()
      // A chat shown again after a while already holds its timeline;
      // `after: null` would fold the whole history in a second time.
      follow(chatsRef.current[id]?.foldedSeq ?? null)
      stream.close = () => {
        stream.cancelled = true
        clearTimeout(stream.retry)
        stream.stop?.()
      }
      return stream
    },
    [api],
  )

  // A new connection (or none) drops every stream; the next effect reopens
  // the watched set on it.
  useEffect(() => {
    const streams = streamsRef.current
    return () => {
      for (const stream of streams.values()) stream.close()
      streams.clear()
    }
  }, [connection.state, openStream])

  useEffect(() => {
    if (connection.state !== 'connected') return
    const streams = streamsRef.current
    const want = new Set(watched)
    for (const [id, stream] of streams) {
      if (!want.has(id)) {
        stream.close()
        streams.delete(id)
      }
    }
    for (const id of want) if (!streams.has(id)) streams.set(id, openStream(id))
  }, [watched, connection.state, openStream])

  const ensureChat = useCallback(
    (session) => {
      // Merge into the map - the record never replaces it. Idempotent, so
      // the shell can ensure the chat for a hash-reached view too.
      setChats((current) =>
        current[session.id]
          ? current
          : { ...current, [session.id]: chatFromSession(session) },
      )
    },
    [],
  )

  // A new chat. In Cloud it syncs to every device, and with `deviceId` it
  // runs on that machine (created there, copied here); the prompt that
  // follows reaches it through this daemon either way.
  const createChat = useCallback(
    async (
      text, workspace, harness, model, fast, effort, permissionMode,
      { deviceId = null, synced = false } = {},
    ) => {
      const session = await api.createSession({
        harness, workspace, model, effort, fast, permissionMode, deviceId, synced,
      })
      ensureChat(session)
      if (text.trim()) await api.prompt(session.id, text.trim())
      return session.id
    },
    [api, ensureChat],
  )

  // The API of another of the user's devices, through this daemon.
  const apiFor = useCallback((deviceId) => api.device(deviceId), [api])

  // The model catalog for a harness, cached per connection and device.
  // Empty means the harness advertises nothing - the picker stays hidden.
  const modelsFor = useCallback(
    async (harnessId, deviceId = null) => {
      const key = `${deviceId ?? ''}:${harnessId}`
      // An empty answer is not cached: a machine that was still starting
      // up gets asked again.
      if (!api.ready || modelsByHarness[key]?.length) return modelsByHarness[key] ?? []
      try {
        const list = (await api.device(deviceId).models(harnessId)) ?? []
        if (list.length) setModelsByHarness((current) => ({ ...current, [key]: list }))
        return list
      } catch {
        return []
      }
    },
    [api, modelsByHarness],
  )

  // What another device can run, fetched when a new chat aims at it.
  const capabilitiesFor = useCallback(
    async (deviceId) => {
      if (!deviceId) return capabilities
      try {
        const caps = await api.device(deviceId).capabilities()
        setCapabilitiesByDevice((current) => ({ ...current, [deviceId]: caps }))
        return caps
      } catch {
        return capabilitiesByDevice[deviceId] ?? null
      }
    },
    [api, capabilities, capabilitiesByDevice],
  )

  const refreshCloud = useCallback(async () => {
    const [view, list] = await Promise.allSettled([api.cloud(), api.cloudDevices()])
    if (view.status === 'fulfilled') setCloud(view.value)
    if (list.status === 'fulfilled') setDevices(list.value?.devices ?? [])
  }, [api])

  // Sign-in happens in the system browser, which the daemon opens; the
  // poll picks up the result when the browser comes back. On a phone the
  // shell opens it instead, in a browser tab that returns to the app.
  const signInCloud = useCallback(async () => {
    const started = await api.cloudSignIn({ open: !isMobile })
    if (isMobile && started?.authorize_url) {
      await openExternal(started.authorize_url, { signIn: true })
      started.opened = true
    }
    await refreshCloud()
    return started
  }, [api, refreshCloud])

  const cancelCloudSignIn = useCallback(async () => {
    setCloud(await api.cloudSignInCancel())
  }, [api])

  const signOutCloud = useCallback(async () => {
    setCloud(await api.cloudSignOut())
    setDevices([])
  }, [api])

  const setDeviceKind = useCallback(
    async (id, kind) => {
      await api.setDeviceKind(id, kind)
      // A change made from here isn't news here (the notices skip it).
      if (id === cloud?.device?.id) {
        try {
          localStorage.setItem(`openremote-kind-set-here:${id}`, JSON.stringify(kind))
        } catch {
          /* storage unavailable */
        }
      }
      await refreshCloud()
    },
    [api, refreshCloud, cloud],
  )

  const removeDevice = useCallback(
    async (id) => {
      await api.removeDevice(id)
      await refreshCloud()
    },
    [api, refreshCloud],
  )

  const createEnrollment = useCallback(() => api.createEnrollment(), [api])

  // The shell keeps the app in the tray by default when this computer is a
  // machine, so it hears when that changes.
  const thisKind = devices.find((d) => d.id === cloud?.device?.id)?.kind ?? null
  useEffect(() => {
    if (!hasTauri || isMobile || thisKind == null) return
    ;(async () => {
      try {
        const { invoke } = await import('@tauri-apps/api/core')
        await invoke('set_tray_prefs', { machine: thisKind === 'machine' })
      } catch {
        /* an older shell without a tray */
      }
    })()
  }, [thisKind])

  // A private chat joins Cloud: every device copies it, transcript and
  // tool output included; it keeps running here.
  const syncChat = useCallback(
    async (id) => {
      const session = await api.syncSession(id)
      setSessions((current) => current.map((s) => (s.id === id ? { ...s, ...session } : s)))
      setChats((current) =>
        current[id] ? { ...current, [id]: { ...current[id], executor: session.executor ?? null } } : current,
      )
    },
    [api],
  )

  // Archiving is console-side: the chat leaves the sidebar, its transcript
  // and its other devices are untouched.
  const setChatArchived = useCallback((id, value) => {
    setArchived((current) => {
      const next = withArchived(current, id, value)
      saveArchived(next)
      return next
    })
  }, [])

  // Deleting a synced chat removes it from every device.
  const deleteChat = useCallback(
    async (id) => {
      await api.deleteSession(id)
      setChatArchived(id, false)
      setSessions((current) => current.filter((s) => s.id !== id))
      setChats((current) => {
        const next = { ...current }
        delete next[id]
        return next
      })
    },
    [api, setChatArchived],
  )

  const sendPrompt = useCallback(
    async (chatId, text) => {
      await api.prompt(chatId, text.trim())
    },
    [api],
  )

  // Model, effort, or fast on a live chat. The session.updated event folds
  // the new facts; this returns the session so the composer can show a
  // harness that refused.
  const updateChatSettings = useCallback(
    async (chatId, settings) => api.updateSettings(chatId, settings),
    [api],
  )

  const answerDecision = useCallback(
    async (decisionId, choice) => {
      await api.answer(decisionId, choice)
    },
    [api],
  )

  const stopChat = useCallback(
    async (chatId) => {
      await api.stop(chatId)
    },
    [api],
  )

  // Interrupt the running turn - the agent stops what it's doing but the
  // session stays alive (stop kills the process; interrupt cancels the turn).
  const interruptChat = useCallback(
    async (chatId) => {
      await api.interrupt(chatId)
    },
    [api],
  )

  // The chat's queue (the daemon keeps it; queue.changed folds it here):
  // a message sent while a turn is working waits and runs when the turn
  // ends. Steer puts one into the running turn now.
  const queueMessage = useCallback(async (chatId, text) => api.queue(chatId, text.trim()), [api])
  const removeQueued = useCallback(async (chatId, itemId) => api.queueRemove(chatId, itemId), [api])
  const steerQueued = useCallback(async (chatId, itemId) => api.queueSteer(chatId, itemId), [api])
  const steerMessage = useCallback(async (chatId, text) => api.steer(chatId, text.trim()), [api])
  const resumeQueue = useCallback(async (chatId) => api.queueResume(chatId), [api])

  // ---- machines ----

  const refreshMachines = useCallback(async () => {
    try {
      setMachines((await api.machines()) ?? [])
    } catch {
      /* the poll heals */
    }
  }, [api])

  const createMachine = useCallback(
    async (name, platform) => {
      const machine = await api.createMachine({ name, platform })
      await refreshMachines()
      return machine
    },
    [api, refreshMachines],
  )

  const removeMachine = useCallback(
    async (machineId) => {
      await api.removeMachine(machineId)
      await refreshMachines()
    },
    [api, refreshMachines],
  )

  // The long one - an installer runs minutes. The receipt contract carries the
  // wait; a resolved promise means the harness landed on the machine.
  // Capabilities are re-read too: the picker, the settings list, and the
  // harness manager all read availability from there, not from machines.
  const installHarness = useCallback(
    async (machineId, harnessId, options) => {
      await api.installHarness(machineId, harnessId, options)
      await refreshMachines()
      await refreshCapabilities()
    },
    [api, refreshMachines, refreshCapabilities],
  )

  // ---- harness sign-in ----

  // The relay: the harness's own login command runs on the machine, the
  // CLI's words stream into the view, the human's answers ride back.
  // `onBeat` receives each view while the login runs; the promise settles
  // when the CLI exits (or the relay is cancelled, or its poll gives up -
  // see below), and the capabilities are re-read so the row carries the
  // harness's own fresh status words.
  // A harness's own sign-in, relayed - on this computer, or on one of the
  // account's machines (`deviceId`), where its CLI runs.
  // Returns { promise, cancel }: `cancel` stops the poll (the modal's
  // cleanup) without touching the daemon's run - the human may still be
  // finishing in the browser. The poll also gives up on its own: a relay
  // whose view cannot be read SIGNIN_POLL_MISSES times in a row (about
  // 30 s - a daemon that restarted, a relay that never survived)
  // settles with the last error instead of being read every 800ms for
  // the app's lifetime.
  const signIn = useCallback(
    (harnessId, { onBeat, deviceId = null } = {}) => {
      const target = api.device(deviceId)
      let cancelled = false
      let stopPoll = null
      const cancelledError = () => {
        const err = new Error('Sign-in was cancelled')
        err.cancelled = true
        return err
      }
      const promise = (async () => {
        let start
        try {
          start = await target.startSignIn(harnessId)
        } catch (err) {
          // A relay already running is one the human abandoned (or a modal
          // reopened): stop the stale attempt, then start fresh - the new
          // CLI's own login server is the one that must answer the browser.
          if (err?.status !== 409) throw err
          await target.stopSignIn(harnessId)
          await new Promise((r) => setTimeout(r, 400))
          if (cancelled) throw cancelledError()
          start = await target.startSignIn(harnessId)
        }
        if (cancelled) throw cancelledError()
        const first = start?.result ?? start
        onBeat?.(first)
        if (first?.done) {
          await refreshCapabilities()
          return first
        }
        return await new Promise((resolve, reject) => {
          let misses = 0
          let lastError = null
          const poll = setInterval(async () => {
            let view = null
            try {
              view = await target.signInView(harnessId)
            } catch (err) {
              // A single dropped read heals; only a relay whose view
              // cannot be read at all, over and over, is a failure.
              misses += 1
              lastError = err
              if (misses >= SIGNIN_POLL_MISSES) {
                clearInterval(poll)
                reject(
                  lastError ??
                    new Error('The sign-in stopped answering - try again.'),
                )
              }
              return
            }
            misses = 0
            onBeat?.(view)
            if (view?.done) {
              clearInterval(poll)
              await refreshCapabilities()
              resolve(view)
            }
          }, 800)
          const stop = () => {
            clearInterval(poll)
            reject(cancelledError())
          }
          // A cancel that arrived before the poll existed (the modal
          // unmounted while startSignIn was still in flight).
          if (cancelled) stop()
          else stopPoll = stop
        })
      })()
      return {
        promise,
        cancel: () => {
          cancelled = true
          stopPoll?.()
        },
      }
    },
    [api, refreshCapabilities],
  )

  const feedSignIn = useCallback(
    async (harnessId, text, deviceId = null) => {
      await api.device(deviceId).signInInput(harnessId, text)
    },
    [api],
  )

  const stopSignIn = useCallback(
    async (harnessId, deviceId = null) => {
      await api.device(deviceId).stopSignIn(harnessId)
    },
    [api],
  )

  // ---- plugins ----

  // The installed list and Discover's view of it (installed, update) move
  // together.
  const refreshPlugins = useCallback(async () => {
    try {
      const [pluginList, catalogList] = await Promise.all([api.plugins(), api.marketplaceCatalog()])
      setPlugins(pluginList)
      setCatalog(catalogList)
    } catch {
      /* the next action refreshes again */
    }
  }, [api])

  const refreshMarketplaces = useCallback(async () => {
    try {
      const [marketList, catalogList] = await Promise.all([api.marketplaces(), api.marketplaceCatalog()])
      setMarketplaces(marketList ?? [])
      setCatalog(catalogList)
    } catch {
      /* the next action refreshes again */
    }
  }, [api])

  const addMarketplace = useCallback(
    async (source) => {
      const reply = await api.addMarketplace(source)
      await refreshMarketplaces()
      return reply
    },
    [api, refreshMarketplaces],
  )

  // A failed fetch is not thrown: the record carries its error, and the
  // cached catalog keeps serving Discover.
  const refreshMarketplace = useCallback(
    async (name) => {
      const reply = await api.refreshMarketplace(name)
      await refreshMarketplaces()
      return reply
    },
    [api, refreshMarketplaces],
  )

  const setMarketplaceEnabled = useCallback(
    async (name, enabled) => {
      await api.setMarketplaceEnabled(name, enabled)
      await refreshMarketplaces()
    },
    [api, refreshMarketplaces],
  )

  const removeMarketplace = useCallback(
    async (name) => {
      await api.removeMarketplace(name)
      await refreshMarketplaces()
    },
    [api, refreshMarketplaces],
  )

  const stagePlugin = useCallback(async (source) => api.stagePlugin(source), [api])
  const cancelStagedPlugin = useCallback(async (stageId) => api.cancelStagedPlugin(stageId), [api])

  const installStagedPlugin = useCallback(
    async (stageId) => {
      const reply = await api.installStagedPlugin(stageId)
      await refreshPlugins()
      return reply
    },
    [api, refreshPlugins],
  )

  // A built-in harness turned off leaves every picker - the pickers read
  // capabilities, so those refresh too.
  const setPluginEnabled = useCallback(
    async (id, enabled) => {
      await api.setPluginEnabled(id, enabled)
      await Promise.all([refreshPlugins(), refreshCapabilities()])
    },
    [api, refreshPlugins, refreshCapabilities],
  )

  const removePlugin = useCallback(
    async (id) => {
      await api.removePlugin(id)
      await refreshPlugins()
    },
    [api, refreshPlugins],
  )

  // ---- MCP servers ----

  const refreshMcpServers = useCallback(async () => {
    try {
      setMcpServers((await api.mcpServers()) ?? [])
    } catch {
      /* the poll heals */
    }
  }, [api])

  const addMcpServer = useCallback(
    async (machineId, entry) => {
      const added = await api.addMcpServer(machineId, entry)
      await refreshMcpServers()
      return added
    },
    [api, refreshMcpServers],
  )

  const removeMcpServer = useCallback(
    async (id) => {
      await api.removeMcpServer(id)
      await refreshMcpServers()
    },
    [api, refreshMcpServers],
  )

  const setMcpServerEnabled = useCallback(
    async (id, enabled) => {
      await api.setMcpServerEnabled(id, enabled)
      await refreshMcpServers()
    },
    [api, refreshMcpServers],
  )

  const acknowledgeMcpServerKey = useCallback(
    async (id) => {
      await api.acknowledgeMcpServerKey(id)
      await refreshMcpServers()
    },
    [api, refreshMcpServers],
  )

  // ---- automations ----

  const refreshAutomations = useCallback(async () => {
    try {
      setAutomations((await api.automations()) ?? [])
    } catch {
      /* the poll heals */
    }
  }, [api])

  const saveAutomation = useCallback(
    async (rule) => {
      const saved = await api.saveRule(rule)
      await refreshAutomations()
      return saved
    },
    [api, refreshAutomations],
  )

  const removeAutomation = useCallback(
    async (ruleId) => {
      await api.removeRule(ruleId)
      await refreshAutomations()
    },
    [api, refreshAutomations],
  )

  const enableAutomation = useCallback(
    async (ruleId, enabled) => {
      await api.setRuleEnabled(ruleId, enabled)
      await refreshAutomations()
    },
    [api, refreshAutomations],
  )

  // Run now - resolves with the chat the rule opened (the jump target).
  const runAutomation = useCallback(
    async (ruleId) => {
      const session = await api.runRule(ruleId)
      await refreshAutomations()
      return session
    },
    [api, refreshAutomations],
  )

  // ---- projects ----

  const refreshProjects = useCallback(async () => {
    try {
      setProjects((await api.projects()) ?? [])
    } catch {
      /* the poll heals */
    }
  }, [api])

  // Add a project - one folder this release, registered on the machine
  // that owns it (`apiFor(deviceId)` aims there in Cloud).
  const addProject = useCallback(
    async (folders, { deviceId = null } = {}) => {
      const project = await api.device(deviceId).createProject({ folders })
      await refreshProjects()
      return project
    },
    [api, refreshProjects],
  )

  // Unregister a project - its chats stay, they just stop being grouped.
  const removeProject = useCallback(
    async (projectId) => {
      await api.removeProject(projectId)
      await refreshProjects()
    },
    [api, refreshProjects],
  )

  const resumeChat = useCallback(
    async (chatId) => {
      await api.resume(chatId)
    },
    [api],
  )

  const value = useMemo(
    () => ({
      api,
      connection,
      capabilities,
      sessions,
      machines,
      mcpServers,
      plugins,
      stagePlugin,
      installStagedPlugin,
      cancelStagedPlugin,
      setPluginEnabled,
      removePlugin,
      marketplaces,
      catalog,
      addMarketplace,
      refreshMarketplace,
      setMarketplaceEnabled,
      removeMarketplace,
      automations,
      projects,
      chats,
      watchChats,
      connect,
      disconnect,
      ensureChat,
      createChat,
      modelsFor,
      cloud,
      devices,
      thisDevice: cloud?.device?.id ?? null,
      apiFor,
      capabilitiesFor,
      refreshCloud,
      signInCloud,
      cancelCloudSignIn,
      signOutCloud,
      setDeviceKind,
      removeDevice,
      createEnrollment,
      deleteChat,
      archived,
      setChatArchived,
      syncChat,
      sendPrompt,
      updateChatSettings,
      answerDecision,
      stopChat,
      interruptChat,
      queueMessage,
      removeQueued,
      steerQueued,
      steerMessage,
      resumeQueue,
      resumeChat,
      createMachine,
      removeMachine,
      installHarness,
      signIn,
      feedSignIn,
      stopSignIn,
      addMcpServer,
      removeMcpServer,
      setMcpServerEnabled,
      acknowledgeMcpServerKey,
      saveAutomation,
      removeAutomation,
      enableAutomation,
      runAutomation,
      addProject,
      removeProject,
    }),
    [
      api,
      connection,
      capabilities,
      sessions,
      machines,
      mcpServers,
      plugins,
      stagePlugin,
      installStagedPlugin,
      cancelStagedPlugin,
      setPluginEnabled,
      removePlugin,
      marketplaces,
      catalog,
      addMarketplace,
      refreshMarketplace,
      setMarketplaceEnabled,
      removeMarketplace,
      automations,
      projects,
      chats,
      watchChats,
      connect,
      disconnect,
      ensureChat,
      createChat,
      modelsFor,
      cloud,
      devices,
      apiFor,
      capabilitiesFor,
      refreshCloud,
      signInCloud,
      cancelCloudSignIn,
      signOutCloud,
      setDeviceKind,
      removeDevice,
      createEnrollment,
      deleteChat,
      archived,
      setChatArchived,
      syncChat,
      sendPrompt,
      updateChatSettings,
      answerDecision,
      stopChat,
      interruptChat,
      queueMessage,
      removeQueued,
      steerQueued,
      steerMessage,
      resumeQueue,
      resumeChat,
      createMachine,
      removeMachine,
      installHarness,
      signIn,
      feedSignIn,
      stopSignIn,
      addMcpServer,
      removeMcpServer,
      setMcpServerEnabled,
      acknowledgeMcpServerKey,
      saveAutomation,
      removeAutomation,
      enableAutomation,
      runAutomation,
      addProject,
      removeProject,
    ],
  )
  return <ConsoleContext.Provider value={value}>{children}</ConsoleContext.Provider>
}

export function useConsole() {
  const context = useContext(ConsoleContext)
  if (!context) throw new Error('useConsole outside its provider')
  return context
}
