// "Select this element" for the browser pane: what runs in the page to
// let the user point at an element, and what the pick becomes in the
// chat. The page half is a string evaluated through the shell's CDP
// bridge (`browser_cdp` + Runtime.evaluate); the format half is plain
// text for the composer, where the agent reads it. Pure: tested.

// Runs in the page. Highlights what is under the cursor; a click resolves
// to the element's address (a CSS selector), its kind and its words; Esc
// or `window.__orPickCancel = true` resolves to null. A second run while
// one is already picking resolves to null at once.
export const PICKER_SOURCE = `(() => new Promise((resolve) => {
  if (window.__orPicking) { resolve(null); return }
  window.__orPicking = true
  window.__orPickCancel = false
  const frame = document.createElement('div')
  frame.setAttribute('data-or-pick', '1')
  frame.style.cssText = 'position:fixed;z-index:2147483647;pointer-events:none;' +
    'outline:2px solid #7a5cff;outline-offset:1px;background:rgba(122,92,255,.12);display:none'
  document.documentElement.appendChild(frame)
  const over = (el) => el && el !== frame && !el.hasAttribute?.('data-or-pick')
  const place = (el) => {
    if (!over(el)) { frame.style.display = 'none'; return }
    const r = el.getBoundingClientRect()
    if (!r || (r.width === 0 && r.height === 0)) { frame.style.display = 'none'; return }
    frame.style.display = 'block'
    frame.style.left = r.left + 'px'
    frame.style.top = r.top + 'px'
    frame.style.width = r.width + 'px'
    frame.style.height = r.height + 'px'
  }
  const path = (el) => {
    const parts = []
    let node = el
    while (node && node.nodeType === 1 && parts.length < 6) {
      let part = node.tagName.toLowerCase()
      if (node.id && /^[a-zA-Z][\\w-]*$/.test(node.id)) {
        parts.unshift(part + '#' + node.id)
        break
      }
      const cls = (node.className && typeof node.className === 'string' ? node.className : '')
        .trim().split(/\\s+/).filter((c) => /^[a-zA-Z][\\w-]*$/.test(c)).slice(0, 2)
      if (cls.length) part += '.' + cls.join('.')
      const parent = node.parentElement
      if (parent) {
        const same = [...parent.children].filter((s) => s.tagName === node.tagName)
        if (same.length > 1) part += ':nth-of-type(' + (same.indexOf(node) + 1) + ')'
      }
      parts.unshift(part)
      node = parent
    }
    return parts.join(' > ').slice(0, 200)
  }
  const words = (el) => {
    const text = (el.innerText ?? el.textContent ?? '').replace(/\\s+/g, ' ').trim()
    return text.slice(0, 500)
  }
  const cleanup = () => {
    window.__orPicking = false
    clearInterval(timer)
    document.removeEventListener('mousemove', onMove, true)
    document.removeEventListener('click', onClick, true)
    document.removeEventListener('keydown', onKey, true)
    frame.remove()
  }
  const onMove = (e) => place(e.target)
  const onClick = (e) => {
    e.preventDefault()
    e.stopPropagation()
    if (!over(e.target)) { cleanup(); resolve(null); return }
    const r = e.target.getBoundingClientRect()
    const pick = {
      selector: path(e.target),
      tag: e.target.tagName.toLowerCase(),
      text: words(e.target),
      href: e.target.closest?.('a')?.href ?? null,
      rect: { x: Math.round(r.left), y: Math.round(r.top), width: Math.round(r.width), height: Math.round(r.height) },
    }
    cleanup()
    resolve(pick)
  }
  const onKey = (e) => {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); cleanup(); resolve(null) }
  }
  const timer = setInterval(() => {
    if (window.__orPickCancel) { cleanup(); resolve(null) }
  }, 200)
  document.addEventListener('mousemove', onMove, true)
  document.addEventListener('click', onClick, true)
  document.addEventListener('keydown', onKey, true)
}))()`

// Tells a running picker to stand down (the user cancelled from the bar).
export const PICKER_CANCEL = 'window.__orPickCancel = true'

// What the pick becomes in the chat: the page, then the element and its
// words - plain text, the same as if the user had typed it.
export function formatPicked(pick) {
  const title = (pick.title ?? '').trim().slice(0, 80) || 'a page'
  const element = [pick.tag, pick.selector].filter(Boolean).join(' ').slice(0, 220) || 'an element'
  const head = `On “${title}” (${pick.url ?? ''}):`
  const text = (pick.text ?? '').trim()
  if (!text) return `${head}\n${element}`
  const clipped = text.length > 300 ? `${text.slice(0, 299).trimEnd()}…` : text
  const link = pick.href && pick.href !== pick.url ? ` → ${pick.href}` : ''
  return `${head}\n${element}${link} — “${clipped}”`
}
