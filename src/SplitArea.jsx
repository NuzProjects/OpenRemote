import { useEffect, useRef, useState } from 'react'
import { ArrowDown, ArrowLeft, ArrowRight, ArrowUp, DotsThree, FloppyDisk, SquaresFour, X } from '@phosphor-icons/react'
import ContextMenu from './ContextMenu.jsx'
import SplitGlyph from './SplitGlyph.jsx'
import { HarnessMark } from './brand-marks.jsx'
import { useHint, useKeyboard } from './keyboard.jsx'
import { MIN_PANES, loadLayouts, offerLayouts } from './layouts.js'
import { paneChatId, paneHeader } from './pane-header.js'
import { projectFor } from './projects.js'
import { useConsole } from './state/console.jsx'
import {
  MAX_PANES,
  acceptsChatDrop,
  balanceSplit,
  chatDragPayload,
  closeLeaf,
  CHAT_DRAG_TYPE,
  createDividerDrag,
  draggedChat,
  focusLeaf,
  paneCount,
  resizeSplit,
  splitLeaf,
  tintZone,
} from './split.js'
import './split.css'

function SplitNode({ node, setLayout, renderNode }) {
  const ref = useRef(null)
  const row = node.dir === 'row'
  const startDrag = (index) => (e) => {
    e.preventDefault()
    const box = ref.current?.getBoundingClientRect()
    if (!box) return
    const total = row ? box.width : box.height
    // One controller for the whole gesture: it returns the sizes to paint on
    // every move and the single delta to commit on release. Painting is two
    // inline flex values on the cells this strip divides, so dragging beside
    // a streaming chat does not re-render the transcript at pointer rate.
    const drag = createDividerDrag({
      sizes: node.sizes,
      index,
      total,
      start: row ? e.clientX : e.clientY,
    })
    const target = e.currentTarget
    target.setPointerCapture(e.pointerId)
    const move = (ev) => {
      const { sizes } = drag.move(row ? ev.clientX : ev.clientY)
      const cells = ref.current?.children
      if (!cells?.[index] || !cells?.[index + 1]) return
      cells[index].style.flex = `${sizes[index]} 1 0`
      cells[index + 1].style.flex = `${sizes[index + 1]} 1 0`
    }
    const done = () => {
      target.removeEventListener('pointermove', move)
      target.removeEventListener('pointerup', done)
      target.removeEventListener('pointercancel', done)
      // The one layout commit of the drag. A gesture that never moved (the
      // first half of a double-click on the strip) commits nothing, so it
      // cannot churn the shell either.
      const delta = drag.release()
      if (delta !== 0) setLayout((l) => resizeSplit(l, node.id, index, delta))
    }
    target.addEventListener('pointermove', move)
    target.addEventListener('pointerup', done)
    target.addEventListener('pointercancel', done)
  }
  return (
    <div className={`split-node split-node--${node.dir}`} ref={ref}>
      {node.children.map((child, i) => (
        <div className="split-cell" key={child.id} style={{ flex: `${node.sizes[i]} 1 0` }}>
          {renderNode(child)}
          {i < node.children.length - 1 && (
            <div
              className="split-divider"
              role="separator"
              aria-label="Resize the panes"
              aria-orientation={row ? 'vertical' : 'horizontal'}
              title="Drag to resize. Double-click to even them out."
              onPointerDown={startDrag(i)}
              onDoubleClick={() => setLayout((l) => balanceSplit(l, node.id))}
            />
          )}
        </div>
      ))}
    </div>
  )
}

