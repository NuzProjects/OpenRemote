// Where the browser's page sits on screen. The page is a native webview the
// shell lays over a placeholder the console draws (`pageRef`): this keeps
// the shown tab's webview on that placeholder as it moves and resizes,
// sizes it for device view, and while one of the console's floating
// surfaces covers it, swaps in the page's picture (`pictureRef`) so
// nothing hides behind the page or flickers.

import { useEffect, useLayoutEffect, useRef } from 'react'
import { call, getState } from './browser-store.js'
import { FLOATING, covered } from './browser-occlusion.js'
import { fitDevice } from './browser-chrome.js'

// A box on whole device pixels: its edges rounded, not its size, so two
// boxes that touch still touch.
function snap(box) {
  const dpr = window.devicePixelRatio || 1
  const px = (v) => Math.round(v * dpr) / dpr
  const x = px(box.x)
  const y = px(box.y)
  return { x, y, width: px(box.x + box.width) - x, height: px(box.y + box.height) - y }
}

// Where a page waits while a console menu covers it: the same size (no
// relayout when it comes back), far outside the window.
function offscreen(bounds) {
  return { ...bounds, x: -30000 }
}

// Resolves after `n` frames have been painted.
function frames(n) {
  return new Promise((resolve) => {
    const step = (left) => (left ? requestAnimationFrame(() => step(left - 1)) : resolve())
    step(n)
  })
}

