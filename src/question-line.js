// The question under a waiting chat's title: one line saying what the
// harness is actually holding, so "two chats are waiting" does not mean
// opening both to find out what they want.
//
// The line is read only. Nothing here answers, approves or dismisses: a
// decision is answered in the chat, where the harness's own words, its
// options and (for an approval) what it wants to run are on screen together.
// A summary that could act would be an approvals panel built from a sidebar
// row, and it would be missing everything that makes answering safe.
//
// The daemon's list is a bare array of decisions (a `pending` one is the
// question), and every harness puts its own words in its own shape, so the
// rules here are mostly about fallbacks. Pure, so the shapes and the cuts
// are tested without a DOM.

// How much of a question one sidebar line holds. The row is eleven pixels
// under a thirteen-pixel title; past this the honest thing is to show the
// beginning and say so, which is what the marker is for. A narrower pane
// ellipsizes the rest, but that is the fallback, not the rule.
export const LINE_LIMIT = 56
// The character that says "there was more". Not an em dash, and it is
// always attached to a cut, never to a whole question.
export const CUT_MARK = '…'

/** A string field of an object, when it is a usable string. */
function str(object, key) {
  const value = object?.[key]
  return typeof value === 'string' && value.trim() ? value : null
}

/**
 * The words one pending decision carries, from whichever shape the harness
 * used, with the fallbacks that keep a row honest when a harness gives none.
 *
 * Priority: a question's own text, then a title, then the command or action
 * the approval is about, prefixed by the tool's name so a bare command line
 * reads as something a harness wants to run, then a description, then a
 * sentence built from the kind. `via` says which one answered, so the tests
 * pin the order rather than only the output.
 */
export function decisionText(decision) {
  const request = decision?.harness_request ?? {}
  const tool = str(decision, 'tool_name') ?? str(request, 'tool_name')
  const question = str(request, 'question') ?? str(request.questions?.[0] ?? {}, 'question')
  if (question) return { text: question, via: 'question' }
  const title = str(request, 'title')
  if (title) return { text: title, via: 'title' }
  const command = str(request, 'command')
  if (command) return { text: tool ? `${tool}: ${command}` : command, via: 'command' }
  const action = str(request, 'action')
  if (action) return { text: tool ? `${tool}: ${action}` : action, via: 'action' }
  const description = str(request, 'description')
  if (description) return { text: description, via: 'description' }
  if (decision?.kind === 'approval') {
    return { text: tool ? `It wants to use ${tool}.` : 'It is waiting on an approval.', via: 'kind' }
  }
  if (decision?.kind === 'question') return { text: 'It is waiting for your answer.', via: 'kind' }
  return { text: 'It is waiting.', via: 'kind' }
}

/**
 * The first line of some words, with the whitespace a harness may have kept
 * folded to single spaces: a question written in three lines is one line in
 * a row, and the line ends where the question's own line breaks say it does.
 */
export function firstLine(text) {
  if (typeof text !== 'string') return null
  const line = text
    .split(/\r?\n/)
    .map((part) => part.replace(/\s+/g, ' ').trim())
    .find((part) => part.length > 0)
  return line || null
}

/**
 * A cut that says it is one. Past the limit, the line is cut at the last
 * word boundary that still leaves most of it (so a normal sentence does not
 * end mid-word), or hard at the limit when there is no such boundary (a
 * path, a URL), and the marker says there was more either way.
 */
export function cutLine(text, limit = LINE_LIMIT) {
  const line = firstLine(text)
  if (!line) return null
  if (line.length <= limit) return { text: line, cut: false }
  const head = line.slice(0, limit)
  const space = head.lastIndexOf(' ')
  const body = space > limit / 2 ? head.slice(0, space) : head
  return { text: `${body.trimEnd()}${CUT_MARK}`, cut: true }
}

/**
 * The line for a chat, from the daemon's answer: the first decision still
 * pending, its words, its first line, the cut. `null` when there is nothing
 * to say - an unreadable answer, no list at all, or a waiting status whose
 * question is no longer pending (answered in the chat or on its way). The
 * row then shows only its title: the status group already says the rest.
 */
export function questionLine(decisions) {
  if (!Array.isArray(decisions)) return null
  const pending = decisions.find((decision) => decision?.state === 'pending')
  if (!pending) return null
  return cutLine(decisionText(pending).text)
}

/** The line's text, or null: what a row would render. */
export function questionText(decisions) {
  return questionLine(decisions)?.text ?? null
}

/**
 * The cache key: a chat and the activity stamp that told us it is waiting.
 * A new question bumps that stamp, so the key changes and the console reads
 * once more; the same question on later beats keeps the key, so no read.
 */
export function questionKey(chatId, stamp) {
  return `${chatId}@${stamp ?? 0}`
}

/** Whether a chat's line has been read for this stamp already. */
export function hasLine(cache, chatId, stamp) {
  return Object.prototype.hasOwnProperty.call(cache ?? {}, questionKey(chatId, stamp))
}

/** The line to render for a chat, or null when there is nothing to show. */
export function lineFor(cache, chatId, stamp) {
  return (cache ?? {})[questionKey(chatId, stamp)] ?? null
}

/** Remember one answer - the line, or null for "read, and there is none". */
export function rememberLine(cache, key, line) {
  return { ...(cache ?? {}), [key]: line ?? null }
}

/**
 * Keep only the lines still worth holding: the chats that are waiting now,
 * with the stamp they are waiting under. Everything else is dropped, so a
 * chat that stopped waiting costs nothing and a stale answer cannot show
 * under a new question.
 */
export function pruneLines(cache, wanted) {
  const keep = new Set(wanted ?? [])
  const next = {}
  for (const [key, line] of Object.entries(cache ?? {})) {
    if (keep.has(key)) next[key] = line
  }
  return next
}

/** The cache keys a waiting list is worth holding: one per chat and stamp. */
export function wantedKeys(rows) {
  return (rows ?? []).filter((row) => row?.id).map((row) => questionKey(row.id, row.updatedAt))
}

/**
 * The chats whose line still has to be read: no answer held for the stamp
 * they are waiting under. A steady state is an empty list here, which is
 * what makes "no polling loop of its own" a fact rather than a promise.
 */
export function missingLines(cache, rows) {
  return (rows ?? []).filter((row) => row?.id && !hasLine(cache, row.id, row.updatedAt))
}