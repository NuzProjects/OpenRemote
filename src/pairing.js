// Phone pairing on the desktop side: the client for the daemon's pairing
// routes, and the small rules the surface needs in words.
//
// The daemon holds everything that matters. It owns the one live code, the
// listener on the local network, and the phone records; this module never
// invents a code, never sees a phone's credential, and is only ever reached
// over the loopback token the console already uses. Its job is to ask, and
// to say plainly what came back.

import { loadConnection } from './api/daemon.js'

const TIMEOUT_MS = 10000

async function call(method, path) {
  const { url, token } = loadConnection()
  if (!url || !token) {
    throw new Error('The console is not connected to its daemon yet.')
  }
  // Manual entry often omits the scheme; without one, fetch reads the
  // address as a relative path and fails confusingly.
  const base = /^https?:\/\//.test(url) ? url : `http://${url}`
  let response
  try {
    response = await fetch(`${base.replace(/\/+$/, '')}${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
  } catch (err) {
    if (err?.name === 'TimeoutError' || err?.name === 'AbortError') {
      throw new Error('The daemon did not answer in time')
    }
    throw err
  }
  const text = await response.text()
  let json = null
  try {
    json = text ? JSON.parse(text) : null
  } catch {
    json = null
  }
  if (!response.ok) {
    // The daemon writes a sentence a person can read; keep it, and carry
    // the status so the surface can tell "no such phone" from "not now".
    const error = new Error(json?.error ?? `HTTP ${response.status}`)
    error.status = response.status
    throw error
  }
  return json ?? {}
}

// These routes carry no request id: minting twice mints two codes (the
// second replaces the first), and revoking twice is a 404 the surface reads
// as "already gone". A receipt would promise a dedup that does not exist.
export function pairingApi() {
  return {
    /** Show a code: the answer is `{ code, url, expires_at, computer, phones }`. */
    start: () => call('POST', '/pairing/code'),
    /** Stop showing it, and shut the listener if no phone is paired. */
    cancel: () => call('POST', '/pairing/cancel'),
    phones: () => call('GET', '/pairing/phones'),
    revoke: (id) => call('POST', `/pairing/phones/${encodeURIComponent(id)}/revoke`),
  }
}

/**
 * A phone name as this console will show it. The daemon cleans the name it
 * stores (trimmed, one line, at most 40 characters); doing the same here
 * means the list never shows something the daemon would not have kept.
 */
export function phoneName(raw) {
  const clean = String(raw ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 40)
  return clean || 'Phone'
}

/** How long the code has left, as a clock: 4:07, or Expired. */
export function remainingLabel(expiresAt, now = Date.now()) {
  const left = Math.max(0, Math.round((Number(expiresAt) - now) / 1000))
  if (!Number.isFinite(left) || left <= 0) return 'Expired'
  const minutes = Math.floor(left / 60)
  const seconds = String(left % 60).padStart(2, '0')
  return `Expires in ${minutes}:${seconds}`
}

/** When a phone joined, in the console's own shorthand. */
export function pairedLabel(phone, now = Date.now()) {
  const pairedAt = Number(phone?.paired_at)
  if (!Number.isFinite(pairedAt) || pairedAt <= 0) return 'Paired'
  const minutes = Math.round((now - pairedAt) / 60_000)
  if (minutes < 1) return 'Paired just now'
  if (minutes < 60) return `Paired ${minutes} min ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `Paired ${hours} h ago`
  return `Paired ${Math.round(hours / 24)} d ago`
}

/**
 * A failure in the words the surface shows. The daemon's own sentence wins
 * when there is one: it knows why (no network, no free port, a phone that
 * is already gone) and the console would only be guessing.
 */
export function pairingError(err) {
  if (err?.status === 404) return err.message || 'That phone is not paired with this computer.'
  if (err?.status === 409) return err.message || 'This computer cannot take a phone right now.'
  if (err?.message === 'The daemon did not answer in time') {
    return 'The daemon did not answer in time. Try again.'
  }
  if (err?.message === 'The console is not connected to its daemon yet.') return err.message
  if (err instanceof TypeError) return 'The console could not reach its daemon.'
  return err?.message || 'Pairing failed.'
}
