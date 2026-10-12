import { useRef } from 'react'
import { SplitHorizontal, SplitVertical, X } from '@phosphor-icons/react'
import { MAX_PANES, closeLeaf, focusLeaf, paneCount, resizeSplit, splitLeaf } from './split.js'
import './split.css'

function SplitNode({ node, setLayout, renderNode }) {
  const ref = useRef(null)
  const row = node.dir === 'row'
  const startDrag = (index) => (e) => {
    e.preventDefault()
    const box = ref.current?.getBoundingClientRect()
    if (!box) return
    const total = row ? box.width : box.height
    let last = row ? e.clientX : e.clientY
    const target = e.currentTarget
    target.setPointerCapture(e.pointerId)
    const move = (ev) => {
      const at = row ? ev.clientX : ev.clientY
      const delta = (at - last) / total
      last = at
      setLayout((l) => resizeSplit(l, node.id, index, delta))
    }
    const done = () => {
      target.removeEventListener('pointermove', move)
      target.removeEventListener('pointerup', done)
      target.removeEventListener('pointercancel', done)
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
              aria-orientation={row ? 'vertical' : 'horizontal'}
              onPointerDown={startDrag(i)}
            />
          )}
        </div>
      ))}
    </div>
  )
}

// Renders a split layout: nested rows and columns of panes with draggable
// dividers. What a pane shows is the caller's (`renderPane`), so Local and
// Cloud chats, new-chat composers and the primary view all share one frame.
export default function SplitArea({ layout, setLayout, renderPane, labelFor }) {
  const count = paneCount(layout)

  const renderNode = (node) => {
    if (node.type === 'leaf') {
      const focused = layout.focus === node.id
      const primary = node.view === null
      return (
        <section
          className={`split-pane${focused ? ' focused' : ''}`}
          onPointerDownCapture={() => setLayout((l) => focusLeaf(l, node.id))}
          aria-label={labelFor(node)}
        >
          <header className="split-bar">
            <span className="split-label">{labelFor(node)}</span>
            <button
              type="button"
              className="split-btn"
              title="Split right"
              aria-label="Split right"
              disabled={count >= MAX_PANES}
              onClick={() => setLayout((l) => splitLeaf(l, node.id, 'row'))}
            >
              <SplitHorizontal size={13} />
            </button>
            <button
              type="button"
              className="split-btn"
              title="Split down"
              aria-label="Split down"
              disabled={count >= MAX_PANES}
              onClick={() => setLayout((l) => splitLeaf(l, node.id, 'col'))}
            >
              <SplitVertical size={13} />
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
          </header>
          <div className="split-body">{renderPane(node)}</div>
        </section>
      )
    }
    return <SplitNode key={node.id} node={node} setLayout={setLayout} renderNode={renderNode} />
  }

  return (
    <div className="split-area">
      {renderNode(layout.root)}
    </div>
  )
}
