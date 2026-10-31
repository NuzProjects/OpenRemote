import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Check, ClockCounterClockwise, MagnifyingGlass } from '@phosphor-icons/react'
import { isMobile } from './platform.js'
import { useBack } from './use-back.js'
import { resolvePickerSpot } from './picker-anchor.js'
import './pickermenu.css'

/**
 * The cozy dropdown engine shared by the model / harness / device pickers.
 * Opens at the cursor, searches, groups (optional), keyboard-navigates,
 * clamps to the viewport, scrolls internally.
 */
export default function PickerMenu({
  label,
  searchPlaceholder,
  items,
  groups, // [{ label, items }] or null for a flat list
  selectedId,
  onChoose,
  onClose,
  anchor, // { left, top }, from the pointer that opened the menu when there was one
  renderIcon,
  renderTrailing,
  renderSubline, // a muted second line inside the item (efforts, paths)
  wide, // room for sublines without cramped trailing text
  footer, // a pinned action row under the list; renders in the empty state too
  hideSearch = false,
  leaving = false,
  place = 'below',
}) {
  const [query, setQuery] = useState('')
  const [cursor, setCursor] = useState(0)
  const ref = useRef(null)
  const searchRef = useRef(null)
  // The spot is decided once, during the first render, while the trigger that
  // opened the menu still holds focus: a keyboard activation reports no point,
  // and that is the only moment the trigger is knowable. See picker-anchor.js.
  const [spot] = useState(() =>
    resolvePickerSpot(anchor, document.activeElement?.getBoundingClientRect?.() ?? null),
  )

  const filtered = (() => {
    const q = query.trim().toLowerCase()
    if (!q) return items
    return items.filter((i) => i.name.toLowerCase().includes(q))
  })()

  useBack(true, onClose)

  useEffect(() => {
    // On a phone the keyboard would cover the list it's searching; the
    // search field is a tap away.
    if (!hideSearch && !isMobile) searchRef.current?.focus()
    else ref.current?.focus()
    const close = (e) => {
      if (ref.current && ref.current.contains(e.target)) return
      // The chip that opened this menu handles a second press itself. Closing
      // here would run first, and the click would open the menu again.
      if (e.target.closest?.('[data-picker]')) return
      onClose()
    }
    window.addEventListener('mousedown', close)
    return () => window.removeEventListener('mousedown', close)
  }, [onClose])

  useEffect(() => {
    setCursor(Math.max(0, filtered.findIndex((i) => i.id === selectedId)))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query])

  // keep the menu inside the viewport
  useLayoutEffect(() => {
    if (!ref.current) return
    const el = ref.current
    const vw = window.innerWidth
    const vh = window.innerHeight
    const rect = el.getBoundingClientRect()
    // Above the box the menu is shifted with a transform, so the layout rect
    // is already the visual one. Rewriting top from that rect would drop it
    // back onto the field.
    if (place === 'above') {
      let left = spot.left
      if (rect.right > vw - 8) left = Math.max(8, vw - rect.width - 8)
      el.style.left = `${left}px`
      if (rect.top < 8) el.style.top = `${Math.round(spot.top + (8 - rect.top))}px`
      return
    }
    let { left, top } = rect
    let maxHeight = ''
    if (rect.bottom > vh - 8) {
      top = Math.max(8, vh - rect.height - 8)
      if (top + rect.height > vh - 8) {
        top = 8
        maxHeight = `${vh - 16}px`
      }
    }
    if (rect.right > vw - 8) left = Math.max(8, vw - rect.width - 8)
    el.style.left = `${left}px`
    el.style.top = `${top}px`
    el.style.maxHeight = maxHeight
  })

  useEffect(() => {
    ref.current?.querySelector('.nc-item.cursor')?.scrollIntoView({ block: 'nearest' })
  }, [cursor])

  // Keys are handled at the menu root, not on the search input: Tab can
  // move focus to the footer row, and Escape / arrows / Enter keep
  // working from wherever focus sits inside the menu. Enter on a
  // focused footer button is its own native click - the item Enter
  // here only fires when the input still holds focus.
  const onKeyDown = (e) => {
    if (e.key === 'Escape') {
      e.stopPropagation()
      onClose()
      return
    }
    if (!hideSearch && e.target !== searchRef.current) return
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setCursor((c) => Math.min(filtered.length - 1, c + 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setCursor((c) => Math.max(0, c - 1))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      const item = filtered[cursor]
      if (item) onChoose(item.id)
    }
  }

  const grouped = groups
    ? (() => {
        const byLabel = new Map()
        for (const item of filtered) {
          const g = item.group ?? ''
          if (!byLabel.has(g)) byLabel.set(g, [])
          byLabel.get(g).push(item)
        }
        return [...byLabel.entries()].map(([label, items]) => ({ label, items }))
      })()
    : [{ label: null, items: filtered }]

  let flatIndex = -1

  // The empty state reads differently by cause: a search that found
  // nothing names the query; a list with nothing in it yet says so
  // plainly ("no harnesses yet" is the moment the footer row carries
  // the action). A label ending in a consonant and a y takes "ies".
  const plural = (word) => {
    const lower = word.toLowerCase()
    if (lower.endsWith('s')) return `${lower}es`
    if (/[^aeiou]y$/.test(lower)) return `${lower.slice(0, -1)}ies`
    return `${lower}s`
  }
  const emptyLine = query.trim()
    ? `No ${plural(label)} match "${query}"`
    : `No ${plural(label)} yet`

  return (
    <div
      ref={ref}
      className={`nc-menu${wide ? ' nc-menu--wide' : ''}${leaving ? ' is-out' : ''}${place === 'above' ? ' is-above' : ''}`}
      role="listbox"
      tabIndex={-1}
      aria-label={label}
      style={spot}
      onKeyDown={onKeyDown}
    >
      {!hideSearch && <label className="nc-search">
        <MagnifyingGlass size={13} />
        <input
          ref={searchRef}
          value={query}
          onChange={(e) => {
            setQuery(e.target.value)
            setCursor(0)
          }}
          placeholder={searchPlaceholder}
          spellCheck={false}
        />
      </label>}
      <div className="nc-items">
        {grouped.map((group) => (
          <div key={group.label ?? 'all'} className="nc-group">
            {group.label && (
              <div className="nc-group-label">
                {group.label === 'Installed' && <ClockCounterClockwise size={10} />}
                {group.label}
              </div>
            )}
            {group.items.map((item) => {
              flatIndex++
              const i = flatIndex
              return (
                <button
                  key={item.id}
                  className={`nc-item${item.id === selectedId ? ' selected' : ''}${
                    i === cursor ? ' cursor' : ''
                  }`}
                  role="option"
                  aria-selected={item.id === selectedId}
                  onClick={() => onChoose(item.id)}
                  onMouseEnter={() => setCursor(i)}
                >
                  <span className="nc-item-main">
                    {renderIcon?.(item)}
                    {/* an item marked veiled carries the user's own name for a thing
                        (a project, a machine): privacy mode blurs it */}
                    <span className={item.veiled ? 'nc-item-name pv' : 'nc-item-name'}>{item.name}</span>
                    {renderTrailing?.(item)}
                    {item.id === selectedId && <Check size={13} className="nc-check" />}
                  </span>
                  {renderSubline?.(item)}
                </button>
              )
            })}
          </div>
        ))}
        {filtered.length === 0 && <div className="nc-empty">{emptyLine}</div>}
      </div>
      {footer && <div className="nc-footer">{footer}</div>}
    </div>
  )
}
