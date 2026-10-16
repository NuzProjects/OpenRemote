// The built-in browser on a phone: Chrome Android's arrangement in the
// app's colours. A top bar (home, the address, the tab count, the menu)
// that slides away as the page scrolls down and comes back as it scrolls
// up, a tab grid with a Private section, the menu's pages (history,
// downloads, bookmarks, settings) and the address bar's suggestions.
//
// Each page is a native view the Android shell lays over this view's
// placeholder (src-tauri/src/mobile_browser.rs and its Kotlin plugin). A
// native view always draws above the console, so whatever of the console
// covers the page either hides it (the full-screen pages) or shows the
// page's picture in its place while the page waits out of sight (the menu,
// a link's menu). The tabs live in browser-store.js, shared with the
// desktop's view; the history, bookmarks and settings are the daemon's.

import { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react'
import {
  ArrowClockwise,
  ArrowLeft,
  ArrowRight,
  ArrowSquareOut,
  BookmarkSimple,
  CaretDown,
  CaretUp,
  Check,
  ClockCounterClockwise,
  Copy,
  Desktop,
  Detective,
  DotsThreeVertical,
  DownloadSimple,
  GearSix,
  Globe,
  House,
  Image as ImageIcon,
  Link as LinkIcon,
  Lock,
  MagnifyingGlass,
  Plus,
  ShareNetwork,
  Star,
  Trash,
  Warning,
  WarningCircle,
  X,
} from '@phosphor-icons/react'
import { hasTauri } from './platform.js'
import { SEARCH_ENGINES, omnibox, searchUrl, security } from './browser-omnibox.js'
import { closeTab, newTab, tabTitle } from './browser-tabs.js'
import { adopt, call, getState, patchTab, setState, subscribe } from './browser-store.js'
import { fileName } from './browser-chrome.js'
import { useConsole } from './state/console.jsx'
import { useBack } from './use-back.js'
import './browser-phone.css'

// The tab grid's pictures, at most this many CSS pixels wide.
const THUMB = 360

// The saved tabs come back once per app run, the first time the browser opens.
let restored = false

// A box on whole device pixels: its edges rounded, not its size, so the
// native page meets the console's own pixels exactly.
function snap(box) {
  const dpr = window.devicePixelRatio || 1
  const px = (v) => Math.round(v * dpr) / dpr
  const x = px(box.x)
  const y = px(box.y)
  return { x, y, width: px(box.x + box.width) - x, height: px(box.y + box.height) - y }
}

// Resolves after `n` frames have been painted.
function frames(n) {
  return new Promise((resolve) => {
    const step = (left) => (left ? requestAnimationFrame(() => step(left - 1)) : resolve())
    step(n)
  })
}

function hostOf(url) {
  try {
    return new URL(url).host.replace(/^www\./, '')
  } catch {
    return ''
  }
}

// Reduced motion, either way it is asked for: the page's bar then snaps.
function still() {
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches || document.documentElement.hasAttribute('data-reduce-motion')
  } catch {
    return false
  }
}

// A site's first letter, standing in for its icon (the console shows no
// images from the web).
function initial(url, title) {
  return (hostOf(url) || title || '?').charAt(0).toUpperCase()
}

function dayOf(at) {
  const day = new Date(at)
  const today = new Date()
  const start = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
  const diff = Math.round((start(today) - start(day)) / 86400000)
  if (diff === 0) return 'Today'
  if (diff === 1) return 'Yesterday'
  return day.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' })
}

function timeOf(at) {
  return new Date(at).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
}

function sizeOf(bytes) {
  if (!(bytes > 0)) return ''
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    // An older webview: the textarea way.
    const area = document.createElement('textarea')
    area.value = text
    area.style.position = 'fixed'
    area.style.opacity = '0'
    document.body.appendChild(area)
    area.select()
    const done = document.execCommand('copy')
    area.remove()
    return done
  }
}

// A shell event while the view is up, with the newest handler.
function useShellEvent(name, handler) {
  const latest = useRef(handler)
  latest.current = handler
  useEffect(() => {
    if (!hasTauri) return undefined
    let off = null
    let gone = false
    import('@tauri-apps/api/event')
      .then(({ listen }) => listen(name, (e) => latest.current(e.payload)))
      .then((unlisten) => {
        if (gone) unlisten()
        else off = unlisten
      })
      .catch(() => {})
    return () => {
      gone = true
      off?.()
    }
  }, [name])
}

// ---- the view ----

