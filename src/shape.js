// The console's boundary for daemon data.
//
// Every row the console shows came from somewhere that can be wrong: a
// mixed-version daemon, a hand-edited state.json, a record synced from
// another device. The console used to trust the shape of what it was given -
// a list is an array, a name is a string, an id is one path segment - and a
// single malformed row was enough to throw a whole view or aim a request at
// a route nobody pointed at. These three are the only coercions the client
// applies, so every site that needs one reads the same rule as its
// neighbours instead of inventing a second convention.

/// One path segment: an id that is about to be pasted into a route.
///
/// A raw id in a path is not merely a wrong request. `fetch` parses the
/// string as a URL and normalises `..` segments, so an id of
/// `../automations/<id>` turns a chat's delete into a rule's delete, with the
/// same token. Encoding keeps the id inside the segment it was meant for, and
/// the daemon decodes it back before it looks at it.
///
/// An empty or missing id throws rather than becoming an empty segment. An
/// emptied route can still reach a handler (`DELETE /sessions/` answers 404,
/// which this client reads as "the chat is gone"), so a wiring bug would look
/// like a successful delete; loud here, at the boundary.
export function seg(value) {
  const id = value == null ? '' : String(value)
  if (!id) throw new Error('a request path needs an id, and this one is empty')
  return encodeURIComponent(id)
}

/// A string from a field that should have been one. A number or a boolean
/// keeps its text (a numeric title still reads), and anything else is empty
/// rather than "[object Object]", so callers can compare and search on it
/// without a type check of their own.
export function text(value) {
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return ''
}

/// A list from a field that should have been one. `?? []` at the intake
/// already covers null and undefined; this also survives an object or a
/// string where the daemon sent the wrong shape, which used to reach
/// `.filter` and throw.
///
/// The empty list is the safe answer, but on its own it reads as "there are
/// none" rather than "the daemon sent nonsense". A development build says so
/// once; a release build stays quiet, because a warning nobody can act on is
/// noise and the view already renders the same empty state either way.
export function list(value) {
  if (Array.isArray(value)) return value
  if (value != null && import.meta.env?.DEV) {
    console.warn('openremote: expected a list from the daemon, got', typeof value)
  }
  return []
}

/// What a chat with no title is called. Exported because a test and a future
/// surface both need the words, and two copies of them is the problem this
/// reader exists to end.
export const CHAT_TITLE_FALLBACK = 'A new task'

/// A chat's name as every surface prints it: its title, edges trimmed, and the
/// fallback when there is nothing to print.
///
/// The title is the one string the console shows in more places than any other
/// (the sidebar row, the palette, the chat's own header, the copy as Markdown),
/// and each of those used to write the fallback by hand, so changing the words
/// would have reached one surface and missed seven. The trim is part of the
/// same rule: the daemon can send the whitespace a person typed around a title,
/// and a title that is only whitespace is no title at all. A field that is not
/// text (an object where the daemon meant a string) reads as no title too,
/// rather than reaching a renderer that throws on it.
export function chatTitle(chat) {
  const title = text(chat?.title).trim()
  return title || CHAT_TITLE_FALLBACK
}
