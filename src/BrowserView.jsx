// The built-in browser: Chrome's arrangement (tab strip, toolbar, address
// bar, bookmarks bar, menus) drawn by the console, with each page a native
// webview the shell lays over the placeholder below the bars
// (src-tauri/src/browser). The tabs live in browser-store.js, so leaving
// the view hides the pages instead of closing them. The browser's own
// pages - the new tab page, history, downloads, bookmarks - are drawn here
// in the page's place, with no webview at all.

import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { Globe } from '@phosphor-icons/react'
import { hasTauri, isMobile } from './platform.js'
import { useConsole } from './state/console.jsx'
import { isMac, useKeyboard, useShortcut } from './keyboard.jsx'
import { BROWSER_ACTIONS, actionForCombo } from './shortcuts.js'
import { PAGES, internalPage, omnibox, pageUrl } from './browser-omnibox.js'
import { cycle, insertAfter, isDormant, newTab, tabTitle } from './browser-tabs.js'
import {
  adopt,
  answerPrompt,
  call,
  clearDownloads,
  getState,
  notify,
  onKey,
  openRemote,
  patchTab,
  recordTab,
  removeTab,
  setApi,
  setState,
  stopRecording,
  subscribe,
} from './browser-store.js'
import { FLOATING } from './browser-occlusion.js'
import { DEVICES, fileUrl, fitDevice, nextZoom } from './browser-chrome.js'
import {
  browserSetting,
  getBrowserData,
  removeBookmark,
  saveBookmark,
  setBrowserSetting,
  setSitePermission,
  useBrowserData,
} from './browser-data.js'
import { bookmarkFor, inFolder, positionAt } from './browser-bookmarks.js'
import { keyEventInit } from './browser-keys.js'
import { screenshotAttachment } from './browser-attach.js'
import { addAttachment, focusedComposer } from './attachments.js'
import { recording, subscribeRecording } from './browser-record.js'
import ContextMenu from './ContextMenu.jsx'
import useBrowserPage from './useBrowserPage.js'
import BrowserTabStrip, { TabIcon } from './BrowserTabStrip.jsx'
import BrowserToolbar from './BrowserToolbar.jsx'
import BrowserBookmarksBar from './BrowserBookmarksBar.jsx'
import BrowserBookmarkEditor from './BrowserBookmarkEditor.jsx'
import { AgentBar, PermissionBar, PickBar } from './BrowserInfobar.jsx'
import { BrowserDeviceBar, BrowserFindBar } from './BrowserFindBar.jsx'
import BrowserNewTab from './BrowserNewTab.jsx'
import BrowserPages from './BrowserPages.jsx'
import BrowserRegion from './BrowserRegion.jsx'
import BrowserLiveView, { ViewedBar, useRemoteTabs, useViews } from './BrowserLiveView.jsx'
import { menuItems } from './BrowserMenus.jsx'
import './panels.css'
import './browser.css'

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = reject
    img.src = src
  })
}

// A part of a picture of the page: `r` in the on-screen box `box`.
async function crop(picture, r, box) {
  try {
    const img = await loadImage(picture)
    const sx = img.naturalWidth / box.width
    const sy = img.naturalHeight / box.height
    const canvas = document.createElement('canvas')
    canvas.width = Math.max(1, Math.round(r.width * sx))
    canvas.height = Math.max(1, Math.round(r.height * sy))
    canvas
      .getContext('2d')
      .drawImage(img, r.x * sx, r.y * sy, r.width * sx, r.height * sy, 0, 0, canvas.width, canvas.height)
    return canvas.toDataURL('image/jpeg', 0.9)
  } catch {
    return null
  }
}

// The phone gets its own browser layout; this is the desktop's. `focused`
// is false while the browser sits in a split pane the user isn't in (its
// keys then stay the app's); left out, the browser is the view on screen.
export default function BrowserView({ focused = true }) {
  if (!hasTauri || isMobile) {
    return (
      <div className="bw-unavailable">
        <Globe size={28} />
        <p>{isMobile ? 'The browser comes to the phone in its own build.' : 'The browser runs in the desktop app.'}</p>
      </div>
    )
  }
  return <BrowserDesktop paneFocused={focused} />
}

