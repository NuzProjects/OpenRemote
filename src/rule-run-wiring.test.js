// Running a rule from the command palette. The palette cannot run a rule
// itself - the action lives in the Automations view, which also opens the chat
// that starts - so this file pins the two halves of the seam and the two lines
// the palette answers with. The rules it offers, their order and the copies
// are unit tested in rule-run.test.js; what is pinned here is that the palette
// reads them and the view lends the action.

import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'

const source = (file) => readFileSync(new URL(`./${file}`, import.meta.url), 'utf8')
const palette = source('CommandPalette.jsx')
const view = source('AutomationsView.jsx')
const rules = source('rule-run.js')

test('the palette has a Rules group, under Actions, only while a view can run one', () => {
  assert.match(palette, /import \{[\s\S]*?RULES_SECTION,[\s\S]*?\} from '\.\/rule-run\.js'/)
  assert.match(
    palette,
    /const SECTION_ORDER = \['Actions', 'Rules', 'Chats', 'Views', 'Projects', 'Machines'\]/,
    'a person looking for a rule does not scroll past every chat first',
  )
  // The group exists only with the seam registered, and follows it coming and
  // going: a row whose press does nothing is worse than a missing row.
  assert.match(palette, /const \[rulesCanRun, setRulesCanRun\] = useState\(\(\) => ruleRunAvailable\(\)\)/)
  assert.match(palette, /useEffect\(\(\) => subscribeRuleRun\(\(\) => setRulesCanRun\(ruleRunAvailable\(\)\)\), \[\]\)/)
  assert.match(palette, /const ruleRows = rulesCanRun\s*\n\s*\? ruleRunRows\(automations, machines, \{ answered: machinesAnswered \}\)/)
  assert.match(palette, /section: RULES_SECTION,/)
  assert.match(palette, /run: \{ ruleRun: rule\.id \},/)
  assert.match(palette, /\.\.\.everything\.ruleRows\]/, 'the rows ride the same ranking as every other group')
})

test('choosing a rule shows the answer line and asks the view, not the daemon', () => {
  assert.match(palette, /if \(r\.ruleRun\) \{/)
  assert.match(palette, /setRuleRunState\(\{ phase: 'running', name: row\.name \}\)/)
  assert.match(palette, /setPage\('rule-run'\)/)
  assert.match(palette, /runRule\(r\.ruleRun\)\.then\(\(result\) => \{/)
  // The palette never calls the run route itself: the view's Run now is the
  // one path, and the palette only renders what came back.
  assert.doesNotMatch(palette, /runAutomation/)
  assert.match(palette, /page === 'rule-run' && ruleRunState/)
  assert.match(palette, /className="kb-stop-question" role="status">\s*\{ruleAnswer\(ruleRunState\)\}/)
  // The page's only row is the way out, so Enter or Esc both end it.
  assert.match(palette, /page === 'rule-run'\) \{[\s\S]{0,400}caughtClose: true/)
})

test('the Automations view lends its own Run now and takes it back on unmount', () => {
  assert.match(view, /import \{ RULE_GONE, registerRuleRun \} from '\.\/rule-run\.js'/)
  // Registered once per mount: the effect returns the seam's unregister.
  assert.match(view, /useEffect\(\(\) => registerRuleRun\(\(id\) => paletteRun\.current\(id\)\), \[\]\)/)
  // The handler is the view's runNow, the same path the row's button uses.
  assert.match(view, /paletteRun\.current = async \(id\) => \{[\s\S]{0,300}const session = await runNow\(rule\)/)
  assert.equal(
    (view.match(/runAutomation\(rule\.id\)/g) ?? []).length,
    1,
    'the run route is called in one place, not copied for the palette',
  )
  assert.match(view, /if \(session\) onOpenChat\?\.\(session\.id\)/, 'and it opens the chat it started')
  // A refusal keeps the daemon's sentence, which is what the palette answers.
  assert.match(view, /lastFailure\.current = message/)
  assert.match(view, /error: lastFailure\.current \?\? null/)
})

test('the module keeps the seam small and the copy in one place', () => {
  assert.match(rules, /export function registerRuleRun\(fn\)/)
  assert.match(rules, /export function ruleRunAvailable\(\)/)
  assert.match(rules, /export function subscribeRuleRun\(fn\)/)
  assert.match(rules, /export async function runRule\(id\)/)
  assert.match(rules, /export function runningLine\(name\)/)
  assert.match(rules, /export const RULE_STARTED = 'Started\.'/)
  assert.match(rules, /export const RULE_GONE = 'That rule is not available any more\.'/)
  assert.match(rules, /export const RULE_FALLBACK = 'The rule did not start\.'/)
  // The palette renders one line through one function, in every phase.
  assert.match(rules, /export function ruleAnswer\(/)
  assert.doesNotMatch(rules, /—/, 'no em dashes in the copy')
})
