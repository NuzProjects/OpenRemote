// One destructive row per pane, armed by the first press and acted on by
// the second. The plugins, MCP servers and endpoint panes all hold their
// removal behind this, so the shared rules cannot drift apart between
// them: only one row is ever armed (a second press elsewhere replaces the
// first, so an armed row can never sit off screen waiting for a press the
// user no longer means), and a row without an id cannot arm at all.

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