function Waiting({ tab, onRetry }) {
  return (
    <div className="bw-waiting">
      <TabIcon tab={{ ...tab, loading: false }} size={22} />
      <span className="bw-waiting-title">{tabTitle(tab)}</span>
      {tab.failed && (
        <>
          <span>This page couldn't open.</span>
          <button type="button" className="pn-btn" onClick={onRetry}>
            Try again
          </button>
        </>
      )}
    </div>
  )
}

function BrowserDesktop({ paneFocused }) {
  const { tabs, active, downloads, finds, closed, prompts, picking, fullscreen, notice, icons } = useSyncExternalStore(
    subscribe,
    getState,
  )
  const data = useBrowserData()
  const rec = useSyncExternalStore(subscribeRecording, recording)
  const { api, chats, cloud } = useConsole()
  const kb = useKeyboard()
  const kbRef = useRef(kb)
  kbRef.current = kb
  const current = tabs.find((t) => t.key === active) ?? tabs[0]
  const rootRef = useRef(null)
  const pageRef = useRef(null)
  const findRef = useRef(null)
  const omni = useRef(null)
  // The page's picture while a console menu covers it: one element that
  // stays in the page, so a picture is decoded in it before it shows.
  const pictureRef = useRef(null)
  const [menu, setMenu] = useState(null)
  // The user's other devices (in Cloud): their tabs for the tab list, and who
  // is showing this device's tabs live.
  const inCloud = Boolean(cloud?.device)
  const remote = useRemoteTabs(api, inCloud && menu?.kind === 'tabs')
  const views = useViews(api, inCloud)
  const [editor, setEditor] = useState(null)
  const [region, setRegion] = useState(null)
  // The browser's keys act while it has focus (see the tracker below).
  const [focused, setFocused] = useState(true)

  const engine = browserSetting(data.settings, 'search')
  const barSetting = browserSetting(data.settings, 'bookmarks_bar')
  const page = internalPage(current?.url)
  const ntp = !current?.url || page === 'newtab'
  const live = Boolean(current?.native)
  const device = current?.device ?? null
  const find = current?.find ?? null
  const findState = (current?.native && finds[current.native]) || null
  const busy = downloads.some((d) => d.state === 'started')
  const prompt = (current?.native && prompts.find((p) => p.tab === current.native)) || null
  const bookmarked = Boolean(bookmarkFor(data.bookmarks, current?.url))
  // Chrome's rule: the bar shows on every page when it's on, and on a new
  // tab page whenever there are bookmarks to show.
  const barShown = barSetting || (ntp && !current?.private && data.bookmarks.length > 0)
  const full = Boolean(fullscreen) && fullscreen === current?.native

  // The daemon client, for the store's restoring and saving.
  useEffect(() => {
    setApi(api)
  }, [api])

  // Focus: from the last click or focus inside the browser (its chrome or,
  // through its keys, its page) until one lands elsewhere in the app. The
  // app's menus and dialogs over it don't count as elsewhere.
  useEffect(() => {
    const track = (e) => {
      const t = e.target
      if (!(t instanceof Element)) return
      if (rootRef.current?.contains(t)) setFocused(true)
      else if (!t.closest(`${FLOATING}, [role="dialog"]`)) setFocused(false)
    }
    window.addEventListener('pointerdown', track, true)
    window.addEventListener('focusin', track, true)
    return () => {
      window.removeEventListener('pointerdown', track, true)
      window.removeEventListener('focusin', track, true)
    }
  }, [])

  const { shownNative, rect, picture$, precapture, shotRef } = useBrowserPage({ current, pageRef, pictureRef })

  // ---- opening pages ----

  const activeTab = () => getState().tabs.find((t) => t.key === getState().active)

  // A tab's webview, opened at `url`: shown when the tab is on screen,
  // loading unseen behind it otherwise.
  const openNative = async (key, url, { show = true } = {}) => {
    const bounds = rect()
    const tab = getState().tabs.find((t) => t.key === key)
    if (!bounds || !tab) return null
    patchTab(key, { url, loading: true, opening: true, failed: false })
    const visible = show && getState().active === key
    const native = await call('browser_open', { url, bounds, show: visible, private: Boolean(tab.private) })
    // Closed while it opened: the page goes too.
    if (!getState().tabs.some((t) => t.key === key)) {
      if (native) call('browser_close', { tab: native })
      return null
    }
    if (!native) {
      patchTab(key, { opening: false, loading: false, failed: true })
      return null
    }
    if (visible) {
      if (getState().active === key) shownNative.current = native
      else call('browser_hide', { tab: native })
    }
    adopt(key, native)
    patchTab(key, { opening: false })
    return native
  }

  // A tab waiting as an entry (restored, put away, reopened) opens its page
  // when it is first shown.
  useEffect(() => {
    if (!current || current.native || current.opening || current.failed || !isDormant(current)) return
    openNative(current.key, current.url)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current?.key, current?.native, current?.url, current?.failed])

  // ---- actions ----

  const openTab = (fields = {}) => {
    const tab = newTab(fields)
    setState((s) => ({ tabs: [...s.tabs, tab], active: tab.key }))
    omni.current?.clear()
  }

  const openTabAfter = (key) => {
    const tab = newTab()
    setState((s) => ({ tabs: insertAfter(s.tabs, tab, key), active: tab.key }))
    omni.current?.clear()
  }

  // Settings > Browser: the app's Settings view, at its Browser section.
  const openSettings = () => {
    if (!kbRef.current?.run('view-settings')) return
    let tries = 0
    const seek = () => {
      const el = document.getElementById('stg-browser')
      if (el) el.scrollIntoView({ block: 'start' })
      else if (++tries < 30) requestAnimationFrame(seek)
    }
    requestAnimationFrame(seek)
  }

  // One of the browser's own pages: shown where it is already open, in the
  // tab itself when that tab holds no page (or `here` asks for it), else
  // in a new tab beside it.
  const openPage = (name, { here = false } = {}) => {
    if (name === 'settings') return openSettings()
    const s = getState()
    const cur = s.tabs.find((t) => t.key === s.active)
    if (name === 'newtab') {
      if (cur && !cur.native) return patchTab(cur.key, { url: '', title: '', failed: false })
      return openTab()
    }
    const url = pageUrl(name)
    const open = s.tabs.find((t) => t.url === url && !t.private)
    if (open && !here) return setState(() => ({ active: open.key }))
    if (cur && !cur.native && !cur.private && (here || !cur.url)) {
      return patchTab(cur.key, { url, title: PAGES[name], failed: false })
    }
    const tab = newTab({ url, title: PAGES[name] })
    setState((st) => ({ tabs: insertAfter(st.tabs, tab, st.active), active: tab.key }))
  }

  const go = async (line) => {
    const text = String(line ?? '').trim()
    const named = internalPage(text)
    if (named) return openPage(named, { here: true })
    const url = omnibox(text, engine)
    const tab = activeTab()
    if (!url || !tab) return
    // Another device's tab isn't this window's to navigate: the address opens here.
    if (tab.remote) return openUrl(url, { newTab: true, show: true })
    if (tab.native) return call('browser_navigate', { tab: tab.native, url })
    return openNative(tab.key, url)
  }

  // An address from a bookmark, history or a tile: here, or in a new tab
  // (in the background, as a middle click does in Chrome; `show` brings it
  // forward).
  const openUrl = (url, { newTab: inNew = false, show = false } = {}) => {
    if (!inNew) return go(url)
    const tab = newTab({ url })
    setState((s) => ({ tabs: insertAfter(s.tabs, tab, s.active), ...(show ? { active: tab.key } : {}) }))
    if (!show && !internalPage(url)) openNative(tab.key, url, { show: false })
  }

  const select = (key) => setState(() => ({ active: key }))

  const close = (key) => {
    const native = removeTab(key)
    if (native && native === shownNative.current) shownNative.current = null
  }

  const closeOthers = (key) => {
    for (const t of getState().tabs) if (t.key !== key) close(t.key)
  }

  const reopen = () => {
    const [last, ...rest] = getState().closed
    if (!last) return
    const tab = newTab({ url: last.url, title: last.title })
    setState((s) => ({ closed: rest, tabs: [...s.tabs, tab], active: tab.key }))
  }

  const duplicate = (t) => {
    const tab = newTab({ url: t.url, title: t.title, private: t.private })
    setState((s) => ({ tabs: insertAfter(s.tabs, tab, t.key), active: tab.key }))
  }

  const onNative = (command, extra = {}) => {
    const native = activeTab()?.native
    if (native) return call(command, { tab: native, ...extra })
    return Promise.resolve(null)
  }

  const zoom = (dir) => {
    const tab = activeTab()
    if (!tab?.native) return
    const factor = nextZoom(tab.zoom ?? 1, dir)
    patchTab(tab.key, { zoom: factor })
    call('browser_zoom', { tab: tab.native, factor })
  }

  const focusAddress = () => omni.current?.focus()

  const openFind = () => {
    const tab = activeTab()
    // On one of the browser's own pages, its search box is the find.
    if (!tab?.native) {
      rootRef.current?.querySelector('.bwp-search input')?.focus()
      return
    }
    patchTab(tab.key, { find: { term: tab.find?.term ?? '' } })
    requestAnimationFrame(() => {
      findRef.current?.focus()
      findRef.current?.select()
    })
  }

  const runFind = (term, step) => {
    const tab = activeTab()
    if (!tab?.native) return
    patchTab(tab.key, { find: { term } })
    call('browser_find', { tab: tab.native, term, step })
  }

  const closeFind = () => {
    const tab = activeTab()
    if (!tab) return
    patchTab(tab.key, { find: null })
    if (tab.native) call('browser_find', { tab: tab.native, term: '', step: 0 })
  }

  const toggleDevice = () => {
    const tab = activeTab()
    if (!tab?.native) return
    patchTab(tab.key, { device: tab.device ? null : { ...DEVICES[0] } })
  }

  const setDevice = (change) => {
    const tab = activeTab()
    if (tab?.device) patchTab(tab.key, { device: { ...tab.device, ...change } })
  }

  // ---- bookmarks ----

  const anchorOf = (el) => {
    const r = el?.getBoundingClientRect()
    return r ? { right: r.right, y: r.bottom + 6 } : { right: window.innerWidth - 8, y: 96 }
  }

  // The star (or Ctrl+D): bookmarks the page on the bar, then opens the
  // editor; on a bookmarked page, just the editor.
  const star = async (el) => {
    const tab = activeTab()
    if (editor || !tab?.url || internalPage(tab.url) === 'newtab') return
    // The editor will cover the page: its picture, taken while the bookmark saves.
    precapture()
    const anchor = anchorOf(el ?? document.querySelector('[data-bw-anchor="star"]'))
    let mark = bookmarkFor(getBrowserData().bookmarks, tab.url)
    let fresh = false
    if (!mark) {
      mark = await saveBookmark(api, { url: tab.url, title: tabTitle(tab), folder: 'bar' })
      fresh = true
    }
    if (mark) setEditor({ mark, fresh, anchor })
  }

  const editMark = (mark, at) => {
    setEditor({ mark, fresh: false, anchor: { right: (at?.x ?? 0) + 300, y: (at?.y ?? 0) + 4 } })
  }

  const finishEdit = ({ title, folder }) => {
    if (!editor) return
    const { mark } = editor
    setEditor(null)
    const was = mark.folder === 'other' ? 'other' : 'bar'
    if (title === mark.title && folder === was) return
    // A bookmark moved to the other folder goes last there.
    const there = inFolder(getBrowserData().bookmarks, folder).filter((m) => m.id !== mark.id)
    const position = folder === was ? mark.position : positionAt(there, there.length)
    saveBookmark(api, { ...mark, title, folder, position })
  }

  const toggleBar = () => setBrowserSetting(api, 'bookmarks_bar', !browserSetting(getBrowserData().settings, 'bookmarks_bar'))

  // ---- the chat: picked elements, screenshots, recordings ----

  const attach = (item) => {
    const composer = focusedComposer()
    addAttachment(item, composer)
    notify({ kind: 'attached', composer })
  }

  const pick = () => {
    const tab = activeTab()
    if (!tab?.native) return
    const on = getState().picking !== tab.native
    setState(() => ({ picking: on ? tab.native : null }))
    call('browser_pick', { tab: tab.native, on })
    // The page takes the keyboard, so Esc reaches the picker there.
    if (on) call('browser_show', { tab: tab.native, focus: true })
  }

  const shot = async () => {
    const tab = activeTab()
    if (!tab?.native) return
    const dataUrl = await call('browser_capture', { tab: tab.native })
    if (!dataUrl) {
      notify({ kind: 'error', text: "The page's picture couldn't be taken." })
      return
    }
    attach(screenshotAttachment(dataUrl, tab.url))
  }

  const startRegion = async () => {
    const tab = activeTab()
    if (!tab?.native) return
    // A fresh picture to drag over (the swap shows it in the page's place).
    await picture$(tab.native, 0)
    const pageBox = pageRef.current?.getBoundingClientRect()
    const at = rect()
    if (!pageBox || !at) return
    setRegion({
      tab: tab.native,
      url: tab.url,
      scale: (tab.zoom ?? 1) * (tab.device ? fitDevice(tab.device, { width: pageBox.width - 32, height: pageBox.height - 32 }).scale : 1),
      box: { left: at.x - pageBox.left, top: at.y - pageBox.top, width: at.width, height: at.height },
    })
  }

  const finishRegion = async (r) => {
    const reg = region
    setRegion(null)
    if (!reg) return
    // The page's own CSS pixels, from the top-left of what shows.
    const clip = { x: r.x / reg.scale, y: r.y / reg.scale, width: r.width / reg.scale, height: r.height / reg.scale }
    let dataUrl = await call('browser_capture', { tab: reg.tab, clip })
    // A shell that sent the whole page (or nothing): the part is cut from
    // the page's picture here instead.
    if (dataUrl) {
      const img = await loadImage(dataUrl).catch(() => null)
      const dpr = window.devicePixelRatio || 1
      const whole =
        img &&
        (img.naturalWidth > clip.width * dpr * 1.5 + 8 ||
          Math.abs(img.naturalWidth / img.naturalHeight - r.width / r.height) > 0.05)
      if (whole) dataUrl = await crop(dataUrl, r, reg.box)
    } else if (shotRef.current.tab === reg.tab && shotRef.current.url) {
      dataUrl = await crop(shotRef.current.url, r, reg.box)
    }
    if (!dataUrl) {
      notify({ kind: 'error', text: "That part of the page couldn't be taken." })
      return
    }
    attach(screenshotAttachment(dataUrl, reg.url))
  }

  const record = () => {
    const tab = activeTab()
    if (tab?.native) recordTab(tab.native)
  }

  // ---- the agent's hold, sites, downloads ----

  const control = async (action) => {
    const tab = activeTab()
    if (!tab?.native || !api?.ready) return
    try {
      const got = await api.call('POST', `/browser/tabs/${encodeURIComponent(tab.native)}/control`, { action })
      patchTab(tab.key, { controller: got?.controller ?? null })
    } catch (err) {
      notify({ kind: 'error', text: err?.message ?? "That didn't work." })
    }
  }

  const share = (on) => {
    const tab = activeTab()
    if (!tab?.native) return
    patchTab(tab.key, { shared: on })
    call('browser_share', { tab: tab.native, on })
  }

  // A failed download starts again: through the tab it came from while
  // that tab is open (a download leaves its page where it is).
  const retry = (d) => {
    const from = getState().tabs.find((t) => t.native && t.native === d.tab) ?? getState().tabs.find((t) => t.native)
    if (from) call('browser_navigate', { tab: from.native, url: d.url })
    else openUrl(d.url, { newTab: true })
  }

  const act = {
    go,
    precapture,
    openTab,
    openTabAfter,
    openPrivate: () => openTab({ private: true }),
    openPage,
    openSettings,
    openUrl,
    openFile: (path) => openUrl(fileUrl(path), { newTab: true, show: true }),
    openExternal: (url) => call('browser_open_external', { url }),
    select,
    openRemote,
    close,
    closeOthers,
    reopen,
    duplicate,
    reloadTab: (t) => t.native && call('browser_reload', { tab: t.native }),
    back: () => onNative('browser_back'),
    forward: () => onNative('browser_forward'),
    reload: () => onNative('browser_reload'),
    stop: () => onNative('browser_stop'),
    print: () => onNative('browser_print'),
    devtools: () => onNative('browser_devtools'),
    clearSite: () => onNative('browser_clear_site'),
    zoom,
    openFind,
    toggleDevice,
    star,
    editMark,
    removeMark: (m) => removeBookmark(api, m.id),
    toggleBar,
    pick,
    shot,
    region: startRegion,
    record,
    stopRecord: () => stopRecording(),
    share,
    resetPermission: (p) => setSitePermission(api, p.origin, p.kind, null),
    reveal: (path) => call('browser_reveal', { path }),
    retry,
    clearDownloads,
    menu: (kind, el, extra = {}) => {
      const target = typeof el === 'string' ? document.querySelector(`[data-bw-anchor="${el}"]`) : el
      const r = target?.getBoundingClientRect()
      setMenu({ kind, x: r ? r.left : 0, y: r ? r.bottom + 4 : 0, ...extra })
    },
    tabMenu: (tab, x, y) => setMenu({ kind: 'tab', tab, x, y }),
    markMenu: (mark, x, y) => setMenu({ kind: 'mark', mark, x, y }),
  }

  // ---- keys ----

  const handlers = useRef({})
  handlers.current = {
    'browser-new-tab': () => openTab(),
    'browser-private-tab': act.openPrivate,
    'browser-close-tab': () => close(getState().active),
    'browser-reopen-tab': reopen,
    'browser-next-tab': () => setState((s) => ({ active: cycle(s.tabs, s.active, 1) })),
    'browser-prev-tab': () => setState((s) => ({ active: cycle(s.tabs, s.active, -1) })),
    'browser-address': focusAddress,
    'browser-back': act.back,
    'browser-forward': act.forward,
    'browser-reload': act.reload,
    'browser-reload-key': act.reload,
    'browser-find': openFind,
    'browser-bookmark': () => star(null),
    'browser-bookmarks-bar': toggleBar,
    'browser-history': () => openPage('history'),
    'browser-downloads': () => openPage('downloads'),
    'browser-zoom-in': () => zoom(1),
    'browser-zoom-out': () => zoom(-1),
    'browser-zoom-reset': () => zoom(0),
  }
  // Typed in the browser's own chrome, through the app's keyboard layer
  // (rebindable in Settings > Keyboard). The list is a constant, so these
  // hooks run in the same order every render.
  const keysOn = paneFocused && focused && !region
  for (const a of BROWSER_ACTIONS) {
    // eslint-disable-next-line react-hooks/rules-of-hooks
    useShortcut(a.id, () => handlers.current[a.id]?.(), keysOn)
  }

  // Pressed while a page had focus (the shell takes them before the page
  // does): the browser's own act here, anything else is the app's and is
  // played back to the app as the keypress it was.
  useEffect(
    () =>
      onKey((chord) => {
        setFocused(true)
        if (chord === 'F12' && import.meta.env.DEV) {
          onNative('browser_devtools')
          return
        }
        const id = actionForCombo(kbRef.current?.scopes?.browser ?? {}, chord)
        if (id && handlers.current[id]) {
          handlers.current[id]()
          return
        }
        const init = keyEventInit(chord, isMac)
        if (init) window.dispatchEvent(new KeyboardEvent('keydown', init))
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  )

  const hint = (title, id) => {
    const keys = kb?.label(id)
    return keys ? `${title} (${keys})` : title
  }

  // ---- what shows ----

  const composerName = (key) => (key === 'new' ? 'New chat' : chats?.[key]?.title ?? 'the chat')
  const shownNotice = notice && {
    kind: notice.kind,
    text:
      notice.kind === 'attached' ? (
        <>
          Added to <span className="pv">{composerName(notice.composer)}</span>
        </>
      ) : (
        notice.text
      ),
  }

  const ctx = {
    act,
    key: (id) => kb?.label(id) ?? '',
    tab: current,
    tabs,
    active,
    closed,
    downloads,
    marks: data.bookmarks,
    icons,
    permissions: data.permissions,
    live,
    remote: remote.devices,
    picking: Boolean(picking) && picking === current?.native,
    rec,
    barSetting,
  }

  return (
    <div className={`bw${full ? ' full' : ''}`} ref={rootRef}>
      {!full && <BrowserTabStrip tabs={tabs} active={active} act={act} hint={hint} precapture={precapture} />}
      {!full && (
        <BrowserToolbar
          tab={current}
          live={live}
          act={act}
          hint={hint}
          engine={engine}
          bookmarked={bookmarked}
          picking={ctx.picking}
          rec={rec}
          notice={shownNotice}
          busy={busy}
          device={device}
          omni={omni}
          api={api}
          icons={icons}
          precapture={precapture}
        />
      )}
      {!full && barShown && <BrowserBookmarksBar marks={data.bookmarks} icons={icons} act={act} precapture={precapture} />}
      {/* A site's request shows even in full screen: a call that went full
          screen and then asks for the camera still needs an answer. */}
      {prompt && (
        <PermissionBar
          key={`${prompt.tab}:${prompt.id}`}
          prompt={prompt}
          onAnswer={(allow, remember) => answerPrompt(prompt, allow, remember)}
        />
      )}
      {!full && current?.controller && <AgentBar controller={current.controller} onControl={control} />}
      {!full && current?.native && <ViewedBar api={api} views={views} tab={current.native} />}
      {!full && ctx.picking && <PickBar onCancel={pick} />}
      {!full && find && live && (
        <BrowserFindBar find={find} state={findState} inputRef={findRef} onFind={runFind} onClose={closeFind} />
      )}
      {!full && device && live && (
        <BrowserDeviceBar device={device} onChange={setDevice} onClose={toggleDevice} />
      )}

      <div className={`bw-page${device ? ' device' : ''}`} ref={pageRef}>
        <img ref={pictureRef} className="bw-picture" alt="" />
        {current?.remote && (
          <BrowserLiveView
            key={current.key}
            api={api}
            device={{ id: current.remote.device, name: current.remote.name, platform: current.remote.platform }}
            tab={current.remote.tab}
            title={current.title}
            onInfo={(i) => patchTab(current.key, { url: i.url, title: i.title })}
            onStop={() => close(current.key)}
          />
        )}
        {!live &&
          !current?.remote &&
          (page && page !== 'newtab' ? (
            <BrowserPages page={page} api={api} icons={icons} marks={data.bookmarks} downloads={downloads} act={act} />
          ) : ntp ? (
            <BrowserNewTab
              key={current?.key}
              privateTab={Boolean(current?.private)}
              engine={engine}
              api={api}
              icons={icons}
              chats={chats}
              act={act}
            />
          ) : (
            <Waiting tab={current} onRetry={() => patchTab(current.key, { failed: false })} />
          ))}
        {region && <BrowserRegion box={region.box} onPick={finishRegion} onCancel={() => setRegion(null)} />}
      </div>

      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          items={menuItems(menu, ctx)}
          onClose={() => setMenu(null)}
          className={menu.kind === 'main' || menu.kind === 'tabs' ? 'bw-menu' : undefined}
        />
      )}
      {editor && (
        <BrowserBookmarkEditor
          key={editor.mark.id}
          mark={editor.mark}
          fresh={editor.fresh}
          anchor={editor.anchor}
          onDone={finishEdit}
          onRemove={() => {
            removeBookmark(api, editor.mark.id)
            setEditor(null)
          }}
        />
      )}
    </div>
  )
}
