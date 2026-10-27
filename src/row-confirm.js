// One destructive row per pane, armed by the first press and acted on by
// the second. The plugins, MCP servers and endpoint panes all hold their
// removal behind this, so the shared rules cannot drift apart between
// them: only one row is ever armed (a second press elsewhere replaces the
// first), a row without an id cannot arm at all, and the arm ends as soon as
// the row stops being the thing the user is looking at - see armAfter.

/** The armed id after a press on `id`, replacing whatever was armed. */
export function armRow(armed, id) {
  if (id == null) return armed
  return armed === id ? armed : id
}

/** No row armed: after the action, and on any other row's action. */
export function clearRow() {
  return null
}

/** Whether `id` is the armed row. */
export function rowIsArmed(armed, id) {
  return armed != null && armed === id
}

/**
 * The arm after the row loses the user's attention: scrolled out of the
 * viewport, or no longer the focused control. An armed button nobody is
 * looking at is a first press the user has forgotten making, and the next
 * press wherever they have scrolled to must not delete something. Any other
 * id is untouched, so this never disarms a row on a stale event from another.
 */
export function armAfter(armed, id, { visible = true, focused = true } = {}) {
  if (armed == null || armed !== id) return armed
  return visible && focused ? armed : null
}