export default function useBrowserPage({ current, pageRef, pictureRef }) {
  // The shell's tab on screen now.
  const shownNative = useRef(null)
  // While a console menu covers the page, the page waits out of view
  // (moved, not hidden: a hidden webview can show blank for a frame when
  // it comes back) and its picture stands in.
  const parked = useRef(false)
  // The latest picture of the page, kept for a moment so a menu opened
  // from the toolbar can cover the page at once.
  const shotRef = useRef({ tab: null, url: null, at: 0 })
  const device = current?.device ?? null

  // Where the page sits: the whole placeholder, or a device's size
  // centred in it.
  // Snapped to whole device pixels, where the shell places the page, so
  // the page, its picture and the console's own pixels line up exactly.
  const rect = () => {
    const r = pageRef.current?.getBoundingClientRect()
    if (!r) return null
    const tab = getState().tabs.find((t) => t.key === getState().active)
    let box = { x: r.left, y: r.top, width: r.width, height: r.height }
    if (tab?.device) {
      const fit = fitDevice(tab.device, { width: r.width - 32, height: r.height - 32 })
      box = { x: r.left + (r.width - fit.width) / 2, y: r.top + 16, width: fit.width, height: fit.height }
    }
    return snap(box)
  }

  const syncBounds = () => {
    const tab = shownNative.current
    const bounds = rect()
    if (tab && bounds) call('browser_set_bounds', { tab, bounds: parked.current ? offscreen(bounds) : bounds })
  }

  const picture$ = async (tab, maxAge) => {
    const kept = shotRef.current
    if (kept.tab === tab && Date.now() - kept.at < maxAge) return kept.url
    const url = await call('browser_capture', { tab })
    if (url) shotRef.current = { tab, url, at: Date.now() }
    return url
  }

  // A pointer near the menus' buttons: a picture taken ahead of the menu.
  const precapture = () => {
    const tab = shownNative.current
    if (tab && !parked.current) picture$(tab, 400)
  }

  // Show the active tab's page over the placeholder, hide the one before.
  useLayoutEffect(() => {
    const next = current?.native ?? null
    const before = shownNative.current
    shownNative.current = next
    ;(async () => {
      if (before && before !== next) await call('browser_hide', { tab: before })
      const bounds = rect()
      if (next && bounds) {
        await call('browser_set_bounds', { tab: next, bounds })
        await call('browser_show', { tab: next, focus: false })
      }
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current?.native])

  // Leaving the view hides the page; the tab stays.
  useEffect(
    () => () => {
      const shown = shownNative.current
      if (shown) call('browser_hide', { tab: shown })
    },
    [],
  )

  // The page follows the placeholder: window resizes, split drags, the
  // sidebar opening, the bars and strips above it, full screen.
  useEffect(() => {
    if (!pageRef.current) return undefined
    let frame = 0
    const sync = () => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(syncBounds)
    }
    const ro = new ResizeObserver(sync)
    ro.observe(pageRef.current)
    window.addEventListener('resize', sync)
    return () => {
      cancelAnimationFrame(frame)
      ro.disconnect()
      window.removeEventListener('resize', sync)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // A device size changes where the page sits and how it lays out. A tab
  // turning into a phone (or back) reloads, so the site sees the phone.
  const wasMobile = useRef({})
  useEffect(() => {
    const native = current?.native
    if (!native) return
    syncBounds()
    const mobile = Boolean(device?.mobile)
    const flipped = (wasMobile.current[native] ?? false) !== mobile
    wasMobile.current[native] = mobile
    ;(async () => {
      if (device) {
        const r = pageRef.current?.getBoundingClientRect()
        const fit = r ? fitDevice(device, { width: r.width - 32, height: r.height - 32 }) : { scale: 1 }
        await call('browser_viewport', {
          tab: native,
          width: device.width,
          height: device.height,
          mobile,
          scale: fit.scale,
        })
      } else {
        await call('browser_viewport', { tab: native, width: null, height: null, mobile: false, scale: null })
      }
      if (flipped) await call('browser_reload', { tab: native })
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current?.native, device?.width, device?.height, device?.mobile])

  // A console menu or dialog over the page: the page's picture is decoded
  // in its element and shown first, and only once it has been painted
  // does the page step out of view; when the menu closes the page steps
  // back, is given a moment to draw, and the picture hides. A menu opening
  // straight after another (the More menu into Downloads) keeps the
  // picture up in between.
  useEffect(() => {
    let swapped = null
    let leaving = 0
    let frame = 0
    const showPicture = async (url) => {
      const el = pictureRef.current
      const pageBox = pageRef.current?.getBoundingClientRect()
      const at = rect()
      if (!el || !pageBox || !at) return false
      // Exactly the page's own box, on the same whole device pixels: edges
      // that blend into a faint line at a fractional position cannot occur.
      el.style.left = `${at.x - pageBox.left}px`
      el.style.top = `${at.y - pageBox.top}px`
      el.style.width = `${at.width}px`
      el.style.height = `${at.height}px`
      if (el.getAttribute('src') !== url) el.src = url
      await el.decode().catch(() => {})
      el.classList.add('on')
      await frames(2)
      return true
    }
    const settle = async () => {
      const pageBox = pageRef.current?.getBoundingClientRect()
      const rects = [...document.querySelectorAll(FLOATING)].map((el) => el.getBoundingClientRect())
      const tab = shownNative.current
      const cover = Boolean(tab) && covered(pageBox, rects)
      if (cover) {
        clearTimeout(leaving)
        leaving = 0
        if (swapped) return
        swapped = tab
        const shot = await picture$(tab, 600)
        if (swapped !== tab) return
        // No picture, no swap: the menu stays behind the page rather
        // than the page going blank.
        if (!shot || !(await showPicture(shot)) || swapped !== tab) return
        parked.current = true
        syncBounds()
      } else if (swapped && !leaving) {
        leaving = setTimeout(async () => {
          leaving = 0
          swapped = null
          if (parked.current) {
            parked.current = false
            syncBounds()
            await frames(3)
          }
          if (!swapped) pictureRef.current?.classList.remove('on')
        }, 120)
      }
    }
    const check = () => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(settle)
    }
    const mo = new MutationObserver(check)
    mo.observe(document.body, { childList: true, subtree: true })
    return () => {
      cancelAnimationFrame(frame)
      clearTimeout(leaving)
      mo.disconnect()
      if (swapped) {
        parked.current = false
        syncBounds()
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return { shownNative, rect, picture$, precapture, shotRef }
}
