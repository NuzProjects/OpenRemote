import assert from 'node:assert/strict'
import test from 'node:test'

import {
  RULE_FALLBACK,
  RULE_GONE,
  RULE_STARTED,
  RULES_SECTION,
  registerRuleRun,
  ruleAnswer,
  ruleBlockedRowLine,
  ruleCannotRun,
  ruleCannotRunTitle,
  ruleMachineLabel,
  ruleMachineState,
  ruleRunAvailable,
  ruleRunRows,
  runRule,
  runningLine,
  subscribeRuleRun,
} from './rule-run.js'

// The daemon's machine list, one row per machine, as the console holds it.
const machines = [
  { machine: { id: 'box', name: 'build-box', status: 'online', this_machine: false } },
  { machine: { id: 'mini', name: 'mac-mini', status: 'waiting', this_machine: false } },
  { machine: { id: 'here', name: 'laptop', status: 'online', this_machine: true } },
]

const rule = (id, extra = {}) => ({
  id,
  name: `rule ${id}`,
  enabled: true,
  machine: null,
  trigger: { kind: 'daily', time: '09:00' },
  ...extra,
})

test('a rule is offered when it is on and the machine it names is online', () => {
  assert.equal(ruleCannotRun(rule('a'), machines), null)
  assert.equal(
    ruleCannotRun(rule('a', { machine: 'box' }), machines),
    null,
    'a rule on a machine that is online can run',
  )
  assert.equal(ruleCannotRun(rule('a', { machine: 'here' }), machines), null, 'this computer counts too')
  assert.equal(RULES_SECTION, 'Rules')
})

test('a rule that cannot run is not offered, and says which way it is stuck', () => {
  assert.equal(ruleCannotRun(rule('a', { enabled: false }), machines), 'paused')
  assert.equal(ruleCannotRun(rule('a', { machine: 'gone' }), machines), 'no-machine')
  assert.equal(ruleCannotRun(rule('a', { machine: 'mini' }), machines), 'machine-offline')
  assert.equal(
    ruleCannotRun(rule('a', { machine: 'box' }), [], { answered: false }),
    'not-answered',
    'unknown is not a yes: a machine list that has not answered offers nothing',
  )
  assert.equal(ruleCannotRun(rule('a', { name: '  ' }), machines), 'nameless')
  assert.equal(ruleCannotRun(null, machines), 'missing')
})

test('the rows keep the Automations list order and name when and where', () => {
  const rows = ruleRunRows(
    [
      rule('nightly', { name: 'Nightly review' }),
      rule('paused', { name: 'Paused one', enabled: false }),
      rule('build', { name: 'Build check', machine: 'box', trigger: { kind: 'webhook', key: 'k' } }),
      rule('waiting', { name: 'Waiting one', machine: 'mini' }),
      rule('gone', { name: 'Gone one', machine: 'nope' }),
    ],
    machines,
  )
  assert.deepEqual(rows.map((r) => r.id), ['nightly', 'build'], 'only the runnable ones, in list order')
  assert.deepEqual(rows[0], {
    id: 'nightly',
    name: 'Nightly review',
    sub: 'Every day at 09:00 · this computer',
  })
  assert.equal(rows[1].sub, 'A webhook arrives · build-box', 'a machine rule names its machine')
  assert.equal(ruleMachineLabel(rule('x', { machine: 'box' }), machines), 'build-box')
  assert.equal(ruleMachineLabel(rule('x'), machines), 'this computer')
  assert.equal(ruleMachineLabel(rule('x', { machine: 'gone' }), machines), 'a machine')
  assert.deepEqual(ruleRunRows(undefined, machines), [], 'a list that has not arrived offers nothing')
})

test('the answer is one line, and each phase has its own', () => {
  assert.equal(runningLine('Nightly review'), 'Running “Nightly review”.')
  assert.equal(ruleAnswer({ phase: 'running', name: 'Nightly review' }), 'Running “Nightly review”.')
  assert.equal(ruleAnswer({ phase: 'started' }), RULE_STARTED)
  assert.equal(ruleAnswer({ phase: 'refused', error: 'build-box is offline' }), 'build-box is offline')
  assert.equal(ruleAnswer({ phase: 'refused', error: null }), RULE_FALLBACK)
  assert.equal(ruleAnswer({}), 'Running “that rule”.', 'a name-less run still reads as a sentence')
})

test('the seam answers a request with the shape the palette renders', async () => {
  assert.equal(ruleRunAvailable(), false, 'nothing registered: no rules are offered')
  const ran = []
  const unregister = registerRuleRun(async (id) => {
    ran.push(id)
    return id === 'works' ? { ok: true } : { ok: false, error: 'The daemon refused: no machine is on.' }
  })
  assert.equal(ruleRunAvailable(), true)
  assert.deepEqual(await runRule('works'), { ok: true })
  assert.deepEqual(ran, ['works'])
  assert.deepEqual(await runRule('refused'), {
    ok: false,
    error: 'The daemon refused: no machine is on.',
  })
  unregister()
  assert.equal(ruleRunAvailable(), false)
  assert.deepEqual(await runRule('works'), { ok: false, error: RULE_GONE }, 'no view, no run')
})

test('a handler that throws and a result with no sentence both become refusals', async () => {
  const unregister = registerRuleRun(() => {
    throw new Error('the daemon did not answer in time')
  })
  assert.deepEqual(await runRule('x'), { ok: false, error: 'the daemon did not answer in time' })
  unregister()
  const unregisterSilent = registerRuleRun(async () => ({ ok: false }))
  assert.deepEqual(await runRule('x'), { ok: false, error: RULE_FALLBACK })
  unregisterSilent()
})