// One pane: its header (a title, the split actions, close) and the view it
// holds. Dropping a chat on the middle keeps it here; dropping it on an
// outer band splits this pane on that side, with the half it will take
// highlighted while the chat hovers.
function Pane({
  node,
  layout,
  setLayout,
  renderPane,
  labelFor,
  showHeader,
  onDropInPane,
  canSplit,
  onSaveLayout,
  onRestoreLayout,
  currentChat,
}) {
  const [menu, setMenu] = useState(null)
  // The saved-layouts menu, in the same pattern as the split menu above it:
  // a ContextMenu anchored under its own button, with the same keys.
  const [layoutMenu, setLayoutMenu] = useState(null)
  const layoutsRef = useRef(null)
  const [zone, setZone] = useState(null)
  const place = useRef(null)
  const menuRef = useRef(null)
  const count = paneCount(layout)
  const focused = layout.focus === node.id
  const primary = node.view === null
  const full = count >= MAX_PANES
  // Whether a split can happen at all: false at the pane cap, and false on a
  // phone, which has no panes. The buttons, the menu and the drop tint all
  // read this one value, so nothing offers a split the shell will refuse.
  const splittable = Boolean(canSplit) && !full
  const label = labelFor(node)
  // What a person needs to tell this header from the one beside it: the chat
  // record's own project, harness and status, on top of the shell's label for
  // the pane. A pane holding no chat keeps the role's name.
  const { chats, projects } = useConsole()
  const chatId = paneChatId(node.view, currentChat)
  const chat = chatId ? (chats?.[chatId] ?? null) : null
  const head = paneHeader({
    label,
    chat,
    project: chat ? projectFor(projects ?? [], chat.workspace) : null,
  })
  const headTitle = primary ? head.title : `${head.title} - drag onto another pane's edge to move it`
  const hintRight = useHint('split-right')
  const hintDown = useHint('split-down')
  const kb = useKeyboard()

  const splitTo = (dir, before) => () => setLayout((l) => splitLeaf(l, node.id, dir, 'new', before))

  const openMenu = () => {
    const box = menuRef.current?.getBoundingClientRect()
    if (box) setMenu({ x: box.right - 208, y: box.bottom + 4 })
  }

  // The saved layouts are read when the menu opens, not held in state: a shape
  // saved from the palette (or another pane) is in storage by then, and a
  // stale list would offer a layout that is no longer there.
  const openLayoutMenu = () => {
    const box = layoutsRef.current?.getBoundingClientRect()
    if (!box) return
    setLayoutMenu({ x: box.right - 208, y: box.bottom + 4 })
  }

  const layoutMenuItems = () => {
    const offers = offerLayouts(loadLayouts(), { currentChat })
    const items = []
    if (offers.length === 0) items.push({ header: 'No saved layouts yet' })
    for (const offer of offers) {
      items.push({
        label: offer.name,
        icon: <SquaresFour size={14} />,
        hint: offer.countLine,
        // A shape this window cannot hold stays in the menu with its reason
        // under it: an entry that vanishes teaches nothing.
        disabled: !offer.ok,
        onSelect: offer.ok ? () => onRestoreLayout(offer.plan) : undefined,
      })
      if (!offer.ok) items.push({ header: offer.note })
    }
    // Saving is the one thing the header offers when the window is already
    // split: a one-pane window is not a shape, so there would be nothing to
    // save (layouts.js's MIN_PANES).
    if (count >= MIN_PANES && onSaveLayout) {
      if (items.length) items.push({ divider: true })
      items.push({ label: 'Save this layout…', icon: <FloppyDisk size={14} />, onSelect: () => onSaveLayout() })
    }
    return items
  }

  const menuItems = [
    ...(full ? [{ header: `${MAX_PANES} panes is the most` }] : []),
    { label: 'Split right', icon: <ArrowRight size={14} />, hint: kb?.label('split-right'), disabled: !splittable, onSelect: splitTo('row', false) },
    { label: 'Split down', icon: <ArrowDown size={14} />, hint: kb?.label('split-down'), disabled: !splittable, onSelect: splitTo('col', false) },
    { label: 'Split left', icon: <ArrowLeft size={14} />, disabled: !splittable, onSelect: splitTo('row', true) },
    { label: 'Split up', icon: <ArrowUp size={14} />, disabled: !splittable, onSelect: splitTo('col', true) },
  ]

  const over = (e) => {
    if (!onDropInPane) return
    // Only a chat may tint a pane. The payload is unreadable during dragover,
    // so the drag's own types are the check: a file or a selected paragraph
    // never passes it, and the pane does not promise an action it cannot do.
    if (!acceptsChatDrop(e.dataTransfer.types)) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
    const box = e.currentTarget.getBoundingClientRect()
    // Where no split is possible the drop replaces this pane's view, so the
    // tint covers the whole pane rather than a half it will not become.
    const next = tintZone(splittable, box, e.clientX, e.clientY)
    place.current = next
    setZone(next.zone)
  }

  const leave = (e) => {
    // A missing relatedTarget is the pointer leaving the window (or a drag the
    // browser cancelled), not a move between children.
    if (e.relatedTarget && e.currentTarget.contains(e.relatedTarget)) return
    place.current = null
    setZone(null)
  }

  const drop = (e) => {
    const view = draggedChat(e.dataTransfer)
    const at = place.current ?? { zone: 'center' }
    place.current = null
    setZone(null)
    if (!view) return
    e.preventDefault()
    onDropInPane?.(node.id, view, at)
  }

  // A drag can end away from this pane: dropped on the window, cancelled with
  // Esc, or lost with the pointer. The tint is cleared from the window as
  // well, so no half-pane highlight outlives the drag that drew it.
  useEffect(() => {
    if (!zone) return undefined
    const clear = () => {
      place.current = null
      setZone(null)
    }
    window.addEventListener('dragend', clear)
    window.addEventListener('drop', clear)
    return () => {
      window.removeEventListener('dragend', clear)
      window.removeEventListener('drop', clear)
    }
  }, [zone])

  return (
    <section
      className={`split-pane${focused ? ' focused' : ''}${zone ? ` drop-${zone}` : ''}`}
      data-leaf-id={node.id}
      onPointerDownCapture={() => setLayout((l) => focusLeaf(l, node.id))}
      aria-label={label}
    >
      {showHeader && (
        <header className="split-bar">
          <span
            className={`split-label${head.chat ? ' split-label--chat' : ''}`}
            title={headTitle}
            draggable={!primary && node.view !== 'new'}
            onDragStart={(e) => {
              // The same pair the sidebar writes: the private type the panes
              // test, and the prefixed text/plain an older reader understands.
              e.dataTransfer.setData(CHAT_DRAG_TYPE, node.view)
              e.dataTransfer.setData('text/plain', chatDragPayload(node.view))
              e.dataTransfer.effectAllowed = 'move'
            }}
          >
            {/* The sidebar's dot, in the sidebar's language: same classes, same
                status values, so a streaming or waiting pane reads the same as
                its row does. */}
            {head.chat && <span className={`dot dot--${head.status}`} aria-hidden="true" />}
            {head.chat && head.harness && <HarnessMark harness={head.harness} size={12} />}
            <span className="split-title">{head.title}</span>
            {head.project && <span className="split-project">{`· ${head.project}`}</span>}
          </span>
          <div className="split-actions">
            <button
              type="button"
              className="split-btn"
              title={hintRight('Split right')}
              aria-label="Split right"
              disabled={!splittable}
              onClick={splitTo('row', false)}
            >
              <SplitGlyph size={14} />
            </button>
            {/* The saved shapes, beside the split: one control, the same menu
                pattern as the split options, and only when the shell has
                handed the header a way to put a shape back. */}
            {onRestoreLayout && (
              <button
                type="button"
                ref={layoutsRef}
                className="split-btn split-btn--text"
                title="Saved layouts"
                aria-label="Saved layouts"
                aria-haspopup="menu"
                aria-expanded={Boolean(layoutMenu)}
                onClick={openLayoutMenu}
              >
                Layouts
              </button>
            )}
            <button
              type="button"
              ref={menuRef}
              className="split-btn"
              title="Split this pane another way"
              aria-label="More split options"
              aria-haspopup="menu"
              aria-expanded={Boolean(menu)}
              onClick={openMenu}
            >
              <DotsThree size={16} weight="bold" />
            </button>
            {!primary && (
              <button
                type="button"
                className="split-btn"
                title="Close this pane"
                aria-label="Close this pane"
                onClick={() => setLayout((l) => closeLeaf(l, node.id))}
              >
                <X size={13} />
              </button>
            )}
          </div>
        </header>
      )}
      <div
        className="split-body"
        onDragOver={over}
        onDragLeave={leave}
        onDrop={drop}
      >
        {renderPane(node)}
        {zone && <div className={`split-drop split-drop--${zone}`} aria-hidden="true" />}
      </div>
      {menu && <ContextMenu x={menu.x} y={menu.y} items={menuItems} onClose={() => setMenu(null)} />}
      {layoutMenu && (
        <ContextMenu
          x={layoutMenu.x}
          y={layoutMenu.y}
          items={layoutMenuItems()}
          onClose={() => setLayoutMenu(null)}
        />
      )}
    </section>
  )
}

