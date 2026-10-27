import { useRef, useState } from 'react'
import { ArrowDown, ArrowLeft, ArrowRight, ArrowUp, DotsThree, X } from '@phosphor-icons/react'
import ContextMenu from './ContextMenu.jsx'
import SplitGlyph from './SplitGlyph.jsx'
import { useHint, useKeyboard } from './keyboard.jsx'
import {
  MAX_PANES,
  balanceSplit,
  chatDragPayload,
  closeLeaf,
  createDividerDrag,
  draggedChat,
  dropZone,
  focusLeaf,
  paneCount,
  resizeSplit,
  splitLeaf,
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
function Pane({ node, layout, setLayout, renderPane, labelFor, showHeader, onDropInPane }) {
  const [menu, setMenu] = useState(null)
  const [zone, setZone] = useState(null)
  const place = useRef(null)
  const menuRef = useRef(null)
  const count = paneCount(layout)
  const focused = layout.focus === node.id
  const primary = node.view === null
  const full = count >= MAX_PANES
  const label = labelFor(node)
  const hintRight = useHint('split-right')
  const hintDown = useHint('split-down')
  const kb = useKeyboard()

  const splitTo = (dir, before) => () => setLayout((l) => splitLeaf(l, node.id, dir, 'new', before))

  const openMenu = () => {
    const box = menuRef.current?.getBoundingClientRect()
    if (box) setMenu({ x: box.right - 208, y: box.bottom + 4 })
  }

  const menuItems = [
    ...(full ? [{ header: `${MAX_PANES} panes is the most` }] : []),
    { label: 'Split right', icon: <ArrowRight size={14} />, hint: kb?.label('split-right'), disabled: full, onSelect: splitTo('row', false) },
    { label: 'Split down', icon: <ArrowDown size={14} />, hint: kb?.label('split-down'), disabled: full, onSelect: splitTo('col', false) },
    { label: 'Split left', icon: <ArrowLeft size={14} />, disabled: full, onSelect: splitTo('row', true) },
    { label: 'Split up', icon: <ArrowUp size={14} />, disabled: full, onSelect: splitTo('col', true) },
  ]

  const over = (e) => {
    if (!onDropInPane) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
    const box = e.currentTarget.getBoundingClientRect()
    const next = dropZone(box, e.clientX, e.clientY)
    place.current = next
    setZone(next.zone)
  }

  const leave = (e) => {
    if (e.currentTarget.contains(e.relatedTarget)) return
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
            className="split-label"
            title={primary ? label : `${label} - drag onto another pane's edge to move it`}
            draggable={!primary && node.view !== 'new'}
            onDragStart={(e) => {
              e.dataTransfer.setData('text/plain', chatDragPayload(node.view))
              e.dataTransfer.effectAllowed = 'move'
            }}
          >
            {label}
          </span>
          <div className="split-actions">
            <button
              type="button"
              className="split-btn"
              title={hintRight('Split right')}
              aria-label="Split right"
              disabled={full}
              onClick={splitTo('row', false)}
            >
              <SplitGlyph size={14} />
            </button>
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
    </section>
  )
}

// Renders a split layout: nested rows and columns of panes with draggable
// dividers. What a pane shows is the caller's (`renderPane`), so Local and
// Cloud chats, new-chat composers and the primary view all share one frame.
// One pane is the app's whole main area, headerless; two or more get the
// headers, because that is where the split and close actions live.
export default function SplitArea({ layout, setLayout, renderPane, labelFor, onDropInPane }) {
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
        />
      )
    }
    return <SplitNode key={node.id} node={node} setLayout={setLayout} renderNode={renderNode} />
  }

  return <div className={`split-area${count > 1 ? ' is-split' : ''}`}>{renderNode(layout.root)}</div>
}
