// Running a rule from the command palette.
//
// A rule can already be run by hand: the Automations view's Run now calls the
// daemon's run route and opens the chat it starts. That action needs the
// view's own state (its busy flag, its error line, its navigation), so the
// view lends it to the palette for as long as it is mounted, and the palette
// asks for it by id - the same shape as the browser store's reopen: a small
// register/request pair, with no second copy of the run path and no new route.
//
// Everything here that can be decided without a daemon is a pure rule with a
// test: which rules the palette may offer, in what order, the two lines it
// answers with, and the cases where a rule cannot run at all.

import { whenSentence } from './automation.js'

// A field that must be a real word to be used: shape.js's `text` keeps a
// whitespace-only string, which is a name nobody can read in a row.
function sentence(value) {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed ? trimmed : null
}

/** The palette's group label. Its own name, so the view and the palette agree. */
export const RULES_SECTION = 'Rules'

/** The line while the daemon is being asked, naming the rule. */
export function runningLine(name) {
  return `Running “${sentence(name) ?? 'that rule'}”.`
}

/** The line when it did start: the chat it opened is behind the palette. */
export const RULE_STARTED = 'Started.'

/** The line when the seam has no view behind it: the rule cannot be reached. */
export const RULE_GONE = 'That rule is not available any more.'

/** The line when the run failed without a sentence of its own. */
export const RULE_FALLBACK = 'The rule did not start.'

/**
 * Why a rule cannot run, or null when it can.
 *
 * - 'paused': the rule is switched off, so the daemon would refuse it and the
 *   view's own Run now is disabled for it too;
 * - 'nameless': a rule with no name has no row to offer;
 * - 'no-machine': the rule names a machine that is not in the account any
 *   more, so nothing can run it;
 * - 'machine-offline': the machine has not come online (or has gone away), so
 *   the run would be refused when it reached it;
 * - 'not-answered': the machine list has not answered, and this rule names a
 *   machine, so whether it can run is unknown. Unknown is not a yes.
 *
 * A rule that names no machine runs on this computer, which is the daemon the
 * palette is talking to: that one is always runnable.
 */
export function ruleCannotRun(rule, machines, { answered = true } = {}) {
  if (!rule || typeof rule !== 'object') return 'missing'
  if (!sentence(rule.name)) return 'nameless'
  if (rule.enabled !== true) return 'paused'
  if (!sentence(rule.machine)) return null
  if (!answered) return 'not-answered'
  const rows = Array.isArray(machines) ? machines : []
  const row = rows.find((m) => m?.machine?.id === rule.machine)
  if (!row) return 'no-machine'
  if (row.machine.status !== 'online') return 'machine-offline'
  return null
}

/** The machine a runnable rule runs on, in its owner's words. */
export function ruleMachineLabel(rule, machines) {
  if (!sentence(rule?.machine)) return 'this computer'
  const row = (Array.isArray(machines) ? machines : []).find((m) => m?.machine?.id === rule.machine)
  return sentence(row?.machine?.name) ?? 'a machine'
}

/**
 * The rows the palette's Rules group offers, in the order the Automations list
 * shows them (the order a person recognises from that view), with the two
 * facts that help pick one of ten: when it fires, and where it runs.
 */
export function ruleRunRows(rules, machines, { answered = true } = {}) {
  const list = Array.isArray(rules) ? rules : []
  const out = []
  for (const rule of list) {
    if (ruleCannotRun(rule, machines, { answered })) continue
    out.push({
      id: rule.id,
      name: sentence(rule.name),
      sub: `${whenSentence(rule.trigger)} · ${ruleMachineLabel(rule, machines)}`,
    })
  }
  return out
}

/**
 * The one line under the palette's search field: what is happening, or what
 * happened. `phase` is 'running', 'started' or 'refused'.
 */
export function ruleAnswer({ phase = 'running', name = '', error = null } = {}) {
  if (phase === 'running') return runningLine(name)
  if (phase === 'started') return RULE_STARTED
  return sentence(error) ?? RULE_FALLBACK
}

// ---- the seam: the Automations view lends the palette its Run now ----

let handler = null
const listeners = new Set()

function announce() {
  for (const listener of listeners) listener()
}

/**
 * Register the view's run action for as long as it is mounted. Returns the
 * unregister function, which only clears the handler it installed (a second
 * view mounting over the first must not take its seam away).
 */
export function registerRuleRun(fn) {
  handler = typeof fn === 'function' ? fn : null
  announce()
  return () => {
    if (handler === fn) {
      handler = null
      announce()
    }
  }
}

/** Whether the palette may offer rules at all: a view is behind the action. */
export function ruleRunAvailable() {
  return Boolean(handler)
}

/** Hear about the seam coming and going (the palette's group follows it). */
export function subscribeRuleRun(fn) {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

/**
 * Ask the view to run a rule and answer in the shape the palette renders:
 * `{ ok: true }`, or `{ ok: false, error }` with the daemon's own sentence.
 * A throw from the handler becomes a refusal here, so the palette never has
 * to carry a second error path.
 */
export async function runRule(id) {
  if (!handler) return { ok: false, error: RULE_GONE }
  try {
    const result = await handler(id)
    if (result?.ok === true) return { ok: true }
    return { ok: false, error: sentence(result?.error) ?? RULE_FALLBACK }
  } catch (err) {
    return { ok: false, error: sentence(err?.message) ?? RULE_FALLBACK }
  }
}
