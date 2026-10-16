// The address bar: the site's lock, the page's address, the star, and -
// as the user types - suggestions under it: a search for the words first
// when they aren't an address, then the browser's own pages and the pages
// from history and bookmarks that match. Arrows and Enter pick one; Tab or
// Right accepts the address completed inline; Esc closes the list, then
// puts the page's address back.

import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import {
  ClockCounterClockwise,
  Detective,
  DownloadSimple,
  GearSix,
  Globe,
  Lock,
  MagnifyingGlass,
  Star,
  Warning,
} from '@phosphor-icons/react'
import {
  PAGES,
  addressKind,
  bareAddress,
  completion,
  engineName,
  internalPage,
  omnibox,
  pageUrl,
  searchUrl,
  security,
  shownAddress,
} from './browser-omnibox.js'
import { originOf, zoomLabel } from './browser-chrome.js'

const PAGE_ICONS = { history: ClockCounterClockwise, downloads: DownloadSimple, bookmarks: Star, settings: GearSix }
// How many suggestions the list shows at most.
const ROWS = 8

function RowIcon({ row, icons }) {
  if (row.kind === 'search') return <MagnifyingGlass size={15} />
  const Page = PAGE_ICONS[internalPage(row.url)]
  if (Page) return <Page size={15} />
  const icon = icons[originOf(row.url)]
  if (icon) return <img className="bw-favicon" src={icon} alt="" />
  return <Globe size={15} />
}