// Renders a split layout: nested rows and columns of panes with draggable
// dividers. What a pane shows is the caller's (`renderPane`), so Local and
// Cloud chats, new-chat composers and the primary view all share one frame.
// One pane is the app's whole main area, headerless; two or more get the
// headers, because that is where the split and close actions live and where a
// saved shape is put back.
//
// `onRestoreLayout` is the shell's own "apply this plan" (it owns the layout
// and the primary pane's view), and `currentChat` is the chat a restored
// "chat" pane should hold; without them the header offers no Layouts control
// rather than a menu that cannot do anything.
export default function SplitArea({
  layout,
  setLayout,
  renderPane,
  labelFor,
  onDropInPane,
  canSplit = true,
  onSaveLayout = null,
  onRestoreLayout = null,
  currentChat = null,
}) {
  const count = paneCount(layout)

  const renderNode = (node) => {
    if (node.type === 'leaf') {
      return (
        <Pane
          key={node.id}
          node={node}
          layout={layout}
          setLayout={setLayout}
          renderPane={renderPane}
          labelFor={labelFor}
          showHeader={count > 1}
          onDropInPane={onDropInPane}
          canSplit={canSplit}
          onSaveLayout={onSaveLayout}
          onRestoreLayout={onRestoreLayout}
          currentChat={currentChat}
        />
      )
    }
    return <SplitNode key={node.id} node={node} setLayout={setLayout} renderNode={renderNode} />
  }

  return <div className={`split-area${count > 1 ? ' is-split' : ''}`}>{renderNode(layout.root)}</div>
}