test('the group follows the seam coming and going, and only clears its own', () => {
  const seen = []
  const stop = subscribeRuleRun(() => seen.push(ruleRunAvailable()))
  const first = registerRuleRun(async () => ({ ok: true }))
  assert.deepEqual(seen, [true], 'the palette hears about the action arriving')
  const second = registerRuleRun(async () => ({ ok: true }))
  assert.equal(ruleRunAvailable(), true)
  first()
  assert.equal(ruleRunAvailable(), true, 'the first view leaving does not take the second one away')
  second()
  assert.deepEqual(seen, [true, true, false])
  stop()
  registerRuleRun(async () => ({ ok: true }))()
  assert.deepEqual(seen, [true, true, false], 'an unsubscribed listener hears nothing')
})

test('the newest view leaving puts the one behind it back, not an empty seam', async () => {
  // Two panes can both show Automations: the newest answers, and when it
  // unmounts the one still on screen has to answer again. Before the stack this
  // was the order that emptied the seam while a view was mounted.
  const first = registerRuleRun(async () => ({ ok: true }))
  const second = registerRuleRun(async () => ({ ok: false, error: 'the second pane said no' }))
  assert.deepEqual(await runRule('rule-1'), { ok: false, error: 'the second pane said no' })
  second()
  assert.equal(ruleRunAvailable(), true, 'a view is still on screen')
  assert.deepEqual(await runRule('rule-1'), { ok: true }, 'and it is the one that answers')
  // Unregistering twice is the same as unregistering once.
  second()
  assert.equal(ruleRunAvailable(), true)
  first()
  assert.equal(ruleRunAvailable(), false, 'the last one leaving closes the seam')
  assert.deepEqual(await runRule('rule-1'), { ok: false, error: RULE_GONE })
})

test('a rule says where its machine stands, never by id', () => {
  // A saved machine that left the account names a sentence, not an id: an id is
  // the one thing a person cannot use.
  assert.deepEqual(ruleMachineState(rule('a'), machines), { state: 'here', label: 'this computer' })
  assert.equal(ruleMachineState(rule('a', { machine: 'box' }), machines).state, 'online')
  assert.equal(ruleMachineState(rule('a', { machine: 'box' }), machines).label, 'build-box')
  assert.equal(ruleMachineState(rule('a', { machine: 'mini' }), machines).state, 'offline')
  const gone = ruleMachineState(rule('a', { machine: 'gone' }), machines)
  assert.equal(gone.state, 'gone')
  assert.equal(gone.label, 'a machine that is no longer in your account')
  assert.equal(gone.label.includes('gone'), false, 'the id is not what a person reads')
})

test('the Run button says why it is off, in the row own words', () => {
  assert.equal(ruleCannotRunTitle(null), 'Run now')
  assert.equal(ruleCannotRunTitle('paused'), 'Enable the rule to run it')
  assert.equal(ruleCannotRunTitle('machine-offline'), 'Its machine has not come online yet')
  assert.match(ruleCannotRunTitle('no-machine'), /no longer in your account/)
  assert.match(ruleCannotRunTitle('not-answered'), /has not answered/)
  // The title comes from the same code the palette refuses on, so the two
  // surfaces cannot disagree: every code the predicate returns has words.
  for (const code of ['paused', 'no-machine', 'machine-offline', 'not-answered', 'nameless', 'missing']) {
    assert.notEqual(ruleCannotRunTitle(code), 'Run now', code)
  }
})

test('the rule row says why a rule cannot run, in a short line of its own words', () => {
  // A tooltip is not a visible sentence: a row whose machine is asleep used to
  // look exactly like a healthy one. The row now carries the fact, as a
  // fragment so it fits beside the when, the harness and the last run.
  assert.equal(ruleBlockedRowLine('machine-offline'), 'its machine is offline')
  assert.equal(ruleBlockedRowLine('no-machine'), 'its machine is gone')
  assert.equal(ruleBlockedRowLine('not-answered'), 'still reading its machine')
  // Paused has the row's own off class; missing and nameless are not about a
  // machine and never reach a drawn row; a rule that runs says nothing extra.
  for (const code of ['paused', 'missing', 'nameless', null, undefined, '']) {
    assert.equal(ruleBlockedRowLine(code), null, String(code))
  }
  const rule = {
    id: 'r1',
    name: 'Nightly sweep',
    enabled: true,
    harness: 'claude',
    machine: 'm1',
    trigger: { kind: 'clock' },
  }
  const machines = [{ machine: { id: 'm1', name: 'studio', status: 'online' } }]
  assert.equal(ruleCannotRun(rule, machines), null)
  assert.equal(ruleBlockedRowLine(ruleCannotRun(rule, machines)), null)
})

test('a row and its tooltip read one table, so they cannot disagree', () => {
  // The machine-caused codes keep the tooltip sentences they had; the row
  // sentence is the same fact in fewer words, and both come from one place.
  const pairs = [
    ['machine-offline', 'Its machine has not come online yet'],
    ['no-machine', 'The machine this rule ran on is no longer in your account'],
    ['not-answered', 'The list of machines has not answered yet'],
  ]
  for (const [code, title] of pairs) {
    assert.equal(ruleCannotRunTitle(code), title, code)
    assert.ok(ruleBlockedRowLine(code), code)
  }
})