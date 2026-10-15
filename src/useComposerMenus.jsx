// A composer's / and @ menus as a hook: it follows the caret, asks the
// machine that runs the chat what its harness offers (commands, agents,
// MCP servers) and which files match, and hands back the menu to render
// plus the key handling the textarea runs first. The composer stays the
// owner of its text.

import { useEffect, useMemo, useState } from 'react'
import { useConsole } from './state/console.jsx'
import ComposerMenu from './ComposerMenu.jsx'
import { applyPick, argItems, chatList, commandItems, mentionItems, menuAt, ownCommands } from './composer-menus.js'

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
  const { commandsFor, filesFor, chats } = useConsole()
  const [caret, setCaret] = useState(0)
  const [active, setActive] = useState(0)
  // The menu the user closed with Esc stays closed until the caret leaves
  // its word.
  const [dismissed, setDismissed] = useState(null)
  const [view, setView] = useState(null)
  const [files, setFiles] = useState([])

  const menu = enabled ? menuAt(text, caret) : null
  const menuKey = menu ? `${menu.kind}:${menu.start}` : null
  const open = Boolean(menu) && dismissed !== menuKey

  // What the harness offers here: asked when the chat (or the harness and
  // folder a new chat will use) changes - cached by the console.
  useEffect(() => {
    if (!enabled || (!harness && !sessionId)) return undefined
    let live = true
    commandsFor({ harness, workspace, session: sessionId, deviceId })
      .then((next) => {
        if (live) setView(next)
      })
      .catch(() => {})
    return () => {
      live = false
    }
  }, [enabled, harness, workspace, sessionId, deviceId, commandsFor])

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
      })
    } else if (menu.kind === '@') {
      items = mentionItems(menu.query, {
        files,
        agents: view?.agents ?? [],
        servers: view?.mcp_servers ?? [],
        chats: otherChats,
        harness: view?.harness ?? harness,
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
      setActive((i) => (i + step + items.length) % items.length)
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
