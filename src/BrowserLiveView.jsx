// A tab of another of the user's devices, shown live here. The device that
// has the tab sends pictures of it (through this device's daemon, which
// keeps only the newest and hands it over when asked for the next), drawn
// on a canvas in the page's own shape; with control taken, a tap clicks, a
// drag scrolls, a long press then a drag drags, two fingers zoom the
// picture here (the page itself doesn't move), and a hidden textarea turns
// typing - the phone's keyboard included - into text and keys for the page.
//
// It streams only while it is on screen: pictures stop being asked for
// when the view is hidden or covered, and the source stops sending after
// two it hasn't been told were taken. The gestures are in
// browser-live-input.js.

import { useCallback, useEffect, useRef, useState } from 'react'
import { CursorClick, Desktop, DeviceMobile, Keyboard, X } from '@phosphor-icons/react'
import { isMac } from './keyboard.jsx'
import {
  HOLD_MS,
  clampView,
  coalesce,
  fit,
  flingSteps,
  keyName,
  pinchView,
  start,
  step,
  textEdits,
  toPage,
  wheelFromDrag,
  wheelPixels,
} from './browser-live-input.js'
import './browser-live.css'

// The textarea always holds this one character, so a soft keyboard's
// Backspace has something to delete and shows up as an edit.
const SENTINEL = '​'
// A second press this soon, this near, counts as a double click.
const DOUBLE_MS = 400
const DOUBLE_NEAR = 6

// A device's icon: a phone's, or a computer's.
export function DeviceIcon({ platform, size = 14, className }) {
  const phone = platform === 'android' || platform === 'ios'
  const Icon = phone ? DeviceMobile : Desktop
  return <Icon size={size} className={className} />
}

// What a poll of the devices' tabs answers: each other device with a
// browser open that can show its tabs live, and the tabs it has. Asked
// again every few seconds while `on` (a menu or a grid showing them).
export function useRemoteTabs(api, on) {
  const [state, setState] = useState({ devices: [], loaded: false })
  useEffect(() => {
    if (!on || !api?.ready) return undefined
    let stopped = false
    let timer = 0
    const load = async () => {
      try {
        const got = await api.call('GET', '/browser/remote', null, { timeoutMs: 12_000 })
        if (!stopped) setState({ devices: (got?.devices ?? []).filter((d) => d.live), loaded: true })
      } catch {
        /* the next poll tries again */
      }
      if (!stopped) timer = setTimeout(load, 5000)
    }
    load()
    return () => {
      stopped = true
      clearTimeout(timer)
    }
  }, [api, on])
  return state
}

// The live views this device takes part in: its own tabs shown elsewhere
// (`viewed`), for the "Viewed from" bar. Asked every few seconds while `on`.
export function useViews(api, on) {
  const [views, setViews] = useState({ viewed: [], watching: [] })
  useEffect(() => {
    if (!on || !api?.ready) return undefined
    let stopped = false
    let timer = 0
    const load = async () => {
      try {
        const got = await api.call('GET', '/browser/views')
        if (!stopped) {
          setViews((was) => (JSON.stringify(was) === JSON.stringify(got) ? was : got))
        }
      } catch {
        /* the next poll tries again */
      }
      if (!stopped) timer = setTimeout(load, 3000)
    }
    load()
    return () => {
      stopped = true
      clearTimeout(timer)
    }
  }, [api, on])
  return views
}

// "Viewed from <device>": another device is showing this tab live, and
// whether its hand is on the page. Shown on the device with the tab, in
// the page's flow, with a way to end the viewing from here.
export function ViewedBar({ api, views, tab }) {
  const here = (views?.viewed ?? []).filter((v) => v.tab === tab)
  if (!here.length) return null
  const names = [...new Set(here.map((v) => v.viewer))].join(', ')
  const holding = here.find((v) => v.control)
  const stop = () => {
    for (const v of here) api?.call('POST', `/browser/views/${v.id}/end`).catch(() => {})
  }
  return (
    <div className="bw-info" role="status">
      <span className="bw-agent-dot live" />
      <span className="bw-info-text">
        Viewed from <strong className="pv">{names}</strong>
        {holding ? <> - <strong className="pv">{holding.viewer}</strong> has control</> : null}
      </span>
      <button type="button" className="pn-btn" onClick={stop}>
        Stop
      </button>
    </div>
  )
}

