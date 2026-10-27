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
export function seg(value) {
  return encodeURIComponent(String(value ?? ''))
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
export function list(value) {
  return Array.isArray(value) ? value : []
}
