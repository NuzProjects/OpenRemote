// What the console shows when a view cannot be drawn: the short line that
// says what kind of failure it was, the error's own words and first frame
// for the mono block, and whether trying the same view again is worth
// offering. Pure, so the rules are tested without a DOM and the boundary
// component stays thin enough to read in one sitting.

/// One retry, then stop offering it. A retry re-renders the same view from
/// the same state, so it can rescue a failure that came from something
/// outside that state (a race, a clock, a value read once) and it cannot
/// rescue anything else. A second identical failure is the loop this limit
/// exists to refuse.
///
/// The count is per boundary instance, and the boundary is keyed by the view
/// it holds (App.jsx, renderPane), so navigating away and back starts it from
/// zero: one view gets one retry, and a fresh view is a fresh question.
export const RETRY_LIMIT = 1

/// Errors React raises for a tree it cannot render at all. Re-rendering
/// lands in exactly the same place, so the panel does not offer it.
const DETERMINISTIC = [
  /Objects are not valid as a React child/,
  /Element type is invalid/,
  /Rendered more hooks than during the previous render/,
  /Rendered fewer hooks than expected/,
  /Too many re-renders/,
  /Maximum update depth exceeded/,
  // The property-access family, the commonest crash there is: a render that
  // reads a field of undefined or null fails the same way on every try. Both
  // spellings are here (the field may sit inside the sentence in older
  // engines), and the message is all a thrown TypeError carries.
  /Cannot read propert(?:y|ies) (?:'[^']*' )?of (?:undefined|null)/,
]

/// What was thrown, as one line for the mono block: the error's name and
/// message, a thrown string as itself, and a thrown object honestly rather
/// than as `[object Object]`.
export function errorLine(error) {
  if (error == null) return ''
  if (typeof error === 'string') return error
  if (typeof error !== 'object') return String(error)
  const name = typeof error.name === 'string' && error.name ? error.name : ''
  const message = typeof error.message === 'string' ? error.message : ''
  if (name && message) return `${name}: ${message}`
  if (message) return message
  if (name) return name
  return 'The view threw something that is not an error.'
}

/// Where it happened, as the first frame of a stack: React's component
/// stack names the component, which is the line worth keeping; the error's
/// own stack is the fallback for an error thrown outside a component's
/// render. Empty when neither has a frame to show.
export function firstFrame(error, componentStack = '') {
  for (const line of String(componentStack || '').split('\n')) {
    const at = line.trim()
    if (at.startsWith('at ')) return at
  }
  const own = typeof error?.stack === 'string' ? error.stack : ''
  for (const line of own.split('\n')) {
    const at = line.trim()
    if (at.startsWith('at ')) return at
  }
  return ''
}

/// The one plain sentence under the title. It says what kind of failure it
/// was, never that the app is broken: the rest of the window is still
/// there, and this line is read by someone deciding what to do next. The
/// wording stays in the app's own voice ("this view"), not React's: the
/// person reading it wants to know what the pane hit, not which error class
/// a developer would have named.
export function causeLine(error) {
  const name = typeof error?.name === 'string' ? error.name : ''
  if (name === 'TypeError') return 'This view expected something that was not there.'
  if (name === 'ReferenceError') return 'This view asked for something that does not exist.'
  if (name === 'RangeError') return 'This view asked for a size it cannot draw.'
  if (name === 'SyntaxError') return 'This view could not read what it was given.'
  return 'This view stopped while it was drawing itself.'
}

/// The rows the panel shows, or null when there is nothing to show. The
/// boundary passes what React gave it plus how many times this view has
/// already been tried; everything the panel decides comes from here.
export function failureNotice({ error, componentStack = '', attempts = 0 } = {}) {
  if (error == null) return null
  const message = errorLine(error)
  return {
    cause: causeLine(error),
    detail: { message, frame: firstFrame(error, componentStack) },
    retry: attempts < RETRY_LIMIT && !DETERMINISTIC.some((shape) => shape.test(message)),
  }
}
