// The / and @ menu that floats over a composer: grouped rows, the active
// one followed by the keyboard, a dimmed row saying why it can't be
// picked. The textarea keeps focus - the menu never takes it.

import { Fragment, useEffect, useRef } from 'react'
import './composer-menus.css'

export default function ComposerMenu({ items, active, onPick, onHover }) {
  const listRef = useRef(null)

  useEffect(() => {
    listRef.current?.querySelector('[data-active="true"]')?.scrollIntoView({ block: 'nearest' })
  }, [active])

  let group = null
  return (
    <div
      className="cm-menu"
      role="listbox"
      ref={listRef}
      // A click on the menu must not blur the textarea.
      onMouseDown={(e) => e.preventDefault()}
    >
      {items.map((item, i) => {
        const header = item.group && item.group !== group ? item.group : null
        if (header) group = header
        // File paths and chat names are the user's own: blurred in
        // privacy mode, like the rest of their content.
        const personal = item.kind === 'file' || item.kind === 'chat'
        return (
          <Fragment key={item.key}>
            {header && <div className="cm-group">{header}</div>}
            <div
              role="option"
              aria-selected={i === active}
              aria-disabled={item.disabled || undefined}
              data-active={i === active}
              className={`cm-item${i === active ? ' on' : ''}${item.disabled ? ' off' : ''}`}
              onMouseEnter={() => onHover(i)}
              onClick={() => onPick(item)}
            >
              <span className={personal ? 'cm-label pv' : 'cm-label'}>{item.label}</span>
              {item.hint && <span className="cm-hint">{item.hint}</span>}
              {item.badge && <span className="cm-badge">{item.badge}</span>}
              <span className="cm-detail">{item.disabled ? item.why : item.detail}</span>
            </div>
          </Fragment>
        )
      })}
    </div>
  )
}