export default function BrowserPhone() {
  const { api } = useConsole()
  const { tabs, active, downloads, finds, asks, pending } = useSyncExternalStore(subscribe, getState)
  const current = tabs.find((t) => t.key === active) ?? tabs[0]
  const [surface, setSurface] = useState(null)
  const [editing, setEditing] = useState(false)
  const [menu, setMenu] = useState(false)
  const [context, setContext] = useState(null)
  const [finding, setFinding] = useState(false)
  const [findTerm, setFindTerm] = useState('')
  const [data, setData] = useState(null)
  const [note, setNote] = useState(null)
  const [thumbs, setThumbs] = useState({})
  const pageRef = useRef(null)
  const barRef = useRef(null)
  const pictureRef = useRef(null)
  const shownNative = useRef(null)
  const parked = useRef(false)
  const findingRef = useRef(false)
  findingRef.current = finding
  const covered = Boolean(surface || editing)
  const coveredRef = useRef(covered)
  coveredRef.current = covered

  const engine = SEARCH_ENGINES[data?.settings?.search] ? data.settings.search : 'google'
  const engineName = SEARCH_ENGINES[engine].name
  const activeTab = () => getState().tabs.find((t) => t.key === getState().active)

  const refresh = useCallback(async () => {
    if (!api?.ready) return null
    try {
      const next = await api.call('GET', '/browser')
      setData(next)
      return next
    } catch {
      return null
    }
  }, [api])
  useEffect(() => {
    refresh()
  }, [refresh])

  const noteTimer = useRef(0)
  const say = (text) => {
    clearTimeout(noteTimer.current)
    setNote(text)
    noteTimer.current = setTimeout(() => setNote(null), 2600)
  }
  useEffect(() => () => clearTimeout(noteTimer.current), [])

  // ---- where the page sits ----

  // The placeholder in CSS pixels, with what the phone's shell needs: how
  // far the page may slide up under the bar, the screen's scale, whether
  // motion is wanted, and whether Android's back belongs to the page.
  const rect = () => {
    const r = pageRef.current?.getBoundingClientRect()
    if (!r || r.width <= 0 || r.height <= 0) return null
    return {
      ...snap({ x: r.left, y: r.top, width: r.width, height: r.height }),
      bar: findingRef.current ? 0 : (barRef.current?.offsetHeight ?? 0),
      scale: window.devicePixelRatio || 1,
      still: still(),
      back: !findingRef.current,
    }
  }

  const syncBounds = () => {
    const tab = shownNative.current
    const bounds = rect()
    // While a menu covers the page it waits far out of view, the same size.
    if (tab && bounds) call('browser_set_bounds', { tab, bounds: parked.current ? { ...bounds, x: -30000 } : bounds })
  }

  // The page on screen: the active tab's, unless a full-screen page of the
  // console covers it or the tab shows the new tab page.
  const wanted = !covered && current?.native && !current.home ? current.native : null
  useLayoutEffect(() => {
    if (!hasTauri) return
    const before = shownNative.current
    shownNative.current = wanted
    if (barRef.current) barRef.current.style.transform = ''
    ;(async () => {
      if (before && before !== wanted) await call('browser_hide', { tab: before })
      const bounds = rect()
      if (wanted && bounds) {
        await call('browser_set_bounds', { tab: wanted, bounds })
        await call('browser_show', { tab: wanted, focus: false })
      }
    })()
  }, [wanted])

  // Leaving the view hides the page; the tab stays.
  useEffect(
    () => () => {
      const shown = shownNative.current
      shownNative.current = null
      if (shown) call('browser_hide', { tab: shown })
    },
    [],
  )

  // The page follows the placeholder: the keyboard, a rotation, the bar's
  // own rows coming and going.
  useEffect(() => {
    if (!hasTauri) return undefined
    let frame = 0
    const sync = () => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(syncBounds)
    }
    const ro = new ResizeObserver(sync)
    if (pageRef.current) ro.observe(pageRef.current)
    if (barRef.current) ro.observe(barRef.current)
    window.addEventListener('resize', sync)
    return () => {
      cancelAnimationFrame(frame)
      ro.disconnect()
      window.removeEventListener('resize', sync)
    }
  }, [])

  useEffect(() => {
    syncBounds()
  }, [finding])

  // The bar slides as the page scrolls: the shell says how far, once a frame.
  useShellEvent('browser:chrome', (p) => {
    if (p.tab !== shownNative.current || !barRef.current) return
    barRef.current.style.transform = p.offset > 0 ? `translateY(${-p.offset}px)` : ''
  })

  // A long press on a link or a picture in the page.
  useShellEvent('browser:context', (p) => {
    if (p.tab === shownNative.current) setContext(p)
  })

  // The menu or a link's menu over the page: the page's picture is decoded
  // and shown first, and only then does the page step out of view; when the
  // menu closes the page steps back and the picture goes a moment later.
  const overlay = Boolean(menu || context)
  const swapped = useRef(false)
  useEffect(() => {
    if (!hasTauri) return undefined
    let stale = false
    ;(async () => {
      const picture = pictureRef.current
      if (overlay && !swapped.current) {
        const tab = shownNative.current
        if (!tab) return
        swapped.current = true
        const url = await call('browser_capture', { tab })
        if (stale) return
        if (url && picture) {
          if (picture.getAttribute('src') !== url) picture.src = url
          await picture.decode().catch(() => {})
          picture.classList.add('on')
          await frames(2)
        }
        parked.current = true
        syncBounds()
      } else if (!overlay && swapped.current) {
        swapped.current = false
        parked.current = false
        syncBounds()
        await frames(3)
        picture?.classList.remove('on')
      }
    })()
    return () => {
      stale = true
    }
  }, [overlay])

  // ---- going places ----

  // Opens what was typed (an address, or a search) in the active tab, or a
  // new one; a tab without a page gets one here.
  const go = async (line, { fresh = false, private: priv } = {}) => {
    const url = omnibox(line, engine)
    if (!url) return
    setEditing(false)
    setSurface(null)
    let tab = activeTab()
    if (fresh || !tab) {
      tab = newTab({ private: priv ?? false })
      const made = tab
      setState((s) => ({ tabs: [...s.tabs, made], active: made.key }))
    }
    if (tab.native) {
      patchTab(tab.key, { home: false })
      await call('browser_navigate', { tab: tab.native, url })
      return
    }
    patchTab(tab.key, { url, loading: true, home: false, restore: false })
    await frames(2)
    const bounds = rect() ?? { x: 0, y: 0, width: 0, height: 0 }
    const native = await call('browser_open', { url, bounds, show: !coveredRef.current, private: Boolean(tab.private) })
    if (native) adopt(tab.key, native)
  }

  const openNewTab = (priv) => {
    const tab = newTab({ private: priv })
    setState((s) => ({ tabs: [...s.tabs, tab], active: tab.key }))
    setSurface(null)
    setMenu(false)
  }

  // Closes a tab; `then` is the tab to show after (the opener, going back).
  const close = (key, then = null) => {
    const tab = getState().tabs.find((t) => t.key === key)
    if (tab?.native) call('browser_close', { tab: tab.native })
    setState((s) => {
      const next = closeTab(s.tabs, key, s.active)
      const url = next.closed?.private ? null : next.closed?.url
      const show = then && next.tabs.some((t) => t.key === then) ? then : next.active
      return { tabs: next.tabs, active: show, closed: url ? [url, ...s.closed].slice(0, 25) : s.closed }
    })
  }

  const goHome = () => {
    const tab = activeTab()
    if (tab?.native) patchTab(tab.key, { home: true })
  }

  // An address another part of the app asked the browser to open.
  useEffect(() => {
    if (!pending) return
    setState(() => ({ pending: null }))
    go(pending, { fresh: true })
  }, [pending])

  // The tabs open at the last run come back (not private ones), each
  // loading only when it is shown; a setting can turn that off.
  useEffect(() => {
    if (restored || !data) return
    restored = true
    if (data.settings?.restore === false) return
    const saved = Array.isArray(data.session?.tabs) ? data.session.tabs : []
    const s = getState()
    const fresh = s.tabs.length === 1 && !s.tabs[0].native && !s.tabs[0].url
    const list = saved
      .filter((t) => typeof t?.url === 'string' && t.url)
      .slice(0, 50)
      .map((t) => newTab({ url: t.url, title: t.title ?? '', restore: true }))
    if (!fresh || !list.length) return
    const at = Math.min(Math.max(0, Number(data.session.active) || 0), list.length - 1)
    setState(() => ({ tabs: list, active: list[at].key }))
  }, [data])

  useEffect(() => {
    if (!current || current.native || !current.restore || covered) return
    go(current.url)
  }, [current?.key, covered])

  // What to bring back next time: the normal tabs' addresses.
  useEffect(() => {
    if (!api?.ready || !restored) return undefined
    const timer = setTimeout(() => {
      const list = tabs.filter((t) => !t.private && t.url && t.url !== 'about:blank')
      const at = Math.max(0, list.findIndex((t) => t.key === active))
      api
        .call('POST', '/browser/session', { tabs: list.map((t) => ({ url: t.url, title: t.title ?? '' })), active: at })
        .catch(() => {})
    }, 1500)
    return () => clearTimeout(timer)
  }, [tabs, active, api])

  // ---- sites' requests ----

  const answer = async (ask, allow, remember) => {
    setState((s) => ({ asks: s.asks.filter((x) => x.id !== ask.id) }))
    try {
      const { invoke } = await import('@tauri-apps/api/core')
      await invoke('browser_permission', { tab: ask.tab, id: ask.id, allow })
    } catch (e) {
      // The phone itself said no to the app: say so.
      say(String(e?.message ?? e))
    }
    if (remember && api?.ready) {
      for (const kind of String(ask.kind).split(',')) {
        await api.call('POST', '/browser/permissions', { origin: ask.origin, kind, state: allow ? 'allow' : 'deny' }).catch(() => {})
      }
      refresh()
    }
  }

  // A site the person already answered gets the same answer again.
  useEffect(() => {
    const remembered = data?.permissions
    if (!remembered) return
    for (const ask of asks) {
      const states = String(ask.kind)
        .split(',')
        .map((kind) => remembered[`${ask.origin}|${kind}`])
      if (states.every((s) => s === 'allow')) answer(ask, true, false)
      else if (states.some((s) => s === 'deny')) answer(ask, false, false)
    }
  }, [asks, data?.permissions])

  const ask = asks.find((a) => a.tab === current?.native && !data?.permissions?.[`${a.origin}|${String(a.kind).split(',')[0]}`])

  // ---- find in page ----

  const runFind = (term, step) => {
    const native = activeTab()?.native
    if (native) call('browser_find', { tab: native, term, step })
  }

  const openFind = () => {
    setMenu(false)
    if (!activeTab()?.native) return
    setFindTerm('')
    setFinding(true)
  }

  const closeFind = () => {
    setFinding(false)
    setFindTerm('')
    const native = activeTab()?.native
    if (native) call('browser_find', { tab: native, term: '', step: 0 })
  }

  // ---- back ----

  // Android's back goes to the page's own history first (the shell answers
  // it while the page is plainly in view), then here: whatever is open,
  // then a tab another tab opened goes back to its opener; then the app's
  // own back leaves the browser for the chat.
  const opener = current?.opener ? tabs.find((t) => t.native === current.opener) : null
  useBack(Boolean(surface), () => setSurface(null))
  useBack(editing, () => setEditing(false))
  useBack(menu, () => setMenu(false))
  useBack(Boolean(context), () => setContext(null))
  useBack(finding, closeFind)
  useBack(Boolean(current?.home), () => {
    const tab = activeTab()
    if (tab) patchTab(tab.key, { home: false })
  })
  useBack(Boolean(opener) && !covered && !finding && !menu && !context && !current?.home, () => {
    const s = getState()
    const tab = s.tabs.find((t) => t.key === s.active)
    const back = tab?.opener ? s.tabs.find((t) => t.native === tab.opener) : null
    if (tab && back) close(tab.key, back.key)
  })

  // ---- the tab grid ----

  const openGrid = async () => {
    // The page on screen is pictured before the grid hides it.
    const shown = shownNative.current
    if (shown) {
      const url = await call('browser_capture', { tab: shown, max: THUMB })
      if (url) setThumbs((m) => ({ ...m, [shown]: url }))
    }
    setSurface('tabs')
  }

  useEffect(() => {
    if (surface !== 'tabs' || !hasTauri) return undefined
    let stale = false
    ;(async () => {
      for (const t of getState().tabs) {
        if (stale) return
        if (!t.native) continue
        const url = await call('browser_capture', { tab: t.native, max: THUMB })
        if (url && !stale) setThumbs((m) => ({ ...m, [t.native]: url }))
      }
    })()
    return () => {
      stale = true
    }
  }, [surface])

  // ---- what the menus do ----

  const live = Boolean(current?.native) && !current?.home
  const bookmark = data?.bookmarks?.find((b) => b.url === current?.url)

  const toggleBookmark = async () => {
    setMenu(false)
    if (!api?.ready || !current?.url) return
    if (bookmark) await api.call('POST', `/browser/bookmarks/${encodeURIComponent(bookmark.id)}/remove`).catch(() => {})
    else await api.call('POST', '/browser/bookmarks', { url: current.url, title: current.title ?? '' }).catch(() => {})
    say(bookmark ? 'Bookmark removed' : 'Bookmarked')
    refresh()
  }

  const control = async (action) => {
    if (!api?.ready || !current?.native) return
    await api.call('POST', `/browser/tabs/${encodeURIComponent(current.native)}/control`, { action }).catch(() => {})
  }

  const share = () => {
    setMenu(false)
    if (live) call('browser_share', { tab: current.native, title: current.title })
  }

  const contextAction = async (what) => {
    const c = context
    setContext(null)
    if (!c) return
    const target = c.link ?? c.url
    if (what === 'open') go(target, { fresh: true, private: Boolean(current?.private) })
    else if (what === 'private') go(target, { fresh: true, private: true })
    else if (what === 'image') go(c.url, { fresh: true, private: Boolean(current?.private) })
    else if (what === 'copy') say((await copyText(target)) ? 'Link copied' : "The link couldn't be copied")
    else if (what === 'copy-image') say((await copyText(c.url)) ? 'Picture address copied' : "The address couldn't be copied")
    else if (what === 'share') call('browser_share', { url: target })
    else if (what === 'download') {
      call('browser_download', { tab: c.tab, url: c.kind === 'image' ? c.url : target })
      say('Downloading')
    }
  }

  // ---- drawing ----

  const findState = (current?.native && finds[current.native]) || null
  const lock = security(current?.url)
  const host = hostOf(current?.url ?? '')
  const sameMode = tabs.filter((t) => Boolean(t.private) === Boolean(current?.private))
  const controller = live ? current?.controller : null
  const loading = live && current?.loading

  return (
    <div className={`bp${current?.private ? ' private' : ''}`}>
      <header className="bp-bar" ref={barRef}>
        {finding ? (
          <div className="bp-top bp-find">
            <MagnifyingGlass size={18} className="bp-find-icon" />
            <input
              className="bp-find-input"
              value={findTerm}
              placeholder="Find in page"
              spellCheck={false}
              autoFocus
              enterKeyHint="search"
              onChange={(e) => {
                setFindTerm(e.target.value)
                runFind(e.target.value, 0)
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault()
                  runFind(findTerm, 1)
                }
              }}
            />
            <span className="bp-find-count">
              {findTerm ? (findState?.count ? `${findState.active}/${findState.count}` : '0/0') : ''}
            </span>
            <button type="button" className="bp-icon" aria-label="Previous match" onClick={() => runFind(findTerm, -1)}>
              <CaretUp size={20} />
            </button>
            <button type="button" className="bp-icon" aria-label="Next match" onClick={() => runFind(findTerm, 1)}>
              <CaretDown size={20} />
            </button>
            <button type="button" className="bp-icon" aria-label="Close find in page" onClick={closeFind}>
              <X size={20} />
            </button>
          </div>
        ) : (
          <div className="bp-top">
            <button type="button" className="bp-icon" aria-label="Home" disabled={!live} onClick={goHome}>
              <House size={22} />
            </button>
            <button type="button" className="bp-address" onClick={() => setEditing(true)}>
              {current?.private && <Detective size={17} className="bp-address-private" />}
              {live &&
                (lock === 'insecure' ? (
                  <Warning size={16} className="bp-address-warn" />
                ) : lock === 'none' ? (
                  <Globe size={16} className="bp-address-lock" />
                ) : (
                  <Lock size={16} className="bp-address-lock" />
                ))}
              <span className={`bp-address-text${live ? '' : ' quiet'}`}>
                {live ? host || current.url : 'Search or type a web address'}
              </span>
            </button>
            <button type="button" className="bp-count" aria-label={`${sameMode.length} open tabs`} onClick={openGrid}>
              <span>{sameMode.length > 99 ? '99+' : sameMode.length}</span>
            </button>
            <button type="button" className="bp-icon" aria-label="More" onClick={() => setMenu(true)}>
              <DotsThreeVertical size={22} weight="bold" />
            </button>
          </div>
        )}
        {loading && <div className="bp-progress" style={{ width: `${Math.max(8, current.progress ?? 10)}%` }} />}
        {controller && (
          <div className="bp-agent">
            <span className={`bp-agent-dot${controller.kind === 'paused' ? ' paused' : ''}`} />
            <span className="bp-agent-text">
              {controller.kind === 'paused'
                ? `You took over from "${controller.title}"`
                : `"${controller.title}" is using this tab`}
            </span>
            <button type="button" className="bp-agent-btn" onClick={() => control(controller.kind === 'paused' ? 'hand_back' : 'take_over')}>
              {controller.kind === 'paused' ? 'Hand back' : 'Take over'}
            </button>
          </div>
        )}
      </header>

      {live && current.problem && (
        <div className="bp-infobar">
          <WarningCircle size={18} className="bp-infobar-icon" />
          <span>{current.problem}</span>
        </div>
      )}

      <div className="bp-page" ref={pageRef}>
        <img ref={pictureRef} className="bp-picture" alt="" />
        {(!current?.native || current.home) && (
          <NewTabPage
            api={api}
            engineName={engineName}
            isPrivate={Boolean(current?.private)}
            isolated={current?.isolated}
            onGo={(line) => go(line)}
            onSearch={() => setEditing(true)}
          />
        )}
        {current?.native && !current.home && current.crashed && (
          <div className="bp-crash">
            <WarningCircle size={30} />
            <p className="bp-crash-title">This page stopped working</p>
            <p className="bp-crash-text">Its content was too much for the phone, or it crashed. Reloading starts it again.</p>
            <button type="button" className="bp-button primary" onClick={() => call('browser_reload', { tab: current.native })}>
              Reload
            </button>
          </div>
        )}
      </div>

      {ask && (
        <div className="bp-ask">
          <p className="bp-ask-text">
            <strong>{hostOf(ask.origin) || ask.origin}</strong> wants to {ask.label}
          </p>
          <div className="bp-ask-actions">
            <button type="button" className="bp-button" onClick={() => answer(ask, false, true)}>
              Block
            </button>
            <button type="button" className="bp-button primary" onClick={() => answer(ask, true, true)}>
              Allow
            </button>
          </div>
        </div>
      )}

      {note && <div className="bp-note">{note}</div>}

      {editing && (
        <Omnibox
          api={api}
          engine={engine}
          current={live ? current : null}
          onGo={(line) => go(line)}
          onClose={() => setEditing(false)}
          onCopied={(ok) => say(ok ? 'Link copied' : "The link couldn't be copied")}
          onShare={() => {
            setEditing(false)
            if (live) call('browser_share', { tab: current.native, title: current.title })
          }}
        />
      )}

      {surface === 'tabs' && (
        <TabGrid
          tabs={tabs}
          active={active}
          thumbs={thumbs}
          onPick={(key) => {
            setState(() => ({ active: key }))
            setSurface(null)
          }}
          onClose={(key) => close(key)}
          onNew={openNewTab}
          onDone={() => setSurface(null)}
        />
      )}
      {surface === 'history' && (
        <HistoryPage
          api={api}
          onOpen={(url) => go(url)}
          onClose={() => setSurface(null)}
          onClearData={() => setSurface('settings')}
        />
      )}
      {surface === 'downloads' && <DownloadsPage downloads={downloads} onClose={() => setSurface(null)} />}
      {surface === 'bookmarks' && (
        <BookmarksPage api={api} bookmarks={data?.bookmarks ?? []} onOpen={(url) => go(url)} onChanged={refresh} onClose={() => setSurface(null)} />
      )}
      {surface === 'settings' && (
        <SettingsPage api={api} data={data} onChanged={refresh} onDone={(text) => say(text)} onClose={() => setSurface(null)} />
      )}

      {menu && (
        <div className="bp-menu-backdrop" onClick={() => setMenu(false)}>
          <div className="bp-menu" role="menu" onClick={(e) => e.stopPropagation()}>
            <div className="bp-menu-top">
              <button
                type="button"
                className="bp-icon"
                aria-label="Forward"
                disabled={!live || !current.canForward}
                onClick={() => {
                  setMenu(false)
                  call('browser_forward', { tab: current.native })
                }}
              >
                <ArrowRight size={20} />
              </button>
              <button type="button" className="bp-icon" aria-label={bookmark ? 'Remove bookmark' : 'Bookmark this page'} disabled={!live} onClick={toggleBookmark}>
                <Star size={20} weight={bookmark ? 'fill' : 'regular'} className={bookmark ? 'bp-starred' : ''} />
              </button>
              <button
                type="button"
                className="bp-icon"
                aria-label={loading ? 'Stop loading' : 'Reload'}
                disabled={!live}
                onClick={() => {
                  setMenu(false)
                  call(loading ? 'browser_stop' : 'browser_reload', { tab: current.native })
                }}
              >
                {loading ? <X size={20} /> : <ArrowClockwise size={20} />}
              </button>
            </div>
            <MenuItem icon={<Plus size={18} />} label="New tab" onSelect={() => openNewTab(false)} />
            <MenuItem icon={<Detective size={18} />} label="New private tab" onSelect={() => openNewTab(true)} />
            <div className="bp-menu-sep" />
            <MenuItem
              icon={<ClockCounterClockwise size={18} />}
              label="History"
              onSelect={() => {
                setMenu(false)
                setSurface('history')
              }}
            />
            <MenuItem
              icon={<DownloadSimple size={18} />}
              label="Downloads"
              hint={downloads.some((d) => d.state === 'started') ? 'Downloading' : ''}
              onSelect={() => {
                setMenu(false)
                setSurface('downloads')
              }}
            />
            <MenuItem
              icon={<BookmarkSimple size={18} />}
              label="Bookmarks"
              onSelect={() => {
                setMenu(false)
                setSurface('bookmarks')
              }}
            />
            <div className="bp-menu-sep" />
            <MenuItem icon={<ShareNetwork size={18} />} label="Share" disabled={!live} onSelect={share} />
            <MenuItem icon={<MagnifyingGlass size={18} />} label="Find in page" disabled={!live} onSelect={openFind} />
            <MenuItem
              icon={<Desktop size={18} />}
              label="Desktop site"
              checked={Boolean(current?.desktop)}
              disabled={!live}
              onSelect={() => {
                setMenu(false)
                call('browser_desktop_site', { tab: current.native, on: !current.desktop })
              }}
            />
            {current?.private && (
              <MenuItem
                icon={<Detective size={18} />}
                label="Let agents use this tab"
                checked={Boolean(current.shared)}
                disabled={!live}
                onSelect={() => {
                  setMenu(false)
                  call('browser_share_with_agents', { tab: current.native, shared: !current.shared })
                }}
              />
            )}
            <MenuItem
              icon={<ArrowSquareOut size={18} />}
              label="Open in another browser"
              disabled={!live || !/^https?:/.test(current?.url ?? '')}
              onSelect={() => {
                setMenu(false)
                call('browser_open_external', { url: current.url })
              }}
            />
            <div className="bp-menu-sep" />
            <MenuItem
              icon={<GearSix size={18} />}
              label="Settings"
              onSelect={() => {
                setMenu(false)
                setSurface('settings')
              }}
            />
          </div>
        </div>
      )}

      {context && (
        <div className="bp-sheet-backdrop" onClick={() => setContext(null)}>
          <div className="bp-sheet" role="menu" onClick={(e) => e.stopPropagation()}>
            <div className="bp-sheet-head">
              {context.kind === 'image' ? <ImageIcon size={18} /> : <LinkIcon size={18} />}
              <span className="bp-sheet-url">{context.link ?? context.url}</span>
            </div>
            {context.link && (
              <>
                <MenuItem icon={<Plus size={18} />} label="Open in new tab" onSelect={() => contextAction('open')} />
                {!current?.private && <MenuItem icon={<Detective size={18} />} label="Open in private tab" onSelect={() => contextAction('private')} />}
                <MenuItem icon={<Copy size={18} />} label="Copy link address" onSelect={() => contextAction('copy')} />
                <MenuItem icon={<ShareNetwork size={18} />} label="Share link" onSelect={() => contextAction('share')} />
              </>
            )}
            {context.kind === 'image' ? (
              <>
                <MenuItem icon={<ImageIcon size={18} />} label="Open picture in new tab" onSelect={() => contextAction('image')} />
                <MenuItem icon={<DownloadSimple size={18} />} label="Download picture" onSelect={() => contextAction('download')} />
                <MenuItem icon={<Copy size={18} />} label="Copy picture address" onSelect={() => contextAction('copy-image')} />
              </>
            ) : (
              <MenuItem icon={<DownloadSimple size={18} />} label="Download link" onSelect={() => contextAction('download')} />
            )}
          </div>
        </div>
      )}
    </div>
  )
}

