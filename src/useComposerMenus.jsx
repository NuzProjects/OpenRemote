// A composer's / and @ menus as a hook: it follows the caret, asks the
// machine that runs the chat what its harness offers (commands, agents,
// MCP servers) and which files match, and hands back the menu to render
// plus the key handling the textarea runs first. The composer stays the
// owner of its text.

import { useEffect, useMemo, useState } from 'react'
import { useConsole } from './state/console.jsx'
import ComposerMenu from './ComposerMenu.jsx'
import { applyPick, argItems, chatList, commandItems, holdDismissal, mentionItems, menuAt, menuKeyOf, ownCommands } from './composer-menus.js'

// The / commands this device picked lately, newest first: the menu's
// "Recent" before anything is typed.
const RECENT_KEY = 'openremote-recent-commands'

function readRecent() {
  try {
    const list = JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]')
    return Array.isArray(list) ? list.filter((n) => typeof n === 'string') : []
  } catch {
    return []
  }
}

function noteRecent(name) {
  try {
    const list = [name, ...readRecent().filter((n) => n !== name)].slice(0, 8)
    localStorage.setItem(RECENT_KEY, JSON.stringify(list))
  } catch {
    /* storage unavailable: no recents, nothing else lost */
  }
}

export function useComposerMenus({
  text,
  setText,
  inputRef,
  harness,
  workspace = null,
  sessionId = null,
  deviceId = null,
  inChat = false,
  cloudReady = false,
  choicesFor = null,
  enabled = true,
}) {
  const { commandsFor, filesFor, chats, connection } = useConsole()
  const [caret, setCaret] = useState(0)
  const [active, setActive] = useState(0)
  // The menu the user closed with Esc stays closed until the caret leaves
  // its word.
  const [dismissed, setDismissed] = useState(null)
  const [view, setView] = useState(null)
  // The last ask for this harness failed: the menus say so instead of
  // showing rows that belong to another harness or another chat.
  const [unavailable, setUnavailable] = useState(false)
  const [files, setFiles] = useState([])

  const menu = enabled ? menuAt(text, caret) : null
  const menuKey = menuKeyOf(menu)
  const open = Boolean(menu) && dismissed !== menuKey

  // An Esc shuts the word it was pressed in, not the composer: once the caret
  // has left that word (the box was cleared, the caret moved on) the
  // dismissal is spent, so the next "/" or "@" opens the menu again.
  useEffect(() => {
    setDismissed((held) => holdDismissal(menu, held))
  }, [menuKey])

  // What the harness offers here: asked when the chat (or the harness and
  // folder a new chat will use) changes, and again when the daemon comes
  // back - a failed ask has to retry on its own, since nothing else about
  // the ask changes.
  useEffect(() => {
    // A new chat is not the last one: drop the previous answer while this ask
    // is in flight, so a rejection leaves an honest empty menu rather than
    // the commands and agents of the harness the user just left.
    setView(null)
    setUnavailable(false)
    if (!enabled || (!harness && !sessionId)) return undefined
    let live = true
    commandsFor({ harness, workspace, session: sessionId, deviceId })
      .then((next) => {
        if (live) setView(next)
      })
      .catch(() => {
        if (live) setUnavailable(true)
      })
    return () => {
      live = false
    }
  }, [enabled, harness, workspace, sessionId, deviceId, commandsFor, connection?.state])

  // Said in place of a list the machine did not answer.
  const unavailableLine = unavailable
    ? 'Commands and agents did not load. They retry when the daemon is back.'
    : null

  // Files for the @ word, a beat after typing stops.
  const fileQuery = open && menu.kind === '@' ? menu.query : null
  useEffect(() => {
    if (fileQuery == null) return undefined
    const controller = new AbortController()
    const timer = setTimeout(() => {
      filesFor({ workspace, session: sessionId, deviceId, q: fileQuery, signal: controller.signal })
        .then((found) => setFiles(found?.entries ?? []))
        .catch(() => {})
    }, 120)
    return () => {
      clearTimeout(timer)
      controller.abort()
    }
  }, [fileQuery, workspace, sessionId, deviceId, filesFor])

  // Other chats to point at: the most recent first, never this one.
  const otherChats = useMemo(
    () =>
      chatList(chats)
        .filter((c) => c.id !== sessionId)
        .slice()
        .sort((a, b) => (b.updated_at ?? 0) - (a.updated_at ?? 0))
        .slice(0, 50),
    [chats, sessionId],
  )

  let items = []
  if (open) {
    if (menu.kind === '/') {
      items = commandItems(menu.query, {
        harnessCommands: view?.commands ?? [],
        own: ownCommands({ inChat, cloud: cloudReady }),
        recent: readRecent(),
        unavailable: unavailableLine,
      })
    } else if (menu.kind === '@') {
      items = mentionItems(menu.query, {
        files,
        agents: view?.agents ?? [],
        servers: view?.mcp_servers ?? [],
        chats: otherChats,
        harness: view?.harness ?? harness,
        unavailable: unavailableLine,
      })
    } else {
      items = argItems(menu.query, choicesFor?.(menu.arg) ?? [])
    }
  }

  // A new menu (or a new word) starts at its first row.
  useEffect(() => {
    setActive(0)
  }, [menuKey, menu?.query])

  const pick = (item) => {
    if (!item || item.disabled || !menu) return
    if (item.kind === 'command') noteRecent(item.insertion.slice(1))
    const next = applyPick(text, menu, item.insertion, { space: item.space !== false })
    setText(next.text)
    setCaret(next.caret)
    requestAnimationFrame(() => {
      const el = inputRef.current
      if (!el) return
      el.focus()
      el.setSelectionRange(next.caret, next.caret)
    })
  }

  // Runs before the composer's own keys; true means it took the key.
  const onKeyDown = (e) => {
    if (!open) return false
    if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      setDismissed(menuKey)
      return true
    }
    if (!items.length) return false
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      e.stopPropagation()
      const step = e.key === 'ArrowDown' ? 1 : -1
      // Notes are read, not picked: the keys step over them.
      setActive((i) => {
        let next = i
        for (let n = 0; n < items.length; n += 1) {
          next = (next + step + items.length) % items.length
          if (!items[next].note) break
        }
        return next
      })
      return true
    }
    if ((e.key === 'Enter' && !e.shiftKey) || e.key === 'Tab') {
      e.preventDefault()
      e.stopPropagation()
      pick(items[active])
      return true
    }
    return false
  }

  // The caret, wherever the textarea reports it.
  const track = (e) => setCaret(e.target.selectionStart ?? 0)

  const element =
    open && items.length > 0 ? (
      <ComposerMenu items={items} active={Math.min(active, items.length - 1)} onPick={pick} onHover={setActive} />
    ) : null

  return { element, onKeyDown, track, open: Boolean(element) }
}