export default function BrowserOmnibox({ tab, live, engine, bookmarked, api, icons, handle, act, hint }) {
  const inputRef = useRef(null)
  // What the user typed, and what the field shows: the same, or the typed
  // beginning followed by its inline completion (selected, so the next key
  // replaces it).
  const [typed, setTyped] = useState('')
  const [value, setValue] = useState('')
  const [editing, setEditing] = useState(false)
  const [found, setFound] = useState({ q: '', items: [] })
  const [open, setOpen] = useState(false)
  const [cursor, setCursor] = useState(-1)
  const typedRef = useRef('')
  // Whether the last edit typed forward at the end (completed inline), not
  // a deletion or an edit in the middle.
  const forward = useRef(false)
  const selection = useRef(null)

  // Another tab: an edit in progress was this tab's, and ends.
  useEffect(() => {
    setEditing(false)
  }, [tab?.key])

  // The field follows the tab unless the user is typing in it.
  useEffect(() => {
    if (editing) return
    const shown = shownAddress(tab?.url)
    typedRef.current = shown
    setTyped(shown)
    setValue(shown)
    setOpen(false)
  }, [tab?.url, tab?.key, editing])

  handle.current = {
    focus: () => {
      setEditing(true)
      requestAnimationFrame(() => {
        inputRef.current?.focus()
        inputRef.current?.select()
      })
    },
    clear: () => {
      setEditing(true)
      typedRef.current = ''
      setTyped('')
      setValue('')
      setOpen(false)
      requestAnimationFrame(() => inputRef.current?.focus())
    },
  }

  // The pages that match what's typed, from the daemon (history and
  // bookmarks); the first that starts with it completes the field inline.
  useEffect(() => {
    const q = typed.trim()
    if (!editing || !open || !q || !api?.ready) return undefined
    let cancelled = false
    const timer = setTimeout(async () => {
      let items = []
      try {
        items = (await api.call('GET', `/browser/suggest?q=${encodeURIComponent(q)}`)) ?? []
      } catch {
        items = []
      }
      if (cancelled || typedRef.current !== typed) return
      setFound({ q: typed, items: Array.isArray(items) ? items : [] })
      if (!forward.current) return
      const inline = items.map((s) => completion(typed, s.url)).find(Boolean)
      const el = inputRef.current
      if (inline && el && document.activeElement === el && el.selectionStart === typed.length) {
        selection.current = [typed.length, inline.length]
        setValue(inline)
      }
    }, 60)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [typed, editing, open, api])

  useLayoutEffect(() => {
    const range = selection.current
    if (!range || !inputRef.current) return
    selection.current = null
    inputRef.current.setSelectionRange(range[0], range[1])
  }, [value])

  const text = value.trim()
  const kind = addressKind(text)
  const head = !text
    ? null
    : kind === 'search'
      ? { kind: 'search', label: `${text} - ${engineName(engine)} Search`, url: searchUrl(text, engine) }
      : kind
        ? { kind: 'go', label: text, url: omnibox(text, engine) }
        : null
  const pages =
    text.length >= 3
      ? Object.keys(PAGES)
          .map(pageUrl)
          .filter((u) => u.startsWith(text.toLowerCase()) && u !== head?.url)
          .map((u) => ({ kind: 'page', label: u, url: u }))
      : []
  const hits = (found.q === typed ? found.items : [])
    .filter((s) => s?.url && s.url !== head?.url)
    .map((s) => ({ kind: 'hit', label: s.title || bareAddress(s.url), sub: bareAddress(s.url), url: s.url, bookmarked: s.bookmarked }))
  const rows = [head, ...pages, ...hits].filter(Boolean).slice(0, ROWS)
  const showList = open && editing && rows.length > 0

  const go = (target) => {
    setOpen(false)
    setEditing(false)
    inputRef.current?.blur()
    act.go(target)
  }

  const onKeyDown = (e) => {
    const el = e.currentTarget
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      if (!showList) return
      e.preventDefault()
      // -1 is the field itself (what was typed); the arrows wrap through it.
      const step = e.key === 'ArrowDown' ? 1 : -1
      setCursor((c) => ((c + 1 + step + rows.length + 1) % (rows.length + 1)) - 1)
      return
    }
    if ((e.key === 'Tab' && !e.shiftKey) || e.key === 'ArrowRight') {
      // The inline completion is selected to the end: take it.
      if (value !== typed && el.selectionStart === typed.length && el.selectionEnd === value.length) {
        e.preventDefault()
        typedRef.current = value
        forward.current = false
        setTyped(value)
        el.setSelectionRange(value.length, value.length)
        return
      }
      // A suggestion picked with the arrows: its address in the field.
      if (e.key === 'Tab' && showList && rows[cursor]) {
        e.preventDefault()
        const url = rows[cursor].kind === 'search' ? text : rows[cursor].url
        typedRef.current = url
        forward.current = false
        setTyped(url)
        setValue(url)
        setCursor(-1)
      }
      return
    }
    if (e.key === 'Escape') {
      // The app's Esc (stopping a chat's turn) never fires from here.
      e.preventDefault()
      if (showList || value !== typed) {
        setOpen(false)
        setCursor(-1)
        setValue(typed)
        return
      }
      setEditing(false)
      el.blur()
      return
    }
    if (e.key === 'Enter') {
      e.preventDefault()
      const row = showList && cursor >= 0 ? rows[cursor] : null
      go(row ? row.url : value)
    }
  }

  const lock = security(tab?.url)
  const zoomed = (tab?.zoom ?? 1) !== 1

  return (
    <div className="bw-address">
      <button
        type="button"
        className={`bw-site ${lock}`}
        title="Site information"
        data-bw-anchor="site"
        disabled={!live}
        onClick={(e) => act.menu('site', e.currentTarget)}
      >
        {lock === 'insecure' ? <Warning size={14} /> : lock === 'none' ? <Globe size={14} /> : <Lock size={14} />}
        {lock === 'insecure' && <span className="bw-site-word">Not secure</span>}
      </button>
      {tab?.private && (
        <span className="bw-private" title="A private tab: not kept in history, not restored, hidden from agents unless you share it">
          <Detective size={13} />
          Private
        </span>
      )}
      <input
        ref={inputRef}
        value={value}
        placeholder={`Search ${engineName(engine)} or type a URL`}
        spellCheck={false}
        autoComplete="off"
        aria-label="Address and search bar"
        aria-expanded={showList}
        aria-autocomplete="both"
        onChange={(e) => {
          const next = e.target.value
          forward.current = Boolean(e.nativeEvent.inputType?.startsWith('insert')) && e.target.selectionStart === next.length
          typedRef.current = next
          setEditing(true)
          setTyped(next)
          setValue(next)
          setCursor(-1)
          setOpen(Boolean(next.trim()))
        }}
        onFocus={(e) => {
          setEditing(true)
          e.target.select()
          // Suggestions will cover the page: its picture, taken ahead.
          act.precapture?.()
        }}
        onBlur={() => {
          setEditing(false)
          setOpen(false)
          setCursor(-1)
        }}
        onKeyDown={onKeyDown}
      />
      {zoomed && (
        <button type="button" className="bw-zoom" title={hint('Reset zoom', 'browser-zoom-reset')} onClick={() => act.zoom(0)}>
          {zoomLabel(tab.zoom)}
        </button>
      )}
      {tab?.url && (
        <button
          type="button"
          className={`bw-star${bookmarked ? ' on' : ''}`}
          data-bw-anchor="star"
          title={hint(bookmarked ? 'Edit bookmark' : 'Bookmark this tab', 'browser-bookmark')}
          onMouseDown={(e) => e.preventDefault()}
          onClick={(e) => act.star(e.currentTarget)}
        >
          <Star size={15} weight={bookmarked ? 'fill' : 'regular'} />
        </button>
      )}
      {showList && (
        <div className="bw-suggest" role="listbox" aria-label="Suggestions" onMouseDown={(e) => e.preventDefault()}>
          {rows.map((r, i) => (
            <div
              key={`${r.kind}:${r.url}`}
              role="option"
              aria-selected={i === cursor}
              className={`bw-suggest-row${i === cursor ? ' cursor' : ''}`}
              onMouseEnter={() => setCursor(i)}
              onClick={() => go(r.url)}
            >
              <span className="bw-suggest-icon">
                <RowIcon row={r} icons={icons} />
              </span>
              <span className="bw-suggest-title">{r.label}</span>
              {r.sub && r.sub !== r.label && <span className="bw-suggest-url">{r.sub}</span>}
              {r.bookmarked && <Star size={12} weight="fill" className="bw-suggest-star" aria-label="Bookmarked" />}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