function MenuItem({ icon, label, hint, checked, disabled, onSelect }) {
  return (
    <button type="button" role="menuitem" className="bp-menu-item" disabled={disabled} onClick={onSelect}>
      <span className="bp-menu-icon">{icon}</span>
      <span className="bp-menu-label">{label}</span>
      {hint && <span className="bp-menu-hint">{hint}</span>}
      {checked !== undefined && (
        <span className={`bp-check${checked ? ' on' : ''}`} aria-hidden="true">
          {checked && <Check size={13} weight="bold" />}
        </span>
      )}
    </button>
  )
}

// ---- the new tab page ----

function NewTabPage({ api, engineName, isPrivate, isolated, onGo, onSearch }) {
  const [tiles, setTiles] = useState([])
  useEffect(() => {
    if (isPrivate || !api?.ready) return undefined
    let stale = false
    api
      .call('GET', '/browser/tiles')
      .then((list) => {
        if (!stale && Array.isArray(list)) setTiles(list.slice(0, 8))
      })
      .catch(() => {})
    return () => {
      stale = true
    }
  }, [api, isPrivate])

  return (
    <div className="bp-ntp">
      {isPrivate ? (
        <div className="bp-private-note">
          <Detective size={34} />
          <p className="bp-private-title">Private tab</p>
          <p>Pages you open here stay out of your history, and agents can't see this tab unless you let them from the menu.</p>
          {isolated === false && (
            <p className="bp-private-warn">
              This phone's WebView is too old to keep private tabs apart: sites you visit here can still leave cookies behind.
            </p>
          )}
        </div>
      ) : null}
      <button type="button" className="bp-ntp-search" onClick={onSearch}>
        <MagnifyingGlass size={18} />
        <span>Search {engineName} or type a web address</span>
      </button>
      {!isPrivate && tiles.length > 0 && (
        <div className="bp-tiles">
          {tiles.map((t) => (
            <button key={t.url} type="button" className="bp-tile" onClick={() => onGo(t.url)}>
              <span className="bp-tile-letter">{initial(t.url, t.title)}</span>
              <span className="bp-tile-name">{t.title || hostOf(t.url)}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

// ---- the address bar, open ----

function Omnibox({ api, engine, current, onGo, onClose, onCopied, onShare }) {
  const [text, setText] = useState(current?.url ?? '')
  const [suggestions, setSuggestions] = useState([])
  const inputRef = useRef(null)

  useEffect(() => {
    const input = inputRef.current
    if (!input) return
    input.focus()
    input.select()
  }, [])

  useEffect(() => {
    const typed = text.trim()
    if (!typed || typed === current?.url || !api?.ready) {
      setSuggestions([])
      return undefined
    }
    let stale = false
    const timer = setTimeout(() => {
      api
        .call('GET', `/browser/suggest?q=${encodeURIComponent(typed)}`)
        .then((list) => {
          if (!stale && Array.isArray(list)) setSuggestions(list)
        })
        .catch(() => {})
    }, 120)
    return () => {
      stale = true
      clearTimeout(timer)
    }
  }, [text, api, current?.url])

  const typed = text.trim()
  const target = typed ? omnibox(typed, engine) : null
  const isSearch = Boolean(target) && target === searchUrl(typed, engine)

  return (
    <div className="bp-surface bp-omnibox">
      <form
        className="bp-omnibox-bar"
        onSubmit={(e) => {
          e.preventDefault()
          if (typed) onGo(typed)
        }}
      >
        <button type="button" className="bp-icon" aria-label="Back" onClick={onClose}>
          <ArrowLeft size={22} />
        </button>
        <input
          ref={inputRef}
          className="bp-omnibox-input"
          value={text}
          placeholder="Search or type a web address"
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          enterKeyHint="go"
          inputMode="url"
          onChange={(e) => setText(e.target.value)}
        />
        {text && (
          <button type="button" className="bp-icon" aria-label="Clear" onClick={() => setText('')}>
            <X size={20} />
          </button>
        )}
      </form>
      <div className="bp-surface-body">
        {current && typed === current.url && (
          <div className="bp-current">
            <span className="bp-row-letter">{initial(current.url, current.title)}</span>
            <span className="bp-row-main">
              <span className="bp-row-title">{current.title || hostOf(current.url)}</span>
              <span className="bp-row-sub">{current.url}</span>
            </span>
            <button type="button" className="bp-icon" aria-label="Copy link" onClick={async () => onCopied(await copyText(current.url))}>
              <Copy size={19} />
            </button>
            <button type="button" className="bp-icon" aria-label="Share" onClick={onShare}>
              <ShareNetwork size={19} />
            </button>
          </div>
        )}
        {target && typed !== current?.url && (
          <button type="button" className="bp-row" onClick={() => onGo(typed)}>
            <span className="bp-row-letter">{isSearch ? <MagnifyingGlass size={16} /> : <Globe size={16} />}</span>
            <span className="bp-row-main">
              <span className="bp-row-title">{typed}</span>
              <span className="bp-row-sub">{isSearch ? `${SEARCH_ENGINES[engine].name} search` : target}</span>
            </span>
          </button>
        )}
        {suggestions.map((s) => (
          <button key={s.url} type="button" className="bp-row" onClick={() => onGo(s.url)}>
            <span className="bp-row-letter">{s.bookmarked ? <Star size={16} weight="fill" /> : initial(s.url, s.title)}</span>
            <span className="bp-row-main">
              <span className="bp-row-title">{s.title || hostOf(s.url)}</span>
              <span className="bp-row-sub">{s.url}</span>
            </span>
          </button>
        ))}
      </div>
    </div>
  )
}

// ---- the tab grid ----

function TabGrid({ tabs, active, thumbs, onPick, onClose, onNew, onDone }) {
  const normal = tabs.filter((t) => !t.private)
  const kept = tabs.filter((t) => t.private)
  const card = (t) => {
    const shot = t.native ? thumbs[t.native] : null
    return (
      <div
        key={t.key}
        role="button"
        tabIndex={0}
        className={`bp-card${t.key === active ? ' on' : ''}`}
        onClick={() => onPick(t.key)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') onPick(t.key)
        }}
      >
        <div className="bp-card-head">
          {t.favicon ? <img className="bp-card-icon" src={t.favicon} alt="" /> : <Globe size={14} className="bp-card-globe" />}
          <span className="bp-card-title">{tabTitle(t)}</span>
          <button
            type="button"
            className="bp-card-close"
            aria-label="Close tab"
            onClick={(e) => {
              e.stopPropagation()
              onClose(t.key)
            }}
          >
            <X size={14} weight="bold" />
          </button>
        </div>
        <div className="bp-card-shot">
          {shot ? (
            <img src={shot} alt="" />
          ) : (
            <span className="bp-card-blank">{t.url ? initial(t.url, t.title) : <MagnifyingGlass size={22} />}</span>
          )}
          {t.controller && <span className="bp-card-agent" title={`"${t.controller.title}" is using this tab`} />}
        </div>
      </div>
    )
  }
  return (
    <div className="bp-surface">
      <header className="bp-surface-head">
        <span className="bp-surface-title">
          {normal.length} {normal.length === 1 ? 'tab' : 'tabs'}
        </span>
        <button type="button" className="bp-icon" aria-label="New tab" onClick={() => onNew(false)}>
          <Plus size={22} />
        </button>
        <button type="button" className="bp-done" onClick={onDone}>
          Done
        </button>
      </header>
      <div className="bp-surface-body">
        <div className="bp-grid">{normal.map(card)}</div>
        <div className="bp-section">
          <Detective size={16} />
          <span>Private</span>
          <button type="button" className="bp-section-add" onClick={() => onNew(true)}>
            <Plus size={15} />
            New private tab
          </button>
        </div>
        {kept.length > 0 ? (
          <div className="bp-grid">{kept.map(card)}</div>
        ) : (
          <p className="bp-quiet">Private tabs keep no history, and agents don't see them.</p>
        )}
      </div>
    </div>
  )
}

// ---- the menu's pages ----

function Page({ title, onClose, children, action }) {
  return (
    <div className="bp-surface">
      <header className="bp-surface-head">
        <button type="button" className="bp-icon" aria-label="Back" onClick={onClose}>
          <ArrowLeft size={22} />
        </button>
        <span className="bp-surface-title">{title}</span>
        {action}
      </header>
      <div className="bp-surface-body">{children}</div>
    </div>
  )
}

function HistoryPage({ api, onOpen, onClose, onClearData }) {
  const [query, setQuery] = useState('')
  const [items, setItems] = useState(null)

  useEffect(() => {
    if (!api?.ready) return undefined
    let stale = false
    const timer = setTimeout(
      () => {
        api
          .call('GET', `/browser/history?q=${encodeURIComponent(query)}&limit=200`)
          .then((list) => {
            if (!stale) setItems(Array.isArray(list) ? list : [])
          })
          .catch(() => {
            if (!stale) setItems([])
          })
      },
      query ? 150 : 0,
    )
    return () => {
      stale = true
      clearTimeout(timer)
    }
  }, [api, query])

  const remove = (id) => {
    setItems((list) => list.filter((v) => v.id !== id))
    api.call('POST', '/browser/history/remove', { ids: [id] }).catch(() => {})
  }

  const groups = []
  for (const visit of items ?? []) {
    const day = dayOf(visit.at)
    if (groups.at(-1)?.day !== day) groups.push({ day, visits: [] })
    groups.at(-1).visits.push(visit)
  }

  return (
    <Page title="History" onClose={onClose}>
      <label className="bp-search">
        <MagnifyingGlass size={17} />
        <input value={query} placeholder="Search your history" spellCheck={false} onChange={(e) => setQuery(e.target.value)} />
      </label>
      <button type="button" className="bp-link-row" onClick={onClearData}>
        Clear browsing data
      </button>
      {items && !items.length && <p className="bp-quiet">{query ? 'Nothing in your history matches.' : 'Pages you visit show here.'}</p>}
      {groups.map((g) => (
        <section key={g.day}>
          <h3 className="bp-group">{g.day}</h3>
          {g.visits.map((v) => (
            <div key={v.id} className="bp-row">
              <button type="button" className="bp-row-open" onClick={() => onOpen(v.url)}>
                <span className="bp-row-letter">{initial(v.url, v.title)}</span>
                <span className="bp-row-main">
                  <span className="bp-row-title">{v.title || hostOf(v.url)}</span>
                  <span className="bp-row-sub">
                    {timeOf(v.at)} · {hostOf(v.url)}
                  </span>
                </span>
              </button>
              <button type="button" className="bp-icon" aria-label="Remove from history" onClick={() => remove(v.id)}>
                <X size={18} />
              </button>
            </div>
          ))}
        </section>
      ))}
    </Page>
  )
}

function DownloadsPage({ downloads, onClose }) {
  const stateOf = (d) => {
    if (d.state === 'started') {
      if (d.total > 0 && d.received >= 0) return `Downloading · ${Math.round((d.received / d.total) * 100)}%`
      return d.received > 0 ? `Downloading · ${sizeOf(d.received)}` : 'Downloading'
    }
    if (d.state === 'failed') return "Couldn't download"
    if (d.state === 'cancelled') return 'Cancelled'
    return sizeOf(d.total || d.received) || 'Done'
  }
  return (
    <Page title="Downloads" onClose={onClose}>
      {!downloads.length && <p className="bp-quiet">Files you download land in the phone's Downloads, and show here.</p>}
      {downloads.map((d) => (
        <button
          key={d.id}
          type="button"
          className="bp-row"
          disabled={d.state !== 'done' || !d.path}
          onClick={() => call('browser_reveal', { path: d.path })}
        >
          <span className="bp-row-letter">{d.state === 'failed' ? <Warning size={16} /> : <DownloadSimple size={16} />}</span>
          <span className="bp-row-main">
            <span className="bp-row-title">{d.name ?? fileName(d.path ?? d.url)}</span>
            <span className="bp-row-sub">{stateOf(d)}</span>
          </span>
        </button>
      ))}
    </Page>
  )
}

function BookmarksPage({ api, bookmarks, onOpen, onChanged, onClose }) {
  const remove = async (id) => {
    await api.call('POST', `/browser/bookmarks/${encodeURIComponent(id)}/remove`).catch(() => {})
    onChanged()
  }
  return (
    <Page title="Bookmarks" onClose={onClose}>
      {!bookmarks.length && <p className="bp-quiet">Bookmark a page with the star in the menu.</p>}
      {bookmarks.map((b) => (
        <div key={b.id} className="bp-row">
          <button type="button" className="bp-row-open" onClick={() => onOpen(b.url)}>
            <span className="bp-row-letter">{initial(b.url, b.title)}</span>
            <span className="bp-row-main">
              <span className="bp-row-title">{b.title || hostOf(b.url)}</span>
              <span className="bp-row-sub">{b.url}</span>
            </span>
          </button>
          <button type="button" className="bp-icon" aria-label="Remove bookmark" onClick={() => remove(b.id)}>
            <Trash size={18} />
          </button>
        </div>
      ))}
    </Page>
  )
}

const PERMISSION_WORDS = {
  camera: 'Camera',
  microphone: 'Microphone',
  geolocation: 'Location',
  'protected-media': 'Protected content',
  midi: 'MIDI devices',
}

function SettingsPage({ api, data, onChanged, onDone, onClose }) {
  const [kinds, setKinds] = useState({ history: true, cookies: true, cache: true, permissions: false })
  const [busy, setBusy] = useState(false)
  const engine = SEARCH_ENGINES[data?.settings?.search] ? data.settings.search : 'google'
  const remembered = Object.entries(data?.permissions ?? {})
    .filter(([, state]) => state === 'allow' || state === 'deny')
    .map(([key, state]) => {
      const at = key.lastIndexOf('|')
      return { origin: key.slice(0, at), kind: key.slice(at + 1), state }
    })

  const setEngine = async (key) => {
    await api.call('POST', '/browser/settings', { search: key }).catch(() => {})
    onChanged()
  }

  const forget = async (p) => {
    await api.call('POST', '/browser/permissions', { origin: p.origin, kind: p.kind, state: null }).catch(() => {})
    onChanged()
  }

  const clear = async () => {
    setBusy(true)
    if (kinds.history) await api.call('POST', '/browser/history/clear', {}).catch(() => {})
    const native = []
    if (kinds.cookies) native.push('cookies', 'site_data')
    if (kinds.cache) native.push('cache')
    if (kinds.permissions) {
      native.push('permissions')
      for (const p of remembered) await api.call('POST', '/browser/permissions', { origin: p.origin, kind: p.kind, state: null }).catch(() => {})
    }
    if (native.length) await call('browser_clear_data', { kinds: native })
    setBusy(false)
    onChanged()
    onDone('Browsing data cleared')
  }

  const toggle = (key) => setKinds((k) => ({ ...k, [key]: !k[key] }))
  const anything = Object.values(kinds).some(Boolean)

  return (
    <Page title="Browser settings" onClose={onClose}>
      <h3 className="bp-group">Search engine</h3>
      {Object.entries(SEARCH_ENGINES).map(([key, e]) => (
        <button key={key} type="button" className="bp-row" onClick={() => setEngine(key)}>
          <span className="bp-row-main">
            <span className="bp-row-title">{e.name}</span>
          </span>
          <span className={`bp-radio${engine === key ? ' on' : ''}`} aria-hidden="true" />
        </button>
      ))}

      <h3 className="bp-group">Site permissions</h3>
      {!remembered.length && <p className="bp-quiet">Sites you allow or block (camera, microphone, location) show here.</p>}
      {remembered.map((p) => (
        <div key={`${p.origin}|${p.kind}`} className="bp-row">
          <span className="bp-row-main">
            <span className="bp-row-title">{hostOf(p.origin) || p.origin}</span>
            <span className="bp-row-sub">
              {PERMISSION_WORDS[p.kind] ?? p.kind} · {p.state === 'allow' ? 'Allowed' : 'Blocked'}
            </span>
          </span>
          <button type="button" className="bp-link" onClick={() => forget(p)}>
            Reset
          </button>
        </div>
      ))}

      <h3 className="bp-group">Clear browsing data</h3>
      {[
        ['history', 'Browsing history'],
        ['cookies', 'Cookies and site data'],
        ['cache', 'Cached pictures and files'],
        ['permissions', 'Site permissions'],
      ].map(([key, label]) => (
        <button key={key} type="button" className="bp-row" onClick={() => toggle(key)}>
          <span className="bp-row-main">
            <span className="bp-row-title">{label}</span>
          </span>
          <span className={`bp-check${kinds[key] ? ' on' : ''}`} aria-hidden="true">
            {kinds[key] && <Check size={13} weight="bold" />}
          </span>
        </button>
      ))}
      <div className="bp-actions">
        <button type="button" className="bp-button primary" disabled={busy || !anything} onClick={clear}>
          {busy ? 'Clearing' : 'Clear data'}
        </button>
      </div>
    </Page>
  )
}
