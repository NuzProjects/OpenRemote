// What the browser's address bar does with what was typed: an address to
// open, or a search. Pure: tested without a DOM.

export const SEARCH_ENGINES = {
  google: { name: 'Google', url: 'https://www.google.com/search?q=' },
  duckduckgo: { name: 'DuckDuckGo', url: 'https://duckduckgo.com/?q=' },
  bing: { name: 'Bing', url: 'https://www.bing.com/search?q=' },
  brave: { name: 'Brave Search', url: 'https://search.brave.com/search?q=' },
  startpage: { name: 'Startpage', url: 'https://www.startpage.com/do/search?q=' },
}

export function searchUrl(text, engine = 'google') {
  const base = (SEARCH_ENGINES[engine] ?? SEARCH_ENGINES.google).url
  return base + encodeURIComponent(text)
}

const LOCAL = /^(localhost|127(?:\.\d{1,3}){3}|\[::1\]|\d{1,3}(?:\.\d{1,3}){3})(:\d{1,5})?([/?#].*)?$/i
const DOMAIN = /^[^\s/?#:]+\.[a-z][a-z0-9-]*\.?(:\d{1,5})?([/?#]\S*)?$/i
const SCHEME = /^(https?|file):\/\/\S+$/i

// The address to open for a line typed in the address bar, or null when
// there is nothing to open. A script address never runs from here.
export function omnibox(input, engine = 'google') {
  const text = (input ?? '').trim()
  if (!text) return null
  if (/^javascript:/i.test(text)) return null
  if (SCHEME.test(text) || /^about:(blank)$/i.test(text)) return text
  // A local address is the user's own dev server: plain http.
  if (LOCAL.test(text)) return `http://${text}`
  if (DOMAIN.test(text)) return `https://${text}`
  return searchUrl(text, engine)
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
