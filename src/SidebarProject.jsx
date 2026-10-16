import { CaretDown, DotsThree, Plus } from '@phosphor-icons/react'
import { DOT_WORDS } from './sidebar-groups.js'

/**
 * One project in the sidebar: its head row, and under it whatever the
 * sidebar puts there (its chats, "Show more", a quiet line when it has
 * none). The row folds and unfolds the project - it never starts a chat;
 * the + does that, and the ... opens the project's menu (so does a right
 * click or a long press). Both buttons show on hover and on keyboard focus,
 * and always on a touch screen, which has no hover.
 *
 * - `top`: the most urgent state among the chats of a folded project, or
 *   null (see rollup in sidebar-groups.js).
 * - `device`: the machine a project of another computer lives on, shown
 *   beside its name; null for this computer's own.
 * - `dropKey`: the id a dragged chat is dropped on; absent where nothing
 *   can be dropped (a project of another machine).
 */
export default function SidebarProject({
  name,
  device,
  count,
  top,
  folded,
  dropKey,
  dropping,
  privacy,
  onToggle,
  onNewChat,
  onMenu,
  children,
}) {
  // A native tooltip would print the name over its blurred row.
  const title = privacy ? 'this project' : name
  return (
    <section className={`project${dropping ? ' sb-drop-target' : ''}`} data-drop={dropKey}>
      <button
        className="project-head"
        onClick={onToggle}
        onContextMenu={(e) => {
          e.preventDefault()
          onMenu({ x: e.clientX, y: e.clientY })
        }}
        aria-expanded={!folded}
      >
        <span className={`project-caret${folded ? ' closed' : ''}`}>
          <CaretDown size={12} />
        </span>
        <span className="project-name pv">{name}</span>
        {device && <span className="project-device pv">{device}</span>}
        {/* Folded, the project still tells the truth: the most urgent state
            among its chats, in the chats' own dot language. */}
        {top && (
          <span className={`dot dot--${top}`} role="img" aria-label={DOT_WORDS[top]} title={DOT_WORDS[top]} />
        )}
        {count > 0 && <span className="project-count">{count}</span>}
      </button>
      {/* A new chat already in this project, straight from its row: no trip
          through the home screen's project picker. */}
      <button
        type="button"
        className="sb-project-new"
        title={`New chat in ${title}`}
        aria-label={`New chat in ${name}`}
        onClick={onNewChat}
      >
        <Plus size={12} weight="bold" />
      </button>
      <button
        type="button"
        className="sb-project-more"
        title="Project menu"
        aria-label={`Menu for ${name}`}
        aria-haspopup="menu"
        onClick={(e) => {
          const box = e.currentTarget.getBoundingClientRect()
          onMenu({ x: box.left, y: box.bottom + 4 })
        }}
      >
        <DotsThree size={14} weight="bold" />
      </button>
      {children}
    </section>
  )
}
