import { useEffect, useRef, useState } from 'react'
import {
  ArrowUp,
  ArrowUpRight,
  Check,
  Lightning,
  Stop,
  Play,
  HandPalm,
  Brain,
  Trash,
  CloudArrowUp,
  Copy,
  DotsThree,
  PencilSimple,
  X,
  Globe,
  ImageSquare,
  CaretDown,
  CaretRight,
} from '@phosphor-icons/react'
import { useConsole } from './state/console.jsx'
import { chatAccess, deviceName, signedIn } from './cloud.js'
import { railItems } from './state/reducer.js'
import { harnessName } from './harness-names.js'
import { findModel, modelDisplayName } from './model-display.js'
import { modelMaker } from './model-maker.js'
import { ModelMark } from './model-marks.jsx'
import { HarnessMark } from './brand-marks.jsx'
import { editRows, isFileEdit, writeRows } from './diff.js'
import { isCommandRun } from './command-card.js'
import { renderMarkdown } from './markdown.js'
import { capLines, capRows, MAX_RENDER_LINES, MAX_RENDER_ROWS, shouldRenderLive } from './render-budget.js'
import ContextRing from './ContextRing.jsx'
import ContextMenu from './ContextMenu.jsx'
import PickerMenu from './PickerMenu.jsx'
import { useMoveChat } from './useMoveChat.jsx'
import { hasTauri, isMobile } from './platform.js'
import { usePrivacyMode } from './privacy.js'
import { useHint, useModelSwitches, usePaletteSource, useShortcut } from './keyboard.jsx'
import { useComposerMenus } from './useComposerMenus.jsx'
import { mentionedChats, ownCommands, takeCommands } from './composer-menus.js'
import { addAttachment, removeAttachment, setFocusedComposer } from './attachments.js'
import { AttachmentChips, useAttachInput, useAttachments } from './ComposerAttachments.jsx'
import { outgoing } from './composer-attachments.js'
import { ChatImages, chatImageDataUrl } from './chat-images.jsx'
import { findDevServers, noteDevServers } from './devservers.js'
import { isBrowsing, requestBrowser } from './browser-placement.js'
import { browserTool, foldsResult, isBrowserTool } from './browser-tools.js'
import PluginComposerButtons from './PluginComposerButtons.jsx'
import './chatview.css'
import './composer.css'

// The harnesses that run one process per prompt cannot take a message
// mid-turn: Steer interrupts the turn and runs the message next there.
const INTERRUPT_STEER = new Set(['grok', 'agy'])

// The harnesses that read pictures, for a chat whose harness this
// computer doesn't list (one running on another machine, any chat on a
// phone); the daemon's own `image_input` decides where it is known.
const IMAGE_HARNESSES = new Set(['claude', 'codex'])

// The browser opens beside a chat in the desktop app only: a phone has its
// own Browser view, and a plain browser tab has no browser to show.
const BESIDE = hasTauri && !isMobile

// Dev server addresses per text, kept while the text is the same: the
// rail renders on every streamed token, and a long tool output must not
// be searched again each time.
const devCache = new Map()
function devServersIn(text) {
  if (!text) return []
  let found = devCache.get(text)
  if (!found) {
    if (devCache.size > 400) devCache.clear()
    found = findDevServers(text)
    devCache.set(text, found)
  }
  return found
}

/// "Open beside chat" for each dev server a reply or a tool's output
/// mentions - this computer's own servers, so only on a chat that runs
/// here.
function DevServerChips({ text, chatId }) {
  const servers = devServersIn(text)
  if (!servers.length) return null
  return (
    <div className="cv-dev-row">
      {servers.slice(0, 3).map((server) => (
        <button
          key={server.url}
          type="button"
          className="cv-dev-chip"
          onClick={() => requestBrowser({ chatId, url: server.url })}
          title={`Open ${server.url} in the browser beside this chat`}
        >
          <Globe size={12} />
          <span className="cv-dev-host">
            {server.host === '0.0.0.0' ? 'localhost' : server.host}:{server.port}
          </span>
          Open beside chat
        </button>
      ))}
    </div>
  )
}

/// A tool's output row. A page read as text runs long, so it folds until
/// asked for.
function OutRow({ out, fold }) {
  const [open, setOpen] = useState(!fold)
  return (
    <>
      <div className="cv-io-row">
        <span className="cv-io-label">Out</span>
        {open ? (
          <code>{out.text}</code>
        ) : (
          <button type="button" className="cv-fold" onClick={() => setOpen(true)} aria-expanded={false}>
            <CaretRight size={11} />
            Show the page text
          </button>
        )}
      </div>
      {open && fold && (
        <button type="button" className="cv-fold cv-fold--under" onClick={() => setOpen(false)} aria-expanded>
          <CaretDown size={11} />
          Fold the page text
        </button>
      )}
      {open && out.hidden > 0 && (
        <div className="cv-io-more">Showing the first {MAX_RENDER_LINES} lines.</div>
      )}
    </>
  )
}

/// What a browser tool did, in words: the element as the agent named it,
/// the address, and the argument worth reading (typed text, a script).
function BrowserFacts({ facts }) {
  return (
    <>
      {(facts.description || facts.url) && (
        <p className="cv-bt pv">
          {facts.description && <span className="cv-bt-desc">{facts.description}</span>}
          {facts.url && <code className="cv-bt-url">{facts.url}</code>}
        </p>
      )}
      {facts.detail &&
        (facts.mono ? (
          <div className="cv-cmd pv">
            <code className="cv-cmd-text">{facts.detail}</code>
          </div>
        ) : (
          <p className="cv-bt-detail pv">{facts.detail}</p>
        ))}
    </>
  )
}

const STATUS_LABEL = {
  starting: 'Starting',
  running: 'Running',
  waiting: 'Needs your decision',
  idle: 'Idle',
  stopped: 'Stopped',
  failed: 'Failed',
}

/// The choice the harness's own words gave the answered decision - the
/// option's label, never its wire id.
const decisionAnswer = (item) =>
  item.options.find((option) => option.id === item.answeredChoice)?.label ?? item.answeredChoice ?? ''

