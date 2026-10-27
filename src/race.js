// Race: one prompt into two to four harnesses at once, each chat in its own
// pane, so the answers sit side by side and the comparison is a look rather
// than six manual chats. The rules live here - which harnesses can be offered,
// what is refused and why, and the layout plan - so the modal only renders them
// and they can be tested without a browser or a daemon.
//
// The layout is built from split.js's own splitLeaf and balanceSplit: this is a
// plan about what to call, not a second split implementation.

import { MAX_PANES, balanceSplit, leaves, paneCount, splitLeaf } from './split.js'
import { pickable } from './harness-manager.js'
import { harnessName } from './harness-names.js'

/// A race compares at least two answers; one chat is just a chat.
export const RACE_MIN = 2

/// The window's pane cap is the race's own ceiling: a fifth pane cannot be
/// shown, so a fifth harness cannot race.
export const RACE_MAX = MAX_PANES

/// The harnesses a race can offer: installed on this machine and not turned
/// off, which is the same rule every picker in the console uses (`pickable`),
/// so "installed" cannot mean two things in two places.
export function offerableHarnesses(harnesses) {
  return (harnesses ?? [])
    .filter(pickable)
    .map((harness) => ({ id: harness.id, name: harnessName(harness.id) }))
}

/// How many panes this window could still open for a race.
///
/// An empty pane (the primary before anything is open in it) is a pane the race
/// can fill rather than one that is in the way, so it counts as a free slot:
/// a two-chat race on a fresh window is one pane filled and one opened, not two
/// panes opened beside a blank.
export function freePanes(layout) {
  const focused = leaves(layout.root).find((leaf) => leaf.id === layout.focus)
  const reusable = focused && focused.view === null ? 1 : 0
  return Math.max(0, MAX_PANES - paneCount(layout) + reusable)
}

/// Whether the modal may start, and the sentence that says why not.
///
/// `chosen` is the harness ids the person switched on, in the order they did
/// it. A refusal never half-starts: the modal asks for exactly what is wrong
/// before any chat is created, and `missing` names the harnesses that would not
/// fit so the sentence can be specific rather than a count.
export function racePlan({ offerable, chosen, free, prompt }) {
  const offered = offerableHarnesses(offerable)
  const picked = (chosen ?? []).filter((id) => offered.some((h) => h.id === id))
  const base = { offerable: offered, chosen: picked, count: picked.length }
  if (offered.length < RACE_MIN) {
    return { ...base, canStart: false, refusal: { code: 'no-harnesses' } }
  }
  if (picked.length < RACE_MIN) {
    return { ...base, canStart: false, refusal: { code: 'too-few' } }
  }
  if (picked.length > RACE_MAX) {
    return { ...base, canStart: false, refusal: { code: 'too-many' } }
  }
  if (free < RACE_MIN) {
    return { ...base, canStart: false, refusal: { code: 'no-panes' } }
  }
  if (picked.length > free) {
    const nameOf = (id) => offered.find((h) => h.id === id)?.name ?? id
    return {
      ...base,
      canStart: false,
      refusal: {
        code: 'not-enough-panes',
        free,
        missing: picked.slice(free).map(nameOf),
      },
    }
  }
  if (String(prompt ?? '').trim() === '') {
    return { ...base, canStart: false, refusal: { code: 'no-prompt' } }
  }
  return { ...base, canStart: true, refusal: null }
}

/// The create calls, one per harness, each with the same trimmed prompt. The
/// prompt is not repeated per harness by accident: it is the whole point.
export function racePrompts(harnesses, prompt) {
  const text = String(prompt ?? '').trim()
  return (harnesses ?? []).map((harness) => ({ harness, text }))
}

/// What is left to race after a start that failed part of the way.
///
/// A harness whose chat was created has a pane on screen already: racing it
/// again would make a second chat for the same question and leave two panes
/// saying the same thing. So the retry keeps only the harnesses that produced
/// nothing - the one that failed and the ones never reached - in the order they
/// were picked. With nothing created the whole selection comes back unchanged,
/// so a failure before the first chat retries everything. A selection that
/// falls below two is refused by racePlan itself: a race of one is a chat.
export function raceRetry(chosen, started) {
  const done = new Set(started ?? [])
  return (chosen ?? []).filter((harness) => !done.has(harness))
}

/// The deepest split that holds every race pane, so the plan can even out the
/// race's own row without touching the sizes of panes that were already there.
function deepestSplitHolding(node, views) {
  if (!node || node.type !== 'split') return null
  const seen = new Set(leaves(node).map((leaf) => leaf.view))
  if (!views.every((view) => seen.has(view))) return null
  for (const child of node.children) {
    const deeper = deepestSplitHolding(child, views)
    if (deeper) return deeper
  }
  return node
}

/// The window after the race.
///
/// Returns the layout to set and `primary`: the chat the caller must navigate
/// the primary pane to, or null. An empty focused pane *is* the primary pane,
/// and its view is the console's navigation rather than a leaf field
/// (`setLeafView` refuses to write into an empty leaf for exactly that reason),
/// so the race hands that chat back instead of trying to fill the pane itself.
///
/// Every other chat opens as a new pane to the right of the last one, in the
/// order they were chosen, and the race's own row is evened out so the answers
/// are the same size on screen. At the pane cap the layout comes back untouched:
/// the caller refused before it got here, and half a race is worse than none.
export function raceLayout(layout, views) {
  const ids = (views ?? []).filter(Boolean)
  if (ids.length === 0) return { primary: null, layout }
  const focused = leaves(layout.root).find((leaf) => leaf.id === layout.focus)
  const primary = focused && focused.view === null ? ids[0] : null
  const seats = primary ? ids.slice(1) : ids
  let next = layout
  for (const id of seats) {
    const after = splitLeaf(next, next.focus, 'row', id)
    if (after === next) return { primary: null, layout }
    next = after
  }
  const row = seats.length > 0 ? deepestSplitHolding(next.root, seats) : null
  return { primary, layout: row ? balanceSplit(next, row.id) : next }
}