function cellular() {
  try {
    return navigator.connection?.type === 'cellular'
  } catch {
    return false
  }
}

function coarsePointer() {
  try {
    return window.matchMedia('(pointer: coarse)').matches
  } catch {
    return false
  }
}

// A reason the daemon gave in a few lowercase words, as a sentence.
function sentence(text) {
  const said = String(text ?? '').trim()
  if (!said) return ''
  const whole = said.charAt(0).toUpperCase() + said.slice(1)
  return /[.!?]$/.test(whole) ? whole : whole + '.'
}

function sameInfo(a, b) {
  return a.width === b.width && a.height === b.height && a.url === b.url && a.title === b.title && a.loading === b.loading
}

// The view. `device` is { id, name, platform }, `tab` the other device's id
// for it. `active` is false while something covers the view (the phone's
// tab grid): no pictures are asked for then. `onInfo` hears the page's
// address and title as pictures bring them; `onStop` is "Stop viewing".
export default function BrowserLiveView({ api, device, tab, title, active = true, onInfo, onStop }) {
  const stageRef = useRef(null)
  const canvasRef = useRef(null)
  const typingRef = useRef(null)
  const idRef = useRef(null)
  const frameRef = useRef(null)
  const controlRef = useRef(false)
  const [phase, setPhase] = useState('starting')
  const [message, setMessage] = useState('')
  const [info, setInfo] = useState({ width: 0, height: 0, url: '', title: '', loading: false })
  const [control, setControl] = useState(false)
  const [controller, setController] = useState(null)
  const [editable, setEditable] = useState(false)
  const [pinned, setPinned] = useState(false)
  const [hint, setHint] = useState('')
  const [stage, setStage] = useState({ width: 0, height: 0 })
  const [zoom, setZoom] = useState({ scale: 1, tx: 0, ty: 0 })
  const [restart, setRestart] = useState(0)
  const [seen, setSeen] = useState(() => !document.hidden)
  controlRef.current = control

  // Visible: the console's page is on screen (not a hidden window or a
  // backgrounded app) and the caller says nothing covers the view.
  useEffect(() => {
    const change = () => setSeen(!document.hidden)
    document.addEventListener('visibilitychange', change)
    return () => document.removeEventListener('visibilitychange', change)
  }, [])
  const streaming = active && seen

  // The stage's size, for fitting the picture and for the zoom's limits.
  useEffect(() => {
    const el = stageRef.current
    if (!el) return undefined
    const read = () => setStage({ width: el.clientWidth, height: el.clientHeight })
    read()
    const ro = new ResizeObserver(read)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  // ---- the stream ----

  const drawFrame = useCallback(async (data) => {
    const img = new Image()
    img.src = `data:image/jpeg;base64,${data}`
    try {
      await img.decode()
    } catch {
      return
    }
    const canvas = canvasRef.current
    if (!canvas) return
    if (canvas.width !== img.naturalWidth || canvas.height !== img.naturalHeight) {
      canvas.width = img.naturalWidth
      canvas.height = img.naturalHeight
    }
    canvas.getContext('2d', { alpha: false })?.drawImage(img, 0, 0)
  }, [])

  useEffect(() => {
    if (!api?.ready || !streaming) return undefined
    let stopped = false
    const abort = new AbortController()
    let id = null
    ;(async () => {
      setPhase('starting')
      setMessage('')
      let started
      try {
        started = await api.call(
          'POST',
          '/browser/live',
          {
            device: device.id,
            tab,
            network: cellular() ? 'cellular' : 'wifi',
            width: Math.round((stageRef.current?.clientWidth ?? 1000) * (window.devicePixelRatio || 1)),
          },
          { timeoutMs: 25_000, signal: abort.signal },
        )
      } catch (err) {
        if (!stopped) {
          setPhase('failed')
          setMessage(err?.message || "The tab couldn't be shown.")
        }
        return
      }
      id = started?.id ?? null
      if (stopped) {
        if (id) api.call('DELETE', `/browser/live/${id}`).catch(() => {})
        return
      }
      idRef.current = id
      setController(started?.controller ?? null)
      let after = 0
      let rev = 0
      let failures = 0
      while (!stopped) {
        let news
        try {
          news = await api.call('GET', `/browser/live/${id}/frame?after=${after}&rev=${rev}`, null, {
            timeoutMs: 20_000,
            signal: abort.signal,
          })
          failures = 0
        } catch (err) {
          if (stopped) return
          if (err?.status === 410) {
            setPhase('ended')
            setMessage(err.message || 'This live view ended.')
            return
          }
          failures += 1
          if (failures >= 4) {
            setPhase('failed')
            setMessage("The connection to this device didn't hold.")
            return
          }
          await new Promise((resolve) => setTimeout(resolve, 600 * failures))
          continue
        }
        if (!news) continue
        rev = news.rev ?? rev
        if (news.width > 0 && news.height > 0) frameRef.current = { width: news.width, height: news.height }
        const next = {
          width: news.width ?? frameRef.current?.width ?? 0,
          height: news.height ?? frameRef.current?.height ?? 0,
          url: news.url ?? '',
          title: news.title ?? '',
          loading: Boolean(news.loading),
        }
        setInfo((was) => (sameInfo(was, next) ? was : next))
        setControl(Boolean(news.control))
        setController(news.controller ?? null)
        setEditable(Boolean(news.editable))
        if (news.data) {
          after = news.seq
          await drawFrame(news.data)
          setPhase('live')
        }
      }
    })()
    return () => {
      stopped = true
      abort.abort()
      idRef.current = null
      setControl(false)
      setEditable(false)
      if (id) api.call('DELETE', `/browser/live/${id}`).catch(() => {})
    }
  }, [api, device.id, tab, streaming, restart, drawFrame])

  useEffect(() => {
    if (info.url || info.title) onInfo?.({ url: info.url, title: info.title, loading: info.loading })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [info.url, info.title, info.loading])

  // ---- input, sent in order ----

  const outbox = useRef({ queue: [], sending: false })
  const send = useCallback(
    (inputs) => {
      const box = outbox.current
      box.queue = coalesce([...box.queue, ...inputs])
      if (box.sending) return
      box.sending = true
      ;(async () => {
        while (box.queue.length) {
          const next = box.queue.shift()
          const id = idRef.current
          if (!id) {
            box.queue = []
            break
          }
          try {
            await api.call('POST', `/browser/live/${id}/input`, next, { timeoutMs: 8000 })
          } catch (err) {
            // Control moved elsewhere (or the view ended): what waits is
            // no longer ours to send.
            if (err?.status === 409 || err?.status === 410) {
              box.queue = []
              if (err.status === 409) setControl(false)
            }
          }
        }
        box.sending = false
      })()
    },
    [api],
  )

  const nudgeTimer = useRef(0)
  const nudge = useCallback((text) => {
    clearTimeout(nudgeTimer.current)
    setHint(text)
    nudgeTimer.current = setTimeout(() => setHint(''), 2600)
  }, [])
  useEffect(() => () => clearTimeout(nudgeTimer.current), [])

  const takeControl = async (take) => {
    const id = idRef.current
    if (!id) return
    try {
      const got = await api.call('POST', `/browser/live/${id}/control`, { take }, { timeoutMs: 15_000 })
      setControl(Boolean(got?.control))
      setController(got?.controller ?? null)
      if (got?.control && !coarsePointer()) typingRef.current?.focus({ preventScroll: true })
      if (!got?.control) {
        setPinned(false)
        typingRef.current?.blur()
      }
    } catch (err) {
      nudge(err?.message || "Control couldn't be taken.")
    }
  }

  // ---- where a point on screen is on the page ----

  const pagePoint = (point, clamp = false) => {
    const canvas = canvasRef.current
    const frame = frameRef.current
    if (!canvas || !frame) return null
    return toPage(point, canvas.getBoundingClientRect(), frame, { clamp })
  }

  // The page's pixels a pixel of the screen stands for.
  const pageScale = () => {
    const canvas = canvasRef.current
    const frame = frameRef.current
    const width = canvas?.getBoundingClientRect().width
    return frame && width > 0 ? frame.width / width : 1
  }

  const needControl = () => {
    if (controlRef.current) return false
    nudge('Take control to use this page')
    return true
  }

  // ---- touch: the gesture machine's actions ----

  const gesture = useRef(start())
  const holdTimer = useRef(0)
  const pinch = useRef({ base: { scale: 1, tx: 0, ty: 0 } })
  const flinging = useRef(0)
  const zoomRef = useRef(zoom)
  zoomRef.current = zoom
  const stageRect = () => stageRef.current?.getBoundingClientRect() ?? { left: 0, top: 0 }

  const stopFling = () => {
    clearTimeout(flinging.current)
    flinging.current = 0
  }

  const perform = (action, e) => {
    switch (action.kind) {
      case 'buzz':
        try {
          navigator.vibrate?.(12)
        } catch {
          /* no haptics here */
        }
        break
      case 'click': {
        if (needControl()) break
        const p = pagePoint(action)
        if (p) send([{ kind: 'click', ...p, button: action.button }])
        break
      }
      case 'scroll': {
        if (needControl()) break
        const p = pagePoint({ x: e.x, y: e.y }, true)
        if (!p) break
        const { dx, dy } = wheelFromDrag(action.dx, action.dy, pageScale())
        send([{ kind: 'wheel', ...p, dx, dy }])
        break
      }
      case 'fling': {
        if (!controlRef.current) break
        const p = pagePoint({ x: e.x, y: e.y }, true)
        if (!p) break
        const scale = pageScale()
        const steps = flingSteps(action.vx, action.vy)
        let at = 0
        const run = () => {
          const next = steps[at]
          at += 1
          if (!next || !controlRef.current) return
          const { dx, dy } = wheelFromDrag(next.dx, next.dy, scale)
          send([{ kind: 'wheel', ...p, dx, dy }])
          flinging.current = setTimeout(run, 16)
        }
        run()
        break
      }
      case 'down':
      case 'move':
      case 'up': {
        if (!controlRef.current) break
        const p = pagePoint(action, true)
        if (p) send([{ kind: action.kind, ...p }])
        break
      }
      case 'pinch': {
        const rect = stageRect()
        const local = (list) => list.map((q) => ({ x: q.x - rect.left, y: q.y - rect.top }))
        // The first move of a pinch finds the zoom as it was.
        if (pinch.current.base === null) pinch.current.base = zoomRef.current
        setZoom(pinchView(pinch.current.base, local(action.start), local(action.points), stage))
        break
      }
      default:
        break
    }
  }

  const run = (event) => {
    const { state, actions } = step(gesture.current, event)
    gesture.current = state
    for (const action of actions) perform(action, event)
  }

  // ---- mouse: pressed, dragged and released as it is ----

  const mouse = useRef({ down: false, last: null, clicks: 0 })
  // What kind of pointer touched the stage last: a long press on a touch
  // screen also raises a context menu event, which is not a right click.
  const lastKind = useRef('mouse')

  const onPointerDown = (e) => {
    stopFling()
    lastKind.current = e.pointerType
    // The view isn't a place that takes the focus: the hidden textarea
    // keeps it (and with it a phone's keyboard) through a tap or a drag.
    e.preventDefault()
    if (e.pointerType === 'mouse') {
      if (e.button !== 0) return
      if (needControl()) return
      const p = pagePoint({ x: e.clientX, y: e.clientY }, true)
      if (!p) return
      e.currentTarget.setPointerCapture(e.pointerId)
      const last = mouse.current.last
      const again =
        last && e.timeStamp - last.t < DOUBLE_MS && Math.hypot(last.x - e.clientX, last.y - e.clientY) < DOUBLE_NEAR
      const clicks = again ? Math.min(3, mouse.current.clicks + 1) : 1
      mouse.current = { down: true, last: { x: e.clientX, y: e.clientY, t: e.timeStamp }, clicks }
      send([{ kind: 'down', ...p, clicks }])
      return
    }
    e.currentTarget.setPointerCapture(e.pointerId)
    if (Object.keys(gesture.current.pointers).length === 0) {
      clearTimeout(holdTimer.current)
      holdTimer.current = setTimeout(() => run({ type: 'hold', id: e.pointerId, t: performance.now() }), HOLD_MS)
    }
    pinch.current.base = null
    run({ type: 'down', id: e.pointerId, x: e.clientX, y: e.clientY, t: e.timeStamp })
  }

  const onPointerMove = (e) => {
    if (e.pointerType === 'mouse') {
      if (!mouse.current.down || !controlRef.current) return
      const p = pagePoint({ x: e.clientX, y: e.clientY }, true)
      if (p) send([{ kind: 'move', ...p }])
      return
    }
    run({ type: 'move', id: e.pointerId, x: e.clientX, y: e.clientY, t: e.timeStamp })
  }

  const finish = (e, kind) => {
    if (e.pointerType === 'mouse') {
      if (!mouse.current.down) return
      mouse.current.down = false
      const p = pagePoint({ x: e.clientX, y: e.clientY }, true)
      if (p && controlRef.current) send([{ kind: 'up', ...p, clicks: mouse.current.clicks }])
      // The hidden textarea keeps the keyboard.
      if (controlRef.current && !coarsePointer()) typingRef.current?.focus({ preventScroll: true })
      return
    }
    clearTimeout(holdTimer.current)
    run({ type: kind, id: e.pointerId, x: e.clientX, y: e.clientY, t: e.timeStamp })
    // A tap on a touch screen is where the keyboard may come up: the
    // page says in a moment whether a field took the focus.
    if (kind === 'up' && Object.keys(gesture.current.pointers).length === 0) tapped.current = performance.now()
  }

  // When a tap was last, for raising the keyboard while the tap still
  // counts as the user's doing.
  const tapped = useRef(0)

  const onWheel = (e) => {
    if (!controlRef.current) return
    const p = pagePoint({ x: e.clientX, y: e.clientY }, true)
    if (!p) return
    const { dx, dy } = wheelPixels(e)
    send([{ kind: 'wheel', ...p, dx, dy }])
  }

  const onContextMenu = (e) => {
    e.preventDefault()
    if (!controlRef.current || lastKind.current !== 'mouse') return
    const p = pagePoint({ x: e.clientX, y: e.clientY })
    if (p) send([{ kind: 'click', ...p, button: 'right' }])
  }

  // ---- typing ----

  const typed = useRef(SENTINEL)
  const composing = useRef(false)

  const resetTyping = () => {
    const el = typingRef.current
    if (!el) return
    el.value = SENTINEL
    typed.current = SENTINEL
    try {
      el.setSelectionRange(SENTINEL.length, SENTINEL.length)
    } catch {
      /* not focused: the caret goes to the end by itself */
    }
  }

  useEffect(() => {
    resetTyping()
  }, [])

  const onKeyDown = (e) => {
    if (!controlRef.current) return
    const name = keyName(e, { mac: isMac })
    if (!name) return
    e.preventDefault()
    send([{ kind: 'key', key: name }])
  }

  const onTyped = (e) => {
    if (!controlRef.current) {
      resetTyping()
      return
    }
    const edits = textEdits(typed.current, e.currentTarget.value)
    typed.current = e.currentTarget.value
    if (edits.length) send(edits)
    // A composing keyboard keeps its word in the box until it commits it.
    if (!composing.current && !e.nativeEvent.isComposing) resetTyping()
  }

  // The page has a field focused that takes typing: the keyboard comes up
  // (right after a tap it still counts as the user's own doing; else the
  // Keyboard button does it), and goes when the field is left.
  useEffect(() => {
    const el = typingRef.current
    if (!el || !control) return
    if (editable) {
      if (performance.now() - tapped.current < 4000 || pinned) el.focus({ preventScroll: true })
    } else if (!pinned && coarsePointer()) {
      el.blur()
    }
  }, [editable, control, pinned])

  const toggleKeyboard = () => {
    const el = typingRef.current
    if (!el) return
    if (document.activeElement === el) {
      setPinned(false)
      el.blur()
    } else {
      setPinned(true)
      el.focus({ preventScroll: true })
    }
  }

  // ---- drawing ----

  const frame = info.width > 0 && info.height > 0 ? { width: info.width, height: info.height } : null
  const box = frame ? fit(stage, frame) : { x: 0, y: 0, width: 0, height: 0 }
  const view = clampView(zoom, stage)
  const zoomed = view.scale > 1.001
  const name = device.name || 'Another device'
  const pageTitle = info.title || title || ''
  const others = controller && !control ? controller : null

  return (
    <div className="bl">
      <div className="bl-head">
        <div className="bl-where">
          <span className={`bl-live${phase === 'live' ? ' on' : ''}`} title={phase === 'live' ? 'Live' : 'Connecting'}>
            <span className="bl-dot" />
            <span className="bl-live-word">{phase === 'live' ? 'Live' : phase === 'starting' ? 'Connecting' : 'Stopped'}</span>
          </span>
          <DeviceIcon platform={device.platform} size={15} className="bl-device" />
          <span className="bl-names">
            <strong className="bl-device-name pv">{name}</strong>
            {pageTitle && <span className="bl-title pv">{pageTitle}</span>}
          </span>
        </div>
        <div className="bl-actions">
          {control && (
            <button
              type="button"
              className={`bl-btn icon${editable || pinned ? ' on' : ''}`}
              aria-label="Keyboard"
              title="Keyboard"
              onClick={toggleKeyboard}
            >
              <Keyboard size={17} />
            </button>
          )}
          {zoomed && (
            <button type="button" className="bl-btn" onClick={() => setZoom({ scale: 1, tx: 0, ty: 0 })}>
              {Math.round(view.scale * 100)}%
            </button>
          )}
          {control ? (
            <button type="button" className="bl-btn" onClick={() => takeControl(false)}>
              Release control
            </button>
          ) : (
            <button
              type="button"
              className="bl-btn primary"
              disabled={phase !== 'live'}
              onClick={() => takeControl(true)}
            >
              <CursorClick size={15} />
              Take control
            </button>
          )}
          {onStop && (
            <button type="button" className="bl-btn" onClick={onStop}>
              <X size={14} />
              Stop viewing
            </button>
          )}
        </div>
      </div>
      {others && (
        <div className="bl-note" role="status">
          <strong className="pv">{others}</strong> has control of this tab
        </div>
      )}

      <div
        ref={stageRef}
        className="bl-stage"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={(e) => finish(e, 'up')}
        onPointerCancel={(e) => finish(e, 'cancel')}
        onWheel={onWheel}
        onContextMenu={onContextMenu}
      >
        <div
          className="bl-zoom"
          style={{ transform: `translate(${view.tx}px, ${view.ty}px) scale(${view.scale})` }}
        >
          <canvas
            ref={canvasRef}
            className="bl-canvas"
            style={{
              left: `${box.x}px`,
              top: `${box.y}px`,
              width: `${box.width}px`,
              height: `${box.height}px`,
              visibility: frame ? 'visible' : 'hidden',
            }}
          />
        </div>
        {phase === 'starting' && !frame && <div className="bl-cover quiet">Opening {name}'s tab</div>}
        {(phase === 'ended' || phase === 'failed') && (
          <div className="bl-cover" role="status">
            <p>{sentence(message) || 'This live view ended.'}</p>
            {message !== 'the tab was closed' && (
              <button type="button" className="bl-btn primary" onClick={() => setRestart((n) => n + 1)}>
                Show again
              </button>
            )}
          </div>
        )}
        {hint && <div className="bl-hint">{hint}</div>}
        <textarea
          ref={typingRef}
          className="bl-keys"
          defaultValue={SENTINEL}
          aria-label="Type into the page"
          autoCapitalize="off"
          autoComplete="off"
          autoCorrect="off"
          spellCheck={false}
          enterKeyHint="enter"
          onKeyDown={onKeyDown}
          onInput={onTyped}
          onCompositionStart={() => {
            composing.current = true
          }}
          onCompositionEnd={() => {
            composing.current = false
            resetTyping()
          }}
          onBlur={() => {
            if (!coarsePointer()) return
            setPinned(false)
          }}
        />
      </div>
    </div>
  )
}