/// One markdown body, priced: a settled body's text never changes again,
/// so it parses once and the cache stands through every later rail render
/// - a stream delta used to re-parse every earlier message. A live body
/// (a token stream) re-parses at most once every 100ms; between beats the
/// last HTML stands, and React sees the same string and skips the
/// innerHTML write, so a fast token beat neither re-parses nor rewrites
/// the growing reply per token. The cache keys on the text, not the item
/// object: the reducer folds deltas into the live item in place, so item
/// identity would freeze while the text grew - a changed text re-parses,
/// an unchanged one reuses the cached HTML.
function MarkdownBody({ text, live = false, className, tail = '' }) {
  const cache = useRef({ text: null, html: '', at: 0 })
  let html = cache.current.html
  if (cache.current.text !== text && (!live || shouldRenderLive(cache.current.at))) {
    html = renderMarkdown(text)
    cache.current = { text, html, at: Date.now() }
  }
  return <p className={className} dangerouslySetInnerHTML={{ __html: html + tail }} />
}

/// The harness's own reasoning, dim and collapsible. Collapsed by
/// default; live streams breathe while the thinking runs.
function ReasoningBlock({ text, live }) {
  const [open, setOpen] = useState(false)
  const label = live ? 'Thinking…' : 'Thought process'
  return (
    <div className="cv-node cv-reasoning">
      <button type="button" className="cv-reasoning-head" onClick={() => setOpen(!open)} aria-expanded={open}>
        <Brain size={12} />
        {label}
      </button>
      {(open || live) && (
        <MarkdownBody text={text} live={live} className={`cv-reasoning-body pv${live ? ' live' : ''}`} />
      )}
    </div>
  )
}

