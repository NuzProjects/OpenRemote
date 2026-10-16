// Dev servers seen in chats: a local address (http://localhost:5173 and
// the like) an agent or a tool printed, remembered for this run of the
// app. A plain module, so a chat can note what it saw and the browser's
// new tab page can offer it, without the two knowing each other.

// A local web address: localhost, the loopback addresses, or the
// all-interfaces address servers often print, with a port and a path.
const LOCAL_URL = /\bhttps?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(?::\d{1,5})?(?:\/[^\s"'`<>()[\]{}]*)?/gi
// How many servers are kept, newest first.
const KEEP = 12

let seen = []
const listeners = new Set()

// One server per address and port: its newest sighting wins.
function serverOf(url) {
  return url.replace(/^(https?:\/\/[^/]+).*$/i, '$1').toLowerCase()
}

// The local addresses in a piece of text, each once, in order. A sentence's
// closing punctuation is not part of the address, and 0.0.0.0 (where a
// server listens, not where it is reached) reads as localhost.
export function findDevServers(text) {
  const out = []
  for (const match of String(text ?? '').matchAll(LOCAL_URL)) {
    const url = match[0].replace(/[.,;:!?]+$/, '').replace('://0.0.0.0', '://localhost')
    if (!out.includes(url)) out.push(url)
  }
  return out
}

// Remember the servers a chat's text mentions.
export function noteDevServers(chatId, text) {
  const found = findDevServers(text)
  if (!found.length) return
  const seenAt = Date.now()
  let next = seen
  for (const url of found) {
    next = [{ url, seenAt, chat: chatId }, ...next.filter((s) => serverOf(s.url) !== serverOf(url))]
  }
  seen = next.slice(0, KEEP)
  for (const fn of listeners) fn()
}

// The servers seen, newest first: [{ url, seenAt, chat }].
export function recentDevServers() {
  return seen
}

export function subscribeDevServers(fn) {
  listeners.add(fn)
  return () => listeners.delete(fn)
}
