// Updates, as the console knows them: what the last look found, and a
// look once a day while the app runs (unless the user turned that off).
// The shell does the looking and installing; nothing here runs on a phone.

import { hasTauri, isMobile } from './platform.js'

const AUTO_KEY = 'openremote-check-updates'
const LAST_KEY = 'openremote-last-update-check'
const DAY = 24 * 3600 * 1000

let state = { checking: false, available: null, error: null, checkedAt: null, installing: false }
const listeners = new Set()

function set(change) {
  state = { ...state, ...change }
  for (const fn of listeners) fn()
}

export function updateState() {
  return state
}

export function subscribeUpdates(fn) {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

export function autoCheck() {
  try {
    return localStorage.getItem(AUTO_KEY) !== 'off'
  } catch {
    return true
  }
}

export function setAutoCheck(on) {
  try {
    localStorage.setItem(AUTO_KEY, on ? 'on' : 'off')
  } catch {
    /* storage unavailable: the default (on) stays */
  }
  set({})
}

async function shell(command) {
  const { invoke } = await import('@tauri-apps/api/core')
  return invoke(command)
}

export async function checkForUpdates() {
  if (!hasTauri || isMobile || state.checking) return
  set({ checking: true, error: null })
  try {
    const found = await shell('update_check')
    set({ available: found ?? null, checkedAt: Date.now() })
    try {
      localStorage.setItem(LAST_KEY, String(Date.now()))
    } catch {
      /* the next start looks again */
    }
  } catch (e) {
    set({ error: String(e) })
  } finally {
    set({ checking: false })
  }
}

// Download, verify and install; the app restarts into the new version.
export async function installUpdate() {
  set({ installing: true, error: null })
  try {
    await shell('update_install')
  } catch (e) {
    set({ installing: false, error: String(e) })
  }
}

// A look shortly after start (so it never competes with the app coming
// up), then whenever a day has passed since the last.
export function startUpdateChecks() {
  if (!hasTauri || isMobile) return
  const due = () => {
    if (!autoCheck()) return
    let last = 0
    try {
      last = Number(localStorage.getItem(LAST_KEY) ?? 0)
    } catch {
      last = 0
    }
    if (Date.now() - last > DAY) checkForUpdates()
  }
  setTimeout(due, 30_000)
  setInterval(due, 3600 * 1000)
}
