// What the browser's address bar does with what was typed: an address to
// open, one of the browser's own pages, or a search. Pure: tested without
// a DOM.

export const SEARCH_ENGINES = {
  google: { name: 'Google', url: 'https://www.google.com/search?q=' },
  duckduckgo: { name: 'DuckDuckGo', url: 'https://duckduckgo.com/?q=' },
  bing: { name: 'Bing', url: 'https://www.bing.com/search?q=' },
  brave: { name: 'Brave Search', url: 'https://search.brave.com/search?q=' },
  startpage: { name: 'Startpage', url: 'https://www.startpage.com/do/search?q=' },
}

export function engineName(engine) {
  return (SEARCH_ENGINES[engine] ?? SEARCH_ENGINES.google).name
}

export function searchUrl(text, engine = 'google') {
  const base = (SEARCH_ENGINES[engine] ?? SEARCH_ENGINES.google).url
  return base + encodeURIComponent(text)
}

// The browser's own pages, drawn by the console in the page's place:
// openremote://<name>. Settings is the app's own Settings > Browser.
export const PAGES = {
  history: 'History',
  downloads: 'Downloads',
  bookmarks: 'Bookmarks',
  settings: 'Settings',
}

export function pageUrl(name) {
  return `openremote://${name}`
}

// The page an address names (`newtab` included), or null.
export function internalPage(input) {
  const m = /^openremote:\/\/([a-z]+)\/?$/i.exec((input ?? '').trim())
  if (!m) return null
  const name = m[1].toLowerCase()
  return Object.hasOwn(PAGES, name) || name === 'newtab' ? name : null
}

const LOCAL = /^(localhost|127(?:\.\d{1,3}){3}|\[::1\]|\d{1,3}(?:\.\d{1,3}){3})(:\d{1,5})?([/?#].*)?$/i
const DOMAIN = /^[^\s/?#:]+\.[a-z][a-z0-9-]*\.?(:\d{1,5})?([/?#]\S*)?$/i
const SCHEME = /^(https?|file):\/\/\S+$/i

// What a typed line is: 'page' (one of the browser's own), 'address',
// 'search', or null for nothing to open (blank, or a script address).
export function addressKind(input) {
  const text = (input ?? '').trim()
  if (!text || /^javascript:/i.test(text)) return null
  if (internalPage(text)) return 'page'
  if (SCHEME.test(text) || /^about:(blank)$/i.test(text) || LOCAL.test(text) || DOMAIN.test(text)) {
    return 'address'
  }
  return 'search'
}

// The address to open for a line typed in the address bar, or null when
// there is nothing to open. A script address never runs from here.
export function omnibox(input, engine = 'google') {
  const text = (input ?? '').trim()
  const kind = addressKind(text)
  if (!kind) return null
  if (kind === 'page') return pageUrl(internalPage(text))
  if (kind === 'search') return searchUrl(text, engine)
  if (SCHEME.test(text) || /^about:/i.test(text)) return text
  // A local address is the user's own dev server: plain http.
  if (LOCAL.test(text)) return `http://${text}`
  return `https://${text}`
}

// What the address bar shows for a page: the address as it is, except a
// search shows its words (Chrome shows the address; we keep that, plain).
export function shownAddress(url) {
  if (!url || url === 'about:blank') return ''
  return url
}

// Whether a page arrived over a secure connection, for the lock.
export function security(url) {
  if (!url) return 'none'
  if (url.startsWith('https://')) return 'secure'
  if (/^http:\/\/(localhost|127\.|\[::1\])/i.test(url)) return 'local'
  if (url.startsWith('http://')) return 'insecure'
  return 'none'
}

// An address as people type it: no scheme, no leading www.
export function bareAddress(url) {
  return String(url ?? '')
    .toLowerCase()
    .replace(/^[a-z][a-z0-9+.-]*:\/\//, '')
    .replace(/^www\./, '')
}

// What the address bar completes a typed beginning to from a suggested
// address: the site, or the whole address once the user types past the
// site. Null when the address doesn't start with what was typed (or the
// typing is words, a search).
export function completion(typed, url) {
  const text = String(typed ?? '')
  if (!text || /\s/.test(text) || text.includes('://')) return null
  const lower = text.toLowerCase().replace(/^www\./, '')
  const bare = bareAddress(url).replace(/\/$/, '')
  if (!lower || !bare.startsWith(lower)) return null
  const whole = lower.includes('/') ? bare : bare.split('/')[0]
  if (whole.length <= lower.length) return null
  return text + whole.slice(lower.length)
}
