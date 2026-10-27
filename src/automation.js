// Automation vocabulary: the trigger kinds with real event sources, and
// their plain sentences. The connector-backed kinds (pipeline, errors,
// review, release) appear when their connectors do - until then the form
// offers only what can really fire.

import { harnessName } from './harness-names.js'

export const KINDS = ['schedule', 'webhook']

// The kinds whose event sources still need connectors.
export const CONNECTOR_KINDS = ['pipeline', 'errors', 'review', 'release']

export function whenSentence(trigger) {
  if (trigger?.kind === 'webhook') return 'A webhook arrives'
  return `Every day at ${trigger?.time ?? '09:00'}`
}

// The dirty test lives in form-dirty.js now, because the endpoint editor asks
// the same question and a second copy would drift. Re-exported here so the
// rule editor's import keeps reading as automation's own.
export { formDiffers } from './form-dirty.js'

// ---- the list's search ----
//
// The rules list draws every rule it has, and there is no second place to look
// one up, so search is the list's only way in. It matches what a row prints:
// the rule's name, the sentence its trigger shows (which carries the trigger's
// own kind words and its time) and the harness's display name. It does not
// match what a row does not show - the task text, the project, the machine -
// because a result you cannot see is worse than no result, and it follows the
// same rule the plugins Discover search follows: every whitespace-separated
// word must appear somewhere in what the row shows.
//
// A rule's switch is not a word: a disabled rule is still a rule in the list,
// and searching for its name finds it whatever its state.

/** The only line the list shows when there is nothing to filter yet. */
export const RULE_EMPTY_NONE = 'No rules yet. Write one.'

// The count at which the field carries its hint. Rules are short rows and the
// panel shows about six of them above the pill; below that the list fits in a
// glance and a placeholder would be noise, at that many it starts to help.
export const RULE_SEARCH_HINT_FROM = 6

/** The words the row puts on screen for this rule, lowercased. */
export function ruleHaystack(rule) {
  return [rule?.name, whenSentence(rule?.trigger), harnessName(rule?.harness)]
    .filter((part) => typeof part === 'string' && part.length > 0)
    .join(' ')
    .toLowerCase()
}

/** The query's words, trimmed and lowercased; [] means no filter. */
export function queryWords(query) {
  return String(query ?? '')
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
}

/** Whether one rule shows what the query asks for. */
export function matchesRule(rule, query) {
  const words = queryWords(query)
  if (!words.length) return true
  const hay = ruleHaystack(rule)
  return words.every((word) => hay.includes(word))
}

/** The rules to draw, in the order the list already had them. */
export function searchRules(rules, query) {
  return (Array.isArray(rules) ? rules : []).filter((rule) => matchesRule(rule, query))
}

/** The quiet line under the field while a query is on: "3 of 12 rules". */
export function ruleCountLine(shown, total) {
  return `${shown} of ${total} ${total === 1 ? 'rule' : 'rules'}`
}

/** The answer when a query matches nothing: it names the query. */
export function ruleEmptyLine(query) {
  const words = String(query ?? '').trim()
  return words ? `No rules match “${words}”.` : RULE_EMPTY_NONE
}

/**
 * The field's hint, or '' when the list is short enough that it needs none.
 * `total` is how many rules the list holds, not how many a search shows.
 */
export function ruleSearchHint(total) {
  return (total ?? 0) >= RULE_SEARCH_HINT_FROM ? 'Search rules' : ''
}

