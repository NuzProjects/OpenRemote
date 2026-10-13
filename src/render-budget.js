// Render-cost caps for the transcript rail: the fixed bounds that keep a
// big turn displayable. Pure; the view only reads them, tests pin them.
//
// The daemon caps what it lists the same way - a folder listing stops at
// 2000 entries with a truncated flag, and the console answers with a
// "showing the first" note (FolderPickerModal). These notes mirror that
// wording so every truncation in the app reads the same.

/// How often a live body (a token stream) may re-parse its growing text.
/// The token beat is far faster than the eye can read, so 100ms is live
/// enough - and it caps both the parse and the innerHTML rewrite of the
/// growing reply at ~10 a second, where before each token paid both.
export const LIVE_RENDER_MS = 100

/// The most diff rows one tool card renders. A row is a DOM pair (old
/// left, new right), so an uncapped 3000-line write was ~6000 nodes on
/// its own; 500 rows keeps every card bounded and still readable.
export const MAX_RENDER_ROWS = 500

/// The most lines one tool output shows. The full text stays in the
/// transcript (the daemon's own record); the card shows the head.
export const MAX_RENDER_LINES = 500

/// Whether a live body may render now: at least LIVE_RENDER_MS since the
/// last accepted render. 0 means "never rendered" - the first beat always
/// passes.
export function shouldRenderLive(lastRenderedAt, now = Date.now()) {
  return now - lastRenderedAt >= LIVE_RENDER_MS
}

/// The rows a diff card shows and how many were held back - the first
/// slice, never the whole walk.
export function capRows(rows) {
  if (rows.length <= MAX_RENDER_ROWS) return { rows, hidden: 0 }
  return { rows: rows.slice(0, MAX_RENDER_ROWS), hidden: rows.length - MAX_RENDER_ROWS }
}

/// The lines a tool output shows and how many were held back.
export function capLines(text) {
  const src = String(text ?? '')
  const lines = src.split('\n')
  if (lines.length <= MAX_RENDER_LINES) return { text: src, hidden: 0 }
  return { text: lines.slice(0, MAX_RENDER_LINES).join('\n'), hidden: lines.length - MAX_RENDER_LINES }
}
