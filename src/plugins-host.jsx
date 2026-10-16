// The JavaScript plugin runtime, the console's half. Each installed
// plugin's openremote.json is read once; an enabled JS plugin's pages run
// in frames this module makes - a hidden one for a plugin that puts
// buttons in the composer, one for each open view - and every call a frame
// makes is answered here, checked first against the powers the user
// approved when the plugin was installed (plugin-runtime.js holds those
// rules; docs/plugins/js-api.md is the plugin author's side).
//
// A frame is sandboxed to scripts alone, so it can read nothing of the
// console and reaches it only by postMessage. A message counts only from
// a frame this module made - its own window, with the opaque origin every
// such frame has - and anything else is ignored.

import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { X } from '@phosphor-icons/react'
import { useConsole } from './state/console.jsx'
import { addAttachment } from './attachments.js'
import { loadDefaults } from './defaults.js'
import { pickable } from './harness-manager.js'
import {
  chatSummaries,
  displayName,
  frameDocument,
  fromBase64,
  insidePath,
  parseViewKey,
  readContributions,
  refusal,
  steerAction,
  toBase64,
  viewKey,
} from './plugin-runtime.js'
import './plugin-ui.css'

const PluginContext = createContext(null)

// The app's colors and type, handed to every frame as CSS variables of
// the same names, so a plugin's page can wear the app's look.
const THEME_TOKENS = [
  '--bg-app',
  '--bg-side',
  '--bg-hover',
  '--bg-active',
  '--line',
  '--text-1',
  '--text-2',
  '--text-3',
  '--accent',
  '--green',
  '--dot-idle',
  '--radius',
  '--font-sans',
]

// Runtimes whose plugins carry an openremote.json the console reads (a
// Claude plugin has none). Only a JS plugin runs in the console.
const MANIFEST_RUNTIMES = new Set(['js', 'process', 'wasm'])

const TOAST_MS = 6000
const MAX_TOASTS = 3
const MAX_INSERT = 100_000
const MAX_ATTACH_BYTES = 10 * 1024 * 1024
const INPUT_STATES = new Set(['idle', 'active', 'busy'])

const reduceMotionNow = () =>
  typeof document !== 'undefined' &&
  (document.documentElement.hasAttribute('data-reduce-motion') ||
    window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true)

function themeTokens() {
  const style = getComputedStyle(document.documentElement)
  return Object.fromEntries(THEME_TOKENS.map((name) => [name, style.getPropertyValue(name).trim()]).filter(([, v]) => v))
}

// The settings answer, whichever shape the daemon gives it (a receipt
// wraps its result).
const settingsView = (reply) => {
  const view = reply?.result ?? reply ?? {}
  return { values: view.values ?? {}, secrets: view.secrets ?? {} }
}