/// A decision, as its own card: the question is the content, the pending
/// state wears the brand amber, and the affirmative is the one amber
/// action. On answer the amber drains back to a settled card and the
/// buttons fade out over 0.3s - only for a decision this view watched
/// pending, never for history reopened already answered.
function DecisionCard({ item, onAnswer }) {
  const [leaving, setLeaving] = useState(false)
  const wasPending = useRef(item.pending)
  useEffect(() => {
    const was = wasPending.current
    wasPending.current = item.pending
    if (!was || item.pending) return
    setLeaving(true)
    const timer = setTimeout(() => setLeaving(false), 300)
    return () => clearTimeout(timer)
  }, [item.pending])
  // The question the harness actually asked, where it asked one in a
  // structured form (claude's AskUserQuestion); an approval carries its
  // content as a terminal tile instead - the command it wants to run,
  // never a JSON dump.
  const question =
    item.input && typeof item.input === 'object' && Array.isArray(item.input.questions)
      ? item.input.questions[0]?.question ?? null
      : null
  const command = !question && isCommandRun(item.input) ? item.input : null
  // A browser action asks in words: what it acts on, where, and what it
  // types or runs - never a JSON dump.
  const browser = !question && isBrowserTool(item.toolName) ? browserTool(item.toolName, item.input) : null
  // An approval's input rides its tool card once the answer settles it -
  // the run card is the one full record, so the settled card keeps the
  // answer line alone (never the same command twice). The 0.3s fade
  // holds the tile through the settle; a question card always keeps its
  // body - nothing else carries the question.
  const keepBody = item.pending || leaving || Boolean(question)
  return (
    <div className={`cv-decision${item.pending ? ' pending' : ''}`}>
      {question && <p className="cv-decision-ask pv">{question}</p>}
      {keepBody && command && (
        <div className="cv-cmd pv">
          {command.description && (
            <span className="cv-cmd-desc">{command.description}</span>
          )}
          <code className="cv-cmd-text">{command.command}</code>
        </div>
      )}
      {keepBody && browser && <BrowserFacts facts={browser} />}
      {keepBody && item.input && !question && !command && !browser && (
        <div className="cv-decision-io pv">
          <span className="cv-io-label">In</span>
          <code>{typeof item.input === 'string' ? item.input : JSON.stringify(item.input, null, 2)}</code>
        </div>
      )}
      {item.pending && item.options.length === 0 && (
        <p className="cv-decision-nochoice">
          No choices were offered - stop the session to end this turn.
        </p>
      )}
      {(item.pending || leaving) && item.options.length > 0 && (
        <div className={`cv-tool-actions${leaving && !item.pending ? ' leaving' : ''}`}>
          {item.options.map((option, index) => (
            <button
              key={option.id}
              type="button"
              className={index === 0 ? 'primary' : ''}
              onClick={() => onAnswer(item.id, option.id)}
            >
              {/* a question's options are the user's content; an
                  approval's words are the harness's, and stay readable */}
              {question ? <span className="pv">{option.label}</span> : option.label}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

// Claude, Codex, and Pi apply model and effort on the running thread now
// (claude's own /model and /effort slash commands, codex thread/settings,
// pi's wire). Fast stays start-time on claude (its /fast is a toggle with
// no explicit-off form). The others take settings when the process starts,
// so a stopped chat can still change them - resume is what lands the change.
const LIVE_SETTINGS = {
  claude: { model: true, effort: true, fast: false },
  codex: { model: true, effort: true, fast: true },
  pi: { model: true, effort: true, fast: false },
}

export default function ChatView({ chat, onBack, focused = true }) {
  const privacy = usePrivacyMode()
  const {
    capabilities,
    connection,
    sendPrompt,
    updateChatSettings,
    answerDecision,
    stopChat,
    interruptChat,
    resumeChat,
    modelsFor,
    devices,
    thisDevice,
    cloud,
    setDeviceKind,
    deleteChat,
    syncChat,
    queueMessage,
    removeQueued,
    steerQueued,
    steerMessage,
    resumeQueue,
    renameChat,
    chats,
    apiFor,
  } = useConsole()
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [confirmSync, setConfirmSync] = useState(false)
  // The header's menu: moving the chat to another project, and its title.
  const move = useMoveChat()
  const [headMenu, setHeadMenu] = useState(null)
  // A synced chat may run on another device: what can be done from here.
  const access = chatAccess(chat, devices, thisDevice, cloud)
  const reachable = access === 'here' || access === 'remote'
  const elsewhere = chat.executor && chat.executor !== thisDevice
  const where = elsewhere ? deviceName(devices, chat.executor) : 'this computer'
  const blocked = {
    offline: `${where} is offline - this copy is read-only until it is back`,
    'not-machine': `${where} isn't a machine - make it one to continue from here`,
    'signed-out': 'Sign in to Cloud to continue this chat',
    gone: `${where} left your Cloud - this copy is read-only`,
  }[access]
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const [picker, setPicker] = useState(null)
  const [models, setModels] = useState([])
  const [modelsPending, setModelsPending] = useState(true)
  const scrollRef = useRef(null)
  const composerRef = useRef(null)
  const inputRef = useRef(null)
  const rail = railItems(chat)
  const pendingDecision = rail.find((item) => item.kind === 'decision' && item.pending)
  // Every tool call riding the rail, keyed the way the duplicate checks
  // pair a decision with its run: (name, input). A settled approval
  // whose run is here hides - the run card is the one full record.
  const toolCalls = new Set(
    rail.filter((item) => item.kind === 'tool').map((item) => `${item.name}|${JSON.stringify(item.input)}`),
  )
  // The daemon takes a prompt on any session whose driver is alive - an
  // idle chat (its last turn finished) is sendable; only stopped/failed
  // need Resume first. Gating on `running` dead-locked the composer
  // after the first turn completed.
  const alive = !['stopped', 'failed'].includes(chat.status)
  // While a turn is working (or waiting on a decision) a message queues in
  // the daemon and runs as its own turn when this one ends.
  const turnOpen = chat.status === 'running' || chat.status === 'waiting'
  const queue = chat.queue ?? []
  // What rides the next message besides its words: pictures, and elements
  // picked in the browser (attachments.js keeps them per composer).
  const composerKey = chat.id
  const attached = useAttachments(composerKey)
  const canSend = (text.trim().length > 0 || attached.length > 0) && alive && !busy && reachable
  const harness = (capabilities?.harnesses ?? []).find((h) => h.id === chat.harness)
  const takesImages = harness ? Boolean(harness.image_input) : IMAGE_HARNESSES.has(chat.harness)
  const attach = useAttachInput(composerKey, { enabled: takesImages && alive && reachable, onError: setError })
  // The browser's picks go to the composer the user is in: this one while
  // it is the focused pane's, or the moment its text gains focus.
  useEffect(() => {
    if (focused) setFocusedComposer(composerKey)
  }, [focused, composerKey])
  // A dev server this chat mentions opens beside it - this computer's own
  // servers, so only for a chat that runs here.
  const devChips = BESIDE && !elsewhere
  const live = LIVE_SETTINGS[chat.harness] ?? { model: false, effort: false, fast: false }
  // A stopped chat can change anything the harness accepts at start. A
  // running one only where the wire accepts it now - permission never:
  // every harness takes the word at process start only, so a running
  // chat shows the word as a fact, a stopped one can change it.
  const canChange = chat.running
    ? { ...live, permission: false }
    : { model: true, effort: true, fast: Boolean(harness?.fast_supported), permission: true }
  // The catalog row for the chat's model, matched by pick word or by the
  // resolved id a running session reports back - the row either way, so
  // the chip's name never changes when the first turn resolves the id.
  const currentModel = findModel(models, chat.model)
  const efforts = currentModel?.reasoning_efforts ?? []
  // The / and @ menus, asking the machine that runs this chat.
  const cloudReady = signedIn(cloud)
  const menus = useComposerMenus({
    text,
    setText,
    inputRef,
    harness: chat.harness,
    sessionId: chat.id,
    deviceId: elsewhere ? chat.executor : null,
    inChat: true,
    cloudReady,
    enabled: alive && reachable,
    choicesFor: (arg) => {
      if (arg === 'model') return models.map((m) => ({ id: m.model, name: m.display_name ?? m.model }))
      if (arg === 'effort') return efforts.map((e) => ({ id: e }))
      if (arg === 'fast') return [{ id: 'on' }, { id: 'off' }]
      if (arg === 'permission') return (harness?.permission_modes ?? []).map((w) => ({ id: w }))
      return []
    },
  })

  // An OpenRemote command from the composer, run here before the rest of
  // the message goes: the same paths the pickers and buttons take.
  const runCommand = async ({ name, arg }) => {
    if (name === 'model' || name === 'effort' || name === 'permissions') {
      if (!arg) throw new Error(`/${name} needs a choice - pick one from its menu`)
      const key = { model: 'model', effort: 'effort', permissions: 'permissionMode' }[name]
      await updateChatSettings(chat.id, { [key]: arg })
    } else if (name === 'fast') {
      await updateChatSettings(chat.id, { fast: arg ? arg.toLowerCase() === 'on' : !chat.fast })
    } else if (name === 'stop') {
      await stopChat(chat.id)
    } else if (name === 'resume') {
      await resumeChat(chat.id)
    } else if (name === 'rename') {
      if (!arg) throw new Error('/rename needs a name: /rename "New name"')
      await renameChat(chat.id, arg)
    } else if (name === 'sync' || name === 'cloud') {
      await syncChat(chat.id)
    }
  }

  // The message as it goes: OpenRemote's commands run and leave it; what
  // remains goes to the harness with the chats it points at, its pictures,
  // and the picked elements' words. A message that can't carry what is
  // attached is refused before any command runs.
  const prepare = async () => {
    const { run, text: message } = takeCommands(text.trim(), ownCommands({ inChat: true, cloud: cloudReady }))
    const sent = attached
    const payload = outgoing(message, sent, {
      images: takesImages,
      harness: harnessName(chat.harness),
      remote: Boolean(elsewhere),
    })
    if (payload.error) throw new Error(payload.error)
    for (const command of run) await runCommand(command)
    return {
      message: payload.text,
      pointed: mentionedChats(message, chats),
      attachments: payload.attachments,
      sent,
    }
  }

  // What was sent leaves the composer; anything the browser added
  // meanwhile stays.
  const clearSent = (sent) => {
    for (const item of sent) removeAttachment(composerKey, item.id)
  }

  useEffect(() => {
    let cancelled = false
    if (!canChange.model && !canChange.effort) {
      setModelsPending(false)
      return
    }
    setModelsPending(true)
    modelsFor(chat.harness, elsewhere ? chat.executor : null).then((list) => {
      if (!cancelled) {
        setModels(list ?? [])
        setModelsPending(false)
      }
    })
    return () => {
      cancelled = true
    }
    // The fetch also follows the connection and the executor: one failed
    // call (a restarting daemon, a machine briefly offline) used to stick
    // an empty list for the view's lifetime, and a chat that synced to a
    // machine kept the catalog of where it ran before. An empty answer is
    // not cached (modelsFor), so a retry is cheap.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chat.harness, connection.state, elsewhere ? chat.executor : null])

  const openPicker = (kind) => (e) => setPicker({ kind, x: e.clientX, y: e.clientY })

  const changeSettings = async (settings) => {
    setPicker(null)
    setBusy(true)
    setError(null)
    try {
      await updateChatSettings(chat.id, settings)
    } catch (err) {
      setError(err.message ?? String(err))
    } finally {
      setBusy(false)
    }
  }

  useEffect(() => {
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [rail.length, chat.status])

  // The dev servers this chat mentions, for the browser's new tab page:
  // what arrives while the chat is open, and on opening, its latest turn
  // - an old transcript's servers are long gone.
  const noted = useRef(null)
  useEffect(() => {
    const opening = noted.current == null
    if (opening) noted.current = new Set()
    const seen = noted.current
    let latestTurn = 0
    if (opening) {
      for (let i = rail.length - 1; i >= 0; i--) {
        if (rail[i].kind === 'message' && rail[i].role === 'user') {
          latestTurn = i
          break
        }
      }
    }
    rail.forEach((item, i) => {
      const said =
        item.kind === 'message' && item.role === 'agent' ? item.text : item.kind === 'tool' ? item.result : null
      if (!said) return
      const key = `${item.id}|${said.length}`
      if (seen.has(key)) return
      seen.add(key)
      if (!opening || i > latestTurn) noteDevServers(chat.id, said)
    })
  })

  // the composer floats over the transcript; its height varies as the
  // textarea grows. Publish it as --cv-clear so the thread's bottom padding
  // always keeps the last message above the box, never under it.
  useEffect(() => {
    const composer = composerRef.current
    if (!composer) return
    const set = () => {
      const root = composer.parentElement
      if (root) root.style.setProperty('--cv-clear', `${Math.ceil(composer.offsetHeight)}px`)
    }
    set()
    const ro = new ResizeObserver(set)
    ro.observe(composer)
    return () => ro.disconnect()
  }, [])

  const send = async () => {
    if (!canSend) return
    setBusy(true)
    setError(null)
    try {
      const { message, pointed, attachments, sent } = await prepare()
      if (message || attachments.length) {
        if (turnOpen) await queueMessage(chat.id, message, pointed, attachments)
        else await sendPrompt(chat.id, message, pointed, attachments)
      }
      clearSent(sent)
      setText('')
    } catch (err) {
      setError(err.message ?? String(err))
    } finally {
      setBusy(false)
    }
  }

  const answer = async (decisionId, choice) => {
    setBusy(true)
    setError(null)
    try {
      await answerDecision(decisionId, choice)
    } catch (err) {
      setError(err.message ?? String(err))
    } finally {
      setBusy(false)
    }
  }

  const control = async (action) => {
    setBusy(true)
    setError(null)
    try {
      await action()
    } catch (err) {
      setError(err.message ?? String(err))
    } finally {
      setBusy(false)
    }
  }

  // The keyboard acts on the focused pane's chat (keyboard.jsx). A key
  // whose action can't happen here - no running turn to interrupt, no
  // model list - falls through untouched.
  const openPickerAt = (kind) => {
    const el = composerRef.current?.querySelector(`[data-picker="${kind}"]`)
    if (!el) return false
    const r = el.getBoundingClientRect()
    setPicker({ kind, x: r.left + r.width / 2, y: r.top + r.height / 2 })
  }
  const permissionWords = harness?.permission_modes ?? []
  const canPickPermission = permissionWords.length > 0 && canChange.permission && !chat.running
  useShortcut(
    'focus-composer',
    () => {
      const el = inputRef.current
      if (!el || el.disabled) return false
      el.focus()
    },
    focused,
  )
  useShortcut(
    'interrupt',
    () => {
      if (!reachable || !chat.running) return false
      control(() => interruptChat(chat.id))
    },
    focused,
  )
  useShortcut(
    'stop',
    () => {
      if (!reachable || !chat.running) return false
      control(() => stopChat(chat.id))
    },
    focused,
  )
  useShortcut('pick-model', () => openPickerAt('model'), focused)
  useShortcut('pick-effort', () => openPickerAt('effort'), focused)
  useShortcut('pick-permission', () => openPickerAt('permission'), focused)
  useShortcut(
    'toggle-fast',
    () => {
      if (!canChange.fast || !harness?.fast_supported) return false
      changeSettings({ fast: !chat.fast })
    },
    focused,
  )
  useModelSwitches((i) => {
    if (!canChange.model || !models[i]) return false
    changeSettings({ model: models[i].model })
  }, focused)
  usePaletteSource(
    'model',
    () =>
      canChange.model && models.length
        ? {
            title: 'Switch model',
            items: models.map((m) => ({
              id: m.model,
              name: m.display_name ?? m.model,
              icon: <ModelMark maker={modelMaker(chat.harness, m.model, m.resolved_model)} size={14} />,
            })),
            selectedId: currentModel?.model ?? chat.model,
            choose: (id) => changeSettings({ model: id }),
          }
        : null,
    focused,
  )
  usePaletteSource(
    'effort',
    () =>
      canChange.effort && efforts.length
        ? {
            title: 'Set effort',
            items: efforts.map((e) => ({ id: e, name: e })),
            selectedId: chat.effort,
            choose: (id) => changeSettings({ effort: id }),
          }
        : null,
    focused,
  )
  usePaletteSource(
    'permission',
    () =>
      canPickPermission
        ? {
            title: 'Set permission',
            items: permissionWords.map((w) => ({ id: w, name: w })),
            selectedId: chat.permissionMode,
            choose: (id) => changeSettings({ permissionMode: id }),
          }
        : null,
    focused,
  )
  // Steer (Ctrl+Enter): into the running turn now; with nothing running
  // it is an ordinary send.
  const steerNow = async () => {
    if ((!text.trim() && !attached.length) || !alive || !reachable || busy) return false
    if (!turnOpen) {
      send()
      return
    }
    setBusy(true)
    setError(null)
    try {
      const { message, pointed, attachments, sent } = await prepare()
      if (message || attachments.length) await steerMessage(chat.id, message, pointed, attachments)
      clearSent(sent)
      setText('')
    } catch (err) {
      setError(err.message ?? String(err))
    } finally {
      setBusy(false)
    }
  }
  useShortcut('steer', steerNow, focused)
  // Edit: a queued message comes back to the composer (in front of
  // anything already typed) and leaves the queue; Enter queues it again.
  const pullBack = (message) => {
    setText((typed) => (typed.trim() ? `${message.text}\n${typed}` : message.text))
    // Its pictures come back as attachments, read from where they were
    // kept.
    for (const image of message.images ?? []) {
      chatImageDataUrl(apiFor(elsewhere ? chat.executor : null), image, elsewhere ? chat.id : null)
        .then((dataUrl) => addAttachment({ kind: 'image', name: 'Picture', mime: image.mime, dataUrl }, composerKey))
        .catch(() => setError('A queued picture could not be brought back - attach it again.'))
    }
    control(() => removeQueued(chat.id, message.id))
    inputRef.current?.focus()
  }
  const steerLabel = turnOpen
    ? INTERRUPT_STEER.has(chat.harness)
      ? 'Interrupt + send'
      : 'Steer into the running turn'
    : 'Send now'
  // The row's Steer button says what it will do: steer, interrupt and
  // send (one process per prompt), or simply send when nothing runs.
  const steerButton = turnOpen ? (INTERRUPT_STEER.has(chat.harness) ? 'Interrupt + send' : 'Steer') : 'Send now'
  const hintSteer = useHint('steer')
  const hintInterrupt = useHint('interrupt')
  const hintStop = useHint('stop')
  const hintModel = useHint('pick-model')
  const hintEffort = useHint('pick-effort')
  const hintPermission = useHint('pick-permission')
  const hintFast = useHint('toggle-fast')

  return (
    <div className="chatview">
      <header className="cv-head">
        <h1 className="pv">{chat.title ?? 'A new task'}</h1>
        <p className="cv-facts">
          {chat.status !== 'idle' && <span className={`cv-dot cv-dot--${chat.status}`} />}
          <span className="cv-where pv">{chat.workspace}</span>
          <span className="cv-fact">{harnessName(chat.harness)}</span>
          {elsewhere && <span className="cv-fact">on <span className="pv">{where}</span></span>}
          {chat.model && (
            <span className="cv-fact" title={chat.model}>
              {modelDisplayName(models, chat.model)}
            </span>
          )}
          {chat.effort && <span className="cv-fact">{chat.effort}</span>}
          {chat.permissionMode && (
            <span
              className="cv-fact"
              title={`The harness's permission word for this chat (${harnessName(chat.harness)}'s own spelling)`}
            >
              {chat.permissionMode}
            </span>
          )}
          {chat.fast && <span className="cv-fact">Fast</span>}
          {chat.costUsd > 0 && (
            <span className="cv-fact">${chat.costUsd < 0.01 ? chat.costUsd.toFixed(4) : chat.costUsd.toFixed(2)}</span>
          )}
          {chat.thinkingTokens > 0 && (
            <span className="cv-fact">{chat.thinkingTokens.toLocaleString()} thinking tokens</span>
          )}
          {chat.approvedTools?.length > 0 && (
            <span className="cv-fact">
              <span className="pv">{chat.approvedTools.join(' · ')}</span> allowed for this chat
            </span>
          )}
          <span className="cv-fact">{STATUS_LABEL[chat.status] ?? chat.status}</span>
          {access === 'not-machine' && (
            <button
              className="cv-fact-btn"
              onClick={() => control(() => setDeviceKind(chat.executor, 'machine'))}
              title={privacy ? 'Let your other devices run chats on it' : `Let your other devices run chats on ${where}`}
            >
              Make <span className="pv">{where}</span> a machine
            </button>
          )}
          {reachable && chat.running && (
            <>
              <button className="cv-fact-btn" onClick={() => control(() => interruptChat(chat.id))} title={hintInterrupt('Interrupt the running turn - the session stays alive')}>
                <HandPalm size={11} weight="fill" />
                Interrupt
              </button>
              <button className="cv-fact-btn" onClick={() => control(() => stopChat(chat.id))} title={hintStop('Stop the session')}>
                <Stop size={11} weight="fill" />
                Stop
              </button>
            </>
          )}
          {/* Resume rides the harness's own conversation (claude
              `--resume`, codex thread/resume, ...). A chat stopped before
              its first message never got one - the daemon would only
              answer "nothing to resume", so the button never shows there. */}
          {reachable && (chat.status === 'stopped' || chat.status === 'failed') && chat.resumable && (
            <button className="cv-fact-btn" onClick={() => control(() => resumeChat(chat.id))} title="Resume the session">
              <Play size={11} weight="fill" />
              Resume
            </button>
          )}
          {/* A private chat can join Cloud - asked first, since the whole
              transcript goes, tool output included. */}
          {!chat.executor && signedIn(cloud) && (
            confirmSync ? (
              <>
                <span className="cv-fact">Copy this chat, tool output included, to your other devices?</span>
                <button
                  className="cv-fact-btn"
                  onClick={() =>
                    control(async () => {
                      await syncChat(chat.id)
                      setConfirmSync(false)
                    })
                  }
                >
                  <CloudArrowUp size={11} />
                  Sync
                </button>
                <button className="cv-fact-btn" onClick={() => setConfirmSync(false)}>
                  Cancel
                </button>
              </>
            ) : (
              <button
                className="cv-fact-btn"
                onClick={() => setConfirmSync(true)}
                title="Copy this chat to your other devices"
              >
                <CloudArrowUp size={11} />
                Sync
              </button>
            )
          )}
          {/* The browser, as a pane beside this chat - the same one the
              sidebar opens; one pane holds it at a time. */}
          {BESIDE && (
            <button
              className="cv-fact-btn"
              onClick={() => requestBrowser({ chatId: chat.id })}
              title="Open the browser beside this chat"
            >
              <Globe size={11} />
              Browser
            </button>
          )}
          {/* Deleting a synced chat removes it from every device - asked
              twice, in place. */}
          {chat.executor && (
            confirmDelete ? (
              <>
                <button className="cv-fact-btn" onClick={() => control(() => deleteChat(chat.id))} title="Delete this chat on all your devices">
                  <Trash size={11} />
                  Delete everywhere
                </button>
                <button className="cv-fact-btn" onClick={() => setConfirmDelete(false)}>
                  Keep
                </button>
              </>
            ) : (
              <button className="cv-fact-btn" onClick={() => setConfirmDelete(true)} title="Delete this chat">
                <Trash size={11} />
                Delete
              </button>
            )
          )}
          <button
            className="cv-fact-btn cv-fact-more"
            title="More for this chat"
            aria-label="More for this chat"
            aria-haspopup="menu"
            aria-expanded={Boolean(headMenu)}
            onClick={(e) => {
              const r = e.currentTarget.getBoundingClientRect()
              // A chat on another machine moves among that machine's
              // projects: they are asked for as the menu opens.
              move.prepare(chat)
              setHeadMenu({ x: r.left, y: r.bottom + 4 })
            }}
          >
            <DotsThree size={13} weight="bold" />
          </button>
        </p>
        {chat.lastError && chat.status === 'failed' && <p className="cv-facts cv-error pv">{chat.lastError}</p>}
        {headMenu && (
          <ContextMenu
            x={headMenu.x}
            y={headMenu.y}
            items={[
              move.menuItem(chat),
              {
                label: 'Copy chat title',
                icon: <Copy size={14} />,
                onSelect: () => navigator.clipboard?.writeText(chat.title ?? '').catch(() => {}),
              },
            ]}
            onClose={() => setHeadMenu(null)}
          />
        )}
        {move.modal}
      </header>
      <div className="cv-scroll" ref={scrollRef}>
        <div className="cv-thread">
          {rail.length === 0 && <p className="cv-node cv-note">The transcript will appear here.</p>}
          {rail.map((item) => {
            if (item.kind === 'reasoning' || item.kind === 'reasoning-stream') {
              // The harness's own thinking, dim and collapsible - never
              // mixed into the reply. Collapsed by default; the live
              // stream shows its tail growing while it runs.
              return (
                <ReasoningBlock key={item.id} text={item.text} live={item.kind === 'reasoning-stream'} />
              )
            }
            if (item.kind === 'stream') {
              // The live reply - markdown as it arrives, with a breathing
              // caret riding the end. The settled message.added replaces
              // this item whole, so a beat the throttle holds back never
              // loses text: the settle carries the complete reply.
              return (
                <MarkdownBody
                  key={item.id}
                  text={item.text}
                  live
                  className="cv-node cv-agent pv"
                  tail='<span class="cv-caret"></span>'
                />
              )
            }
            if (item.kind === 'message') {
              if (item.role === 'user') {
                // The words, then the pictures sent with them.
                return (
                  <div key={item.id} className="cv-user">
                    {item.text && <div className="pv">{item.text}</div>}
                    <ChatImages images={item.images} chat={chat} label="Attached picture" />
                  </div>
                )
              }
              if (item.role === 'note') return <p key={item.id} className="cv-node cv-note pv">{item.text}</p>
              // Agent messages are markdown - the harness's own output
              // shape - rendered through the escape-first mini renderer,
              // parsed once per message (MarkdownBody's cache). A dev
              // server it names gets its "Open beside chat" chip.
              if (devChips && devServersIn(item.text).length) {
                return (
                  <div key={item.id} className="cv-node cv-agent-wrap">
                    <MarkdownBody text={item.text} className="cv-agent pv" />
                    <DevServerChips text={item.text} chatId={chat.id} />
                  </div>
                )
              }
              return <MarkdownBody key={item.id} text={item.text} className="cv-node cv-agent pv" />
            }
            if (item.kind === 'tool') {
              // While the ask for this very call is pending, the decision
              // card is the one card - it carries the command and the
              // buttons, and this one saying "Running" would be a lie (the
              // call is blocked) and a duplicate. It returns once the
              // answer lands and the run is real.
              const isThePendingAsk =
                pendingDecision &&
                pendingDecision.toolName === item.name &&
                JSON.stringify(pendingDecision.input) === JSON.stringify(item.input)
              if (isThePendingAsk) return null
              // A file edit renders as a split diff - the tool card's
              // honest shape, never a JSON dump of its input.
              const edit = isFileEdit(item.input)
                ? item.input.old_string != null
                  ? editRows(item.input.old_string, item.input.new_string)
                  : writeRows(item.input.content)
                : null
              // What the card actually shows: a bounded first slice, never
              // the whole walk - a 3000-line write renders 500 rows plus a
              // note, not thousands of DOM nodes. Tool inputs and outputs
              // take the same cap on their lines.
              const diff = edit && edit.length > 0 ? capRows(edit) : null
              // A command run renders as a terminal tile - the command
              // itself in mono, its description as the caption, never a
              // JSON dump of the input. The tile replaces the In row
              // alone; the Out row still shows what the command printed.
              const command = !edit && isCommandRun(item.input) ? item.input : null
              // One of OpenRemote's browser tools reads as "Browser ·
              // click" with what it acted on, never as a JSON dump.
              const browser = isBrowserTool(item.name) ? browserTool(item.name, item.input) : null
              const shownIn = item.input && !command && !edit && !browser
                ? capLines(typeof item.input === 'string' ? item.input : JSON.stringify(item.input, null, 2))
                : null
              const shownOut = item.result ? capLines(item.result) : null
              // The status rides the name line, right-aligned - the beat of
              // agent work: a breathing green dot and Running while the tool
              // is in flight, a check the moment the result lands (green
              // for done, red for failed) - and it stays, the transcript's
              // own record. A tool left unresolved by an interrupted turn
              // never pretends: no status word.
              const inFlight = item.result == null && chat.running
              return (
                <div key={item.id} className={`cv-node cv-node--${item.state}`}>
                  <div className="cv-tool-line">
                    <span className="cv-tool-name" title={browser ? item.name : undefined}>
                      {browser ? browser.label : item.name}
                    </span>
                    {inFlight ? (
                      <span className="cv-tool-status">
                        <span className="cv-tool-status-dot" />
                        Running
                      </span>
                    ) : item.state === 'failed' ? (
                      <span className="cv-tool-status">
                        <Check className="cv-check--failed" size={13} weight="bold" />
                        Failed
                      </span>
                    ) : (
                      <span className="cv-tool-status">
                        <Check className="cv-check--ok" size={13} weight="bold" />
                        Done
                      </span>
                    )}
                  </div>
                  {diff && (
                    <div className="cv-diff pv">
                      <div className="cv-diff-file">{item.input.file_path}</div>
                      <div className="cv-diff-grid">
                        {diff.rows.map((row, i) => (
                          <div className="cv-diff-row" key={i}>
                            <span className={`cv-diff-side cv-diff-side--${row.left.kind ?? 'empty'}`}>{row.left.text}</span>
                            <span className={`cv-diff-side cv-diff-side--${row.right.kind ?? 'empty'}`}>{row.right.text}</span>
                          </div>
                        ))}
                        {diff.hidden > 0 && (
                          <div className="cv-diff-more">Showing the first {MAX_RENDER_ROWS} rows.</div>
                        )}
                      </div>
                    </div>
                  )}
                  {command && (
                    <div className="cv-cmd pv">
                      {/* the description leads - what this is, in plain
                          words - then the command itself in mono */}
                      {command.description && (
                        <span className="cv-cmd-desc">{command.description}</span>
                      )}
                      <code className="cv-cmd-text">{command.command}</code>
                    </div>
                  )}
                  {browser && <BrowserFacts facts={browser} />}
                  {(shownIn || shownOut) && !edit && (
                    <div className="cv-io pv">
                      {shownIn && (
                        <>
                          <div className="cv-io-row">
                            <span className="cv-io-label">In</span>
                            <code>{shownIn.text}</code>
                          </div>
                          {shownIn.hidden > 0 && (
                            <div className="cv-io-more">Showing the first {MAX_RENDER_LINES} lines.</div>
                          )}
                        </>
                      )}
                      {shownOut && <OutRow out={shownOut} fold={Boolean(browser) && foldsResult(item.name)} />}
                    </div>
                  )}
                  {/* What the tool answered with besides words - an
                      agent's screenshot, inline, large on a click. */}
                  <ChatImages images={item.images} chat={chat} label="Screenshot" />
                  {devChips && item.result && <DevServerChips text={item.result} chatId={chat.id} />}
                </div>
              )
            }
            // decision: approval or question, options in the harness's words.
            // A settled approval whose own run rides the rail hides -
            // the run card is the one full record (its Done/Failed is
            // the outcome); the answered card would only repeat the
            // command. Questions always keep theirs - nothing else
            // carries the Q&A - and a settled approval with no run card
            // (an ask that never became one) keeps its answer line.
            const isQuestion =
              item.input && typeof item.input === 'object' && Array.isArray(item.input.questions)
            if (
              !item.pending &&
              !isQuestion &&
              item.toolName &&
              toolCalls.has(`${item.toolName}|${JSON.stringify(item.input)}`)
            ) {
              return null
            }
            return (
              <div key={item.id} className={`cv-node cv-node--${item.pending ? 'pending' : 'done'}`}>
                <div className="cv-tool-line">
                  <span className="cv-tool-name" title={isBrowserTool(item.toolName) ? item.toolName : undefined}>
                    {isBrowserTool(item.toolName)
                      ? browserTool(item.toolName, item.input).label
                      : item.toolName ?? 'Decision'}
                  </span>
                  <span className="cv-tool-state">
                    {item.pending ? (
                      'Needs a decision'
                    ) : isQuestion ? (
                      <>Answered: <span className="pv">{decisionAnswer(item)}</span></>
                    ) : (
                      `Answered: ${decisionAnswer(item)}`
                    )}
                  </span>
                </div>
                <DecisionCard item={item} onAnswer={answer} />
              </div>
            )
          })}
          {chat.running && !pendingDecision && (
            <p className="cv-node cv-node--run cv-running">
              With {harnessName(chat.harness)} · <span className="pv">{where}</span>
            </p>
          )}
        </div>
      </div>

      <div className="cv-composer" ref={composerRef}>
        {/* On the phone the browser never opens by itself: the chat says
            the agent is in it, and a tap opens the Browser view. */}
        {isMobile && isBrowsing(chat) && (
          <button type="button" className="cv-browsing" onClick={() => requestBrowser({ chatId: chat.id })}>
            <span className="cv-browsing-dot" />
            {harnessName(chat.harness)} is browsing
            <Globe size={13} />
          </button>
        )}
        <div className="cv-box" onDragOver={attach.onDragOver} onDrop={attach.onDrop}>
          {menus.element}
          {queue.length > 0 && (
            <div className="cv-queue">
              <div className="cv-queue-head">
                {chat.queuePaused ? (
                  <>
                    <span>Queue paused</span>
                    <button
                      type="button"
                      className="cv-queue-resume"
                      disabled={!reachable}
                      onClick={() => control(() => resumeQueue(chat.id))}
                    >
                      Resume
                    </button>
                  </>
                ) : (
                  <span>{queue.length} queued</span>
                )}
              </div>
              {queue.map((message) => (
                <div key={message.id} className="cv-queue-row">
                  <span className="cv-queue-text pv">{message.text}</span>
                  {message.images?.length > 0 && (
                    <span
                      className="cv-queue-pics"
                      title={`${message.images.length} picture${message.images.length > 1 ? 's' : ''} with it`}
                    >
                      <ImageSquare size={13} />
                      {message.images.length}
                    </span>
                  )}
                  <span className="cv-queue-actions">
                    <button
                      type="button"
                      className="cv-queue-icon"
                      title="Edit - back to the composer"
                      onClick={() => pullBack(message)}
                    >
                      <PencilSimple size={16} />
                    </button>
                    <button
                      type="button"
                      className="cv-queue-icon"
                      title="Remove"
                      onClick={() => control(() => removeQueued(chat.id, message.id))}
                    >
                      <X size={16} />
                    </button>
                    <button
                      type="button"
                      className="cv-queue-steer"
                      title={hintSteer(steerLabel)}
                      disabled={!reachable}
                      onClick={() => control(() => steerQueued(chat.id, message.id))}
                    >
                      <ArrowUpRight size={14} weight="bold" />
                      {steerButton}
                    </button>
                  </span>
                </div>
              ))}
            </div>
          )}
          <AttachmentChips composerKey={composerKey} takesImages={takesImages} harness={harnessName(chat.harness)} />
          <textarea
            ref={inputRef}
            value={text}
            onChange={(e) => {
              setText(e.target.value)
              menus.track(e)
            }}
            onKeyUp={menus.track}
            onClick={menus.track}
            onFocus={() => setFocusedComposer(composerKey)}
            onPaste={attach.onPaste}
            onKeyDown={(e) => {
              // The / and @ menus take their keys first.
              if (menus.onKeyDown(e)) return
              // A phone's keyboard Enter is a new line; the send button sends.
              // Ctrl/Cmd+Enter is Steer's (the keyboard catalog's).
              if (e.key === 'Enter' && !e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey && !isMobile) {
                e.preventDefault()
                send()
              }
              // Up on an empty composer brings the last queued message back.
              if (e.key === 'ArrowUp' && !text && queue.length > 0 && !isMobile) {
                e.preventDefault()
                pullBack(queue[queue.length - 1])
              }
            }}
            placeholder={
              blocked ??
              (alive
                ? pendingDecision
                  ? 'Decide above - or queue a message'
                  : turnOpen
                    ? 'Queue a message'
                    : 'Send a message'
                : chat.resumable
                  ? 'Resume the session to continue'
                  : 'This chat never started')
            }
            disabled={!alive || !reachable}
            spellCheck={false}
          />
          <div className="cv-foot">
            <div className="nc-pickers">
              {modelsPending && !chat.model ? (
                <span className="nc-skeleton" aria-hidden="true" />
              ) : canChange.model && models.length > 0 ? (
                <button
                  type="button"
                  className="nc-meta"
                  onClick={openPicker('model')}
                  aria-haspopup="listbox"
                  aria-expanded={picker?.kind === 'model'}
                  data-picker="model"
                  title={hintModel('Model - applies to the next turn')}
                >
                  {(() => {
                    // The shown model's own maker mark - the chosen
                    // one, else the harness's default row.
                    const row = (chat.model && findModel(models, chat.model)) ?? models.find((m) => m.is_default) ?? null
                    const maker = modelMaker(chat.harness, row?.model, row?.resolved_model)
                    return maker ? <ModelMark maker={maker} size={14} /> : null
                  })()}
                  {chat.model ? modelDisplayName(models, chat.model) : 'Model'}
                </button>
              ) : (
                chat.model && (
                  <span className="nc-meta nc-static" title={chat.model}>
                    {modelDisplayName(models, chat.model)}
                  </span>
                )
              )}
              {picker?.kind === 'model' && (
                <PickerMenu
                  label="Model"
                  searchPlaceholder="Search models"
                  wide
                  items={models.map((m) => ({
                    id: m.model,
                    name: m.display_name ?? m.model,
                    resolved_model: m.resolved_model,
                  }))}
                  groups={null}
                  selectedId={chat.model ?? ''}
                  onChoose={(id) => changeSettings({ model: id })}
                  onClose={() => setPicker(null)}
                  anchor={{ left: picker.x, top: picker.y }}
                  renderIcon={(m) => (
                    <ModelMark maker={modelMaker(chat.harness, m.id, m.resolved_model)} size={14} />
                  )}
                />
              )}
              {canChange.effort && efforts.length > 0 && (
                <button
                  type="button"
                  className="nc-meta"
                  onClick={openPicker('effort')}
                  aria-haspopup="listbox"
                  aria-expanded={picker?.kind === 'effort'}
                  data-picker="effort"
                  title={hintEffort("The harness's own effort")}
                >
                  {chat.effort ?? 'Effort'}
                </button>
              )}
              {picker?.kind === 'effort' && (
                <PickerMenu
                  label="Effort"
                  searchPlaceholder="Search efforts"
                  items={efforts.map((effort) => ({ id: effort, name: effort }))}
                  groups={null}
                  selectedId={chat.effort ?? ''}
                  onChoose={(id) => changeSettings({ effort: id })}
                  onClose={() => setPicker(null)}
                  anchor={{ left: picker.x, top: picker.y }}
                />
              )}
              {(canChange.model ? models.length > 0 : Boolean(chat.model)) && (
                <span className="nc-via">via</span>
              )}
              <span className="nc-meta nc-static">
                <HarnessMark harness={chat.harness} size={16} />
                {harnessName(chat.harness)}
              </span>
              {canChange.fast && harness?.fast_supported && (
                <button
                  type="button"
                  className={`nc-meta nc-fast${chat.fast ? ' on' : ''}`}
                  onClick={() => changeSettings({ fast: !chat.fast })}
                  aria-pressed={Boolean(chat.fast)}
                  title={hintFast("The harness's own fast mode")}
                >
                  <Lightning size={13} weight={chat.fast ? 'fill' : 'light'} />
                  Fast
                </button>
              )}
            </div>
            <div className="nc-send-group">
              {attach.button}
              {/* The buttons plugins add to the composer (dictation's
                  microphone, say), dimmed while the chat can't take text. */}
              <PluginComposerButtons
                inputRef={inputRef}
                setText={setText}
                composer={chat.id}
                disabled={!alive || !reachable}
              />
              {/* The harness's own permission word for this chat, by the
                  send button: the last thing to check before a message
                  goes. It is start-time on every harness - the chip
                  changes it only on a stopped chat (resume lands it); on a
                  running one it stays the quiet fact the facts row already
                  shows. */}
              {(harness?.permission_modes ?? []).length > 0 &&
                (canChange.permission && !chat.running ? (
                  <button
                    type="button"
                    className="nc-meta"
                    data-unset={!chat.permissionMode || undefined}
                    onClick={openPicker('permission')}
                    aria-haspopup="listbox"
                    aria-expanded={picker?.kind === 'permission'}
                    data-picker="permission"
                    title={hintPermission('What the harness may do without asking - lands when the chat next starts')}
                  >
                    {chat.permissionMode ?? 'Permission'}
                  </button>
                ) : (
                  chat.permissionMode && (
                    <span
                      className="nc-meta nc-static"
                      title={`The harness's permission word for this chat (${harnessName(chat.harness)}'s own spelling)`}
                    >
                      {chat.permissionMode}
                    </span>
                  )
                ))}
              {picker?.kind === 'permission' && (
                <PickerMenu
                  label="Permission"
                  searchPlaceholder="Search permission words"
                  items={(harness?.permission_modes ?? []).map((word) => ({
                    id: word,
                    name: word,
                  }))}
                  groups={null}
                  selectedId={chat.permissionMode ?? ''}
                  onChoose={(id) => changeSettings({ permissionMode: id })}
                  onClose={() => setPicker(null)}
                  anchor={{ left: picker.x, top: picker.y }}
                  renderSubline={(item) =>
                    item.id === harness?.default_permission ? (
                      <span className="nc-item-sub">
                        {harnessName(chat.harness)} runs this by default
                      </span>
                    ) : null
                  }
                />
              )}
              {/* The ring renders wherever usage is known - the composer's
                  one live element; a claude chat carries it from its first
                  breath at zero. Codex reports its window too; claude
                  reports usage only, so the fill rides a nominal window
                  and the card says so. */}
              {(chat.context?.used != null || chat.harness === 'claude') && (
                <ContextRing
                  used={chat.context?.used ?? 0}
                  window={chat.context?.window ?? (chat.harness === 'claude' ? 200_000 : 0)}
                  nominal={chat.context?.window == null}
                />
              )}
              <button
                className="nc-send"
                onClick={send}
                disabled={!canSend}
                title={turnOpen ? `Queue (Enter) - ${hintSteer(steerLabel)}` : 'Send'}
              >
                <ArrowUp size={15} weight="bold" />
              </button>
            </div>
          </div>
        </div>
        {(error || connection.state === 'error') && (
          <p className="cv-error-line">{error ?? connection.error}</p>
        )}
      </div>
    </div>
  )
}