export function PluginProvider({ children }) {
  const {
    api,
    connection,
    plugins,
    sessions,
    chats,
    capabilities,
    createChat,
    sendPrompt,
    steerMessage,
    stopChat,
  } = useConsole()
  const [manifests, setManifests] = useState({})
  const [inputStates, setInputStates] = useState({})
  // Plugins whose hidden frame is up: those that ask to run from the
  // start, and each one whose composer button was clicked once.
  const [awake, setAwake] = useState(() => new Set())
  const [toasts, setToasts] = useState([])

  const framesRef = useRef(new Map())
  const composersRef = useRef(new Map())
  const grantsRef = useRef(new Map())
  const lastClickRef = useRef(new Map())
  const clicksRef = useRef([])
  const navRef = useRef({ openView: null, openSettings: null })
  const stampsRef = useRef(new Map())
  const toastSeq = useRef(0)

  // Every frame boots from the same small page (the policy and the
  // bridge); the bridge then asks for the plugin's own.
  const frameSrc = useMemo(
    () => URL.createObjectURL(new Blob([frameDocument(window.location.origin)], { type: 'text/html' })),
    [],
  )

  // ---- manifests ----

  const installed = plugins?.installed ?? null
  const installedRef = useRef(installed)
  installedRef.current = installed

  useEffect(() => {
    stampsRef.current.clear()
  }, [api])

  useEffect(() => {
    if (connection.state !== 'connected' || !installed) return
    for (const plugin of installed) {
      if (!MANIFEST_RUNTIMES.has(plugin.runtime)) continue
      const stamp = `${plugin.updated_at ?? ''}|${plugin.resolved ?? ''}`
      if (stampsRef.current.get(plugin.id) === stamp) continue
      stampsRef.current.set(plugin.id, stamp)
      api
        .pluginFile(plugin.id, 'openremote.json')
        .then(({ bytes }) => {
          const manifest = JSON.parse(new TextDecoder().decode(bytes))
          return { manifest, ui: readContributions(manifest), error: null }
        })
        .catch((err) => ({
          manifest: null,
          ui: readContributions(null),
          // No openremote.json is no contribution, not a fault.
          error: err?.status === 404 ? null : err?.message ?? String(err),
        }))
        .then((read) => {
          // An update or removal that came meanwhile wins.
          const now = installedRef.current?.find((p) => p.id === plugin.id)
          if (!now || `${now.updated_at ?? ''}|${now.resolved ?? ''}` !== stamp) return
          setManifests((current) => ({ ...current, [plugin.id]: { stamp, ...read } }))
        })
    }
    // A plugin removed takes its manifest with it.
    const ids = new Set(installed.map((p) => p.id))
    setManifests((current) => {
      const gone = Object.keys(current).filter((id) => !ids.has(id))
      if (!gone.length) return current
      const next = { ...current }
      for (const id of gone) {
        delete next[id]
        stampsRef.current.delete(id)
      }
      return next
    })
  }, [installed, connection.state, api])

  // Each installed plugin the console knows a manifest for: the record,
  // what it contributes, its name as people read it.
  const records = useMemo(() => {
    const out = new Map()
    for (const plugin of installed ?? []) {
      const read = manifests[plugin.id]
      if (!read) continue
      out.set(plugin.id, { plugin, ui: read.ui, error: read.error, name: displayName(read.manifest, plugin) })
    }
    return out
  }, [installed, manifests])

  // The ones that run here: enabled JavaScript plugins.
  const running = useMemo(
    () => [...records.values()].filter((r) => r.plugin.enabled && r.plugin.runtime === 'js'),
    [records],
  )

  const views = useMemo(
    () =>
      running.flatMap((r) =>
        r.ui.views.map((v) => ({
          key: viewKey(r.plugin.id, v.id),
          pluginId: r.plugin.id,
          viewId: v.id,
          title: v.title,
          icon: v.icon,
          pluginName: r.name,
        })),
      ),
    [running],
  )

  const inputs = useMemo(
    () => running.flatMap((r) => r.ui.inputs.map((input) => ({ pluginId: r.plugin.id, pluginName: r.name, input }))),
    [running],
  )

  // Settings belong to every installed plugin that declares them, on or
  // off: a plugin is set up before it is turned on as often as after.
  const settingsPlugins = useMemo(
    () => [...records.values()].filter((r) => r.ui.settings.length > 0),
    [records],
  )

  const backgroundIds = useMemo(() => {
    const ids = new Set(running.filter((r) => r.ui.background).map((r) => r.plugin.id))
    for (const id of awake) if (running.some((r) => r.plugin.id === id && r.ui.entry)) ids.add(id)
    return [...ids]
  }, [running, awake])

  // A plugin turned off or removed: its frames go (they unmount with
  // their records), and so do its composer grants and button states.
  useEffect(() => {
    const live = new Set(running.map((r) => r.plugin.id))
    for (const id of grantsRef.current.keys()) if (!live.has(id)) grantsRef.current.delete(id)
    for (const id of lastClickRef.current.keys()) if (!live.has(id)) lastClickRef.current.delete(id)
    setInputStates((current) => {
      const keys = Object.keys(current).filter((k) => !live.has(k.slice(0, k.lastIndexOf('/'))))
      if (!keys.length) return current
      const next = { ...current }
      for (const k of keys) delete next[k]
      return next
    })
    setAwake((current) => {
      const kept = [...current].filter((id) => live.has(id))
      return kept.length === current.size ? current : new Set(kept)
    })
  }, [running])

  // ---- toasts ----

  const toast = useCallback((pluginName, text) => {
    const id = ++toastSeq.current
    setToasts((current) => [...current, { id, pluginName, text }].slice(-MAX_TOASTS))
    setTimeout(() => setToasts((current) => current.filter((t) => t.id !== id)), TOAST_MS)
  }, [])

  // ---- frames ----

  const post = (frame, message, transfer) => {
    try {
      frame.win.postMessage({ openremote: 1, ...message }, '*', transfer ?? [])
    } catch {
      /* the frame went away mid-answer */
    }
  }

  const postEvent = (frame, type, detail) => {
    if (!frame.booted) frame.queue.push({ type, detail })
    else post(frame, { kind: 'event', type, detail })
  }

  // Clicks wait for their plugin's hidden frame: it comes up on the
  // first click and hears every click from then on.
  const deliverClicks = () => {
    const waiting = []
    for (const click of clicksRef.current) {
      const frame = [...framesRef.current.values()].find(
        (f) => f.pluginId === click.pluginId && f.place.kind === 'background',
      )
      if (frame) postEvent(frame, 'composer.click', click.detail)
      else waiting.push(click)
    }
    clicksRef.current = waiting
  }

  const registerFrame = useCallback((iframe, { pluginId, place }) => {
    const win = iframe.contentWindow
    if (!win) return undefined
    const frame = { win, pluginId, place, booted: false, queue: [] }
    framesRef.current.set(win, frame)
    if (place.kind === 'background') deliverClicks()
    return () => {
      if (framesRef.current.get(win) === frame) framesRef.current.delete(win)
    }
    // deliverClicks reads refs only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // The newest console state, for answers that arrive after a render.
  const live = useRef({})
  live.current = { api, records, sessions, chats, capabilities, createChat, sendPrompt, steerMessage, stopChat, toast }

  // The calls a frame may make. Each takes the frame's record and the
  // call's params, and answers [result, transfer?]. refusal() has already
  // checked the power.
  const calls = {
    'settings.get': async ({ plugin }) => [settingsView(await live.current.api.pluginSettings(plugin.id))],

    'files.read': async ({ plugin }, { path }) => {
      if (!insidePath(path)) throw new Error(`${path} is not a path inside the plugin's folder`)
      const file = await live.current.api.pluginFile(plugin.id, path)
      return [file, [file.bytes]]
    },

    'ui.toast': async (record, { text }) => {
      const words = String(text ?? '').trim()
      if (words) live.current.toast(record.name, words.slice(0, 280))
      return [null]
    },

    'ui.openView': async ({ plugin, ui }, { view }) => {
      const target = view ? ui.views.find((v) => v.id === view) : ui.views[0]
      if (!target) throw new Error(view ? `There is no view named ${view}.` : 'This plugin has no view.')
      navRef.current.openView?.(viewKey(plugin.id, target.id))
      return [null]
    },

    'ui.openSettings': async ({ plugin, ui }) => {
      if (!ui.settings.length) throw new Error('This plugin has no settings.')
      navRef.current.openSettings?.(plugin.id)
      return [null]
    },

    'composer.setState': async ({ plugin, ui }, { input, state, label, title, composer }) => {
      if (!ui.inputs.some((i) => i.id === input)) throw new Error(`There is no composer button named ${input}.`)
      const granted = grantsRef.current.get(plugin.id)
      const scoped = Boolean(composer && granted?.has(composer))
      const next = {
        state: INPUT_STATES.has(state) ? state : 'idle',
        label: typeof label === 'string' && label.trim() ? label.trim().slice(0, 40) : null,
        title: typeof title === 'string' && title.trim() ? title.trim().slice(0, 120) : null,
        // One composer's button only, when the plugin names one it was
        // handed by a click (and that chat's composer, should it open
        // again); every composer's otherwise.
        composer: scoped ? composer : null,
        composerKey: scoped ? granted.get(composer) ?? null : null,
      }
      setInputStates((current) => ({ ...current, [`${plugin.id}/${input}`]: next }))
      return [null]
    },

    'composer.insert': async ({ plugin }, { text, composer }) => {
      const target = composerFor(plugin.id, composer)
      target.insert(String(text ?? '').slice(0, MAX_INSERT))
      return [null]
    },

    'composer.attach': async ({ plugin }, { name, mime, bytes, composer }) => {
      const target = composerFor(plugin.id, composer)
      if (!/^image\/(png|jpeg|gif|webp)$/i.test(mime ?? '')) {
        throw new Error('Only pictures (PNG, JPEG, GIF, WebP) can be attached for now.')
      }
      if (!(bytes instanceof ArrayBuffer) || bytes.byteLength > MAX_ATTACH_BYTES) {
        throw new Error('A picture can be up to 10 MB.')
      }
      addAttachment(
        { kind: 'image', name: String(name ?? 'picture').slice(0, 120), mime, dataUrl: `data:${mime};base64,${toBase64(bytes)}` },
        target.attachKey,
      )
      return [null]
    },

    'chats.list': async () => [chatSummaries(live.current.sessions, live.current.chats)],

    'chats.read': async ({ plugin }, { id }) => [await live.current.api.pluginChat(plugin.id, String(id ?? ''))],

    'chats.start': async (record, { text, harness, workspace, model }) => {
      const message = String(text ?? '').trim()
      if (!message) throw new Error('A new chat needs its first message.')
      const offered = (live.current.capabilities?.harnesses ?? []).filter(pickable)
      const chosen = harness ?? loadDefaults().harness ?? offered[0]?.id ?? null
      if (!chosen || !offered.some((h) => h.id === chosen)) {
        throw new Error(chosen ? `${chosen} is not installed and on here.` : 'No harness is installed here.')
      }
      const id = await live.current.createChat(message, workspace ?? null, chosen, model ?? undefined)
      live.current.toast(record.name, 'Started a chat.')
      return [{ id }]
    },

    'chats.steer': async (record, { id, text }) => {
      const session = (live.current.sessions ?? []).find((s) => s.id === id)
      if (!session) throw new Error('There is no such chat here.')
      const message = String(text ?? '').trim()
      if (!message) throw new Error('A message needs some text.')
      const action = steerAction(session.status)
      if (!action) throw new Error('That chat has stopped. Resume it first.')
      if (action === 'steer') await live.current.steerMessage(id, message)
      else await live.current.sendPrompt(id, message)
      return [null]
    },

    'chats.stop': async (record, { id }) => {
      if (!(live.current.sessions ?? []).some((s) => s.id === id)) throw new Error('There is no such chat here.')
      await live.current.stopChat(id)
      return [null]
    },

    fetch: async ({ plugin }, { url, method, headers, body, timeoutMs }) => {
      const reply = await live.current.api.pluginFetch(plugin.id, {
        url: String(url ?? ''),
        method: method ?? 'GET',
        headers: Array.isArray(headers) ? headers.filter((h) => Array.isArray(h) && h.length === 2).map(([n, v]) => [String(n), String(v)]) : [],
        body: body instanceof ArrayBuffer && body.byteLength ? toBase64(body) : null,
        ...(Number.isFinite(timeoutMs) ? { timeout_ms: timeoutMs } : {}),
      })
      const bytes = fromBase64(reply?.body ?? '')
      const answer = bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength ? bytes.buffer : bytes.slice().buffer
      return [{ status: reply?.status ?? 502, headers: reply?.headers ?? [], body: answer }, [answer]]
    },
  }

  // The composer a plugin writes in: the one it names (a handle a click
  // gave it), else the one whose button the user clicked last. A plugin
  // never writes in a composer the user didn't point it at - though when
  // the user left that chat and came back, its composer is a new one, and
  // the words still belong there.
  function composerFor(pluginId, handle) {
    const granted = grantsRef.current.get(pluginId)
    const chosen = handle ?? lastClickRef.current.get(pluginId) ?? null
    if (!chosen || !granted?.has(chosen)) {
      throw new Error('A plugin writes in a composer only after the user clicks its button there.')
    }
    const target = composersRef.current.get(chosen)
    if (target) return target
    const key = granted.get(chosen)
    const again = key == null ? null : [...composersRef.current.values()].find((c) => c.attachKey === key)
    if (again) return again
    throw new Error('That composer has closed.')
  }

  const boot = (frame) => {
    const record = live.current.records.get(frame.pluginId)
    if (!record || !record.plugin.enabled) return
    const entry = frame.place.kind === 'view' ? record.ui.views.find((v) => v.id === frame.place.view)?.entry : record.ui.entry
    post(frame, {
      kind: 'boot',
      plugin: {
        id: record.plugin.id,
        name: record.name,
        version: record.plugin.version ?? null,
        powers: record.plugin.powers ?? [],
      },
      place: frame.place,
      entry: entry ? { path: entry } : null,
      error: entry ? null : `${record.name} names no page for this place.`,
      theme: themeTokens(),
      reduceMotion: reduceMotionNow(),
    })
  }

  // The one listener for every frame's messages.
  const onMessageRef = useRef(null)
  onMessageRef.current = async (event) => {
    const frame = framesRef.current.get(event.source)
    // Only a frame this module made, and only while it is sandboxed: its
    // origin is opaque ("null"), whatever page it shows.
    if (!frame || event.origin !== 'null') return
    const message = event.data
    if (!message || message.openremote !== 1) return
    const record = live.current.records.get(frame.pluginId)
    if (message.kind === 'ready') {
      if (!frame.booted) boot(frame)
      return
    }
    if (message.kind === 'booted') {
      frame.booted = true
      const queued = frame.queue.splice(0)
      for (const item of queued) post(frame, { kind: 'event', type: item.type, detail: item.detail })
      return
    }
    if (message.kind === 'log') {
      console.warn(`[plugin ${record?.name ?? frame.pluginId}] ${String(message.text ?? '')}`)
      return
    }
    if (message.kind === 'key') {
      window.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: String(message.key ?? ''),
          code: String(message.code ?? ''),
          ctrlKey: Boolean(message.ctrlKey),
          metaKey: Boolean(message.metaKey),
          altKey: Boolean(message.altKey),
          shiftKey: Boolean(message.shiftKey),
          repeat: Boolean(message.repeat),
          bubbles: true,
          cancelable: true,
        }),
      )
      return
    }
    if (message.kind !== 'call' || typeof message.id !== 'number') return
    const reply = (payload, transfer) => post(frame, { kind: 'reply', id: message.id, ...payload }, transfer)
    if (!record || !record.plugin.enabled) {
      reply({ error: 'This plugin is turned off.' })
      return
    }
    const method = String(message.method ?? '')
    const refused = refusal(method, {
      name: record.name,
      powers: record.plugin.powers ?? [],
      inputs: record.ui.inputs,
    })
    if (refused) {
      reply({ error: refused })
      return
    }
    try {
      const [result, transfer] = await calls[method](record, message.params ?? {})
      reply({ result: result ?? null }, transfer)
    } catch (err) {
      reply({ error: err?.message ?? String(err) })
    }
  }

  useEffect(() => {
    const onMessage = (event) => onMessageRef.current?.(event)
    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
  }, [])

  // The app's reduce-motion switch reaches every frame as it changes.
  useEffect(() => {
    const observer = new MutationObserver(() => {
      const reduce = reduceMotionNow()
      for (const frame of framesRef.current.values()) postEvent(frame, 'motion', { reduce })
    })
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-reduce-motion'] })
    return () => observer.disconnect()
    // postEvent reads refs only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // ---- what the composers, the sidebar, the panes and Settings use ----

  const registerComposer = useCallback((handle, entry) => {
    composersRef.current.set(handle, entry)
    return () => {
      if (composersRef.current.get(handle) === entry) composersRef.current.delete(handle)
    }
  }, [])

  const clickInput = useCallback((pluginId, inputId, handle) => {
    // The composer's handle, and which composer it is (a chat's id, or
    // the home screen's).
    const granted = grantsRef.current.get(pluginId) ?? new Map()
    granted.set(handle, composersRef.current.get(handle)?.attachKey ?? null)
    grantsRef.current.set(pluginId, granted)
    lastClickRef.current.set(pluginId, handle)
    clicksRef.current.push({ pluginId, detail: { input: inputId, composer: handle } })
    setAwake((current) => (current.has(pluginId) ? current : new Set([...current, pluginId])))
    deliverClicks()
    // deliverClicks reads refs only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // A button's state in one composer: the plugin's, when it set it for
  // every composer, for this one, or for this chat's composer before it
  // opened again; at rest otherwise.
  const inputState = useCallback(
    (pluginId, inputId, handle, composerKey) => {
      const state = inputStates[`${pluginId}/${inputId}`]
      const mine =
        state &&
        (!state.composer ||
          state.composer === handle ||
          (state.composerKey != null && state.composerKey === composerKey))
      return mine ? state : { state: 'idle', label: null, title: null }
    },
    [inputStates],
  )

  const setNavigation = useCallback((nav) => {
    navRef.current = nav
  }, [])

  const openSettings = useCallback((pluginId) => navRef.current.openSettings?.(pluginId), [])

  const viewInfo = useCallback(
    (key) => {
      const parsed = parseViewKey(key)
      if (!parsed) return null
      const record = records.get(parsed.pluginId)
      const view = record?.ui.views.find((v) => v.id === parsed.viewId) ?? null
      return { ...parsed, record: record ?? null, view, plugin: installed?.find((p) => p.id === parsed.pluginId) ?? null }
    },
    [records, installed],
  )

  // Settings saved from the form reach the plugin's frames too.
  const saveSettings = useCallback(
    async (pluginId, values) => {
      const view = settingsView(await api.savePluginSettings(pluginId, values))
      for (const frame of framesRef.current.values()) {
        if (frame.pluginId === pluginId) postEvent(frame, 'settings.changed', view)
      }
      return view
    },
    // postEvent reads refs only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [api],
  )

  const loadSettings = useCallback(async (pluginId) => settingsView(await api.pluginSettings(pluginId)), [api])

  const value = useMemo(
    () => ({
      frameSrc,
      records,
      views,
      inputs,
      settingsPlugins,
      registerFrame,
      registerComposer,
      clickInput,
      inputState,
      setNavigation,
      openSettings,
      viewInfo,
      loadSettings,
      saveSettings,
    }),
    [frameSrc, records, views, inputs, settingsPlugins, registerFrame, registerComposer, clickInput, inputState, setNavigation, openSettings, viewInfo, loadSettings, saveSettings],
  )

  return (
    <PluginContext.Provider value={value}>
      {children}
      {/* Hidden frames: the pages of plugins that add composer buttons,
          up from their first click (or from the start, when they ask). */}
      <div className="plg-hidden" aria-hidden="true">
        {backgroundIds.map((id) => {
          const record = records.get(id)
          return (
            <PluginFrame
              key={`${id}|${record?.plugin.updated_at ?? ''}`}
              pluginId={id}
              place={BACKGROUND}
              title={`${record?.name ?? id} (background)`}
            />
          )
        })}
      </div>
      {toasts.length > 0 && (
        <div className="plg-toasts" role="status" aria-live="polite">
          {toasts.map((t) => (
            <div className="plg-toast" key={t.id}>
              <span className="plg-toast-from">{t.pluginName}</span>
              <span className="plg-toast-text">{t.text}</span>
              <button
                type="button"
                className="plg-toast-close"
                title="Dismiss"
                aria-label="Dismiss"
                onClick={() => setToasts((current) => current.filter((x) => x.id !== t.id))}
              >
                <X size={12} weight="bold" />
              </button>
            </div>
          ))}
        </div>
      )}
    </PluginContext.Provider>
  )
}

const BACKGROUND = { kind: 'background', view: null }

export function usePlugins() {
  return useContext(PluginContext)
}

// One plugin page in a frame: sandboxed to scripts alone (never the same
// origin), the microphone allowed only for a plugin given it.
export function PluginFrame({ pluginId, place, title, className = 'plg-frame' }) {
  const host = useContext(PluginContext)
  const record = host?.records.get(pluginId)
  if (!host || !record) return null
  return (
    <FrameElement
      host={host}
      pluginId={pluginId}
      kind={place.kind}
      view={place.view ?? null}
      microphone={(record.plugin.powers ?? []).includes('microphone')}
      title={title}
      className={className}
    />
  )
}

// The frame itself, noted with the host before its page can speak: a
// layout effect runs before the browser gets a turn to load the frame.
function FrameElement({ host, pluginId, kind, view, microphone, title, className }) {
  const ref = useRef(null)
  const { registerFrame } = host
  useLayoutEffect(() => {
    if (!ref.current) return undefined
    return registerFrame(ref.current, { pluginId, place: { kind, view } })
  }, [registerFrame, pluginId, kind, view])
  return (
    <iframe
      ref={ref}
      className={className}
      title={title}
      src={host.frameSrc}
      sandbox="allow-scripts"
      allow={microphone ? 'microphone *' : undefined}
      referrerPolicy="no-referrer"
    />
  )
}
