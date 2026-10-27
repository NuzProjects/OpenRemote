import assert from 'node:assert/strict'
import test from 'node:test'

import { MAX_PANES, newLayout, leaves, paneCount, splitLeaf } from './split.js'
import {
  RACE_MAX,
  RACE_MIN,
  freePanes,
  offerableHarnesses,
  raceLayout,
  racePlan,
  racePrompts,
  raceRetry,
} from './race.js'

// What the daemon's capabilities list looks like, trimmed to the fields the
// rule reads: installed (`available`) and turned on (`enabled`).
const installed = (id, extra = {}) => ({ id, available: true, enabled: true, ...extra })

const OFFERED = [installed('claude'), installed('codex'), installed('grok'), installed('pi')]

test('the race offers the harnesses installed here, and only those', () => {
  const harnesses = [
    installed('claude'),
    installed('codex', { available: false }),
    installed('grok', { available: true, enabled: false }),
    installed('pi'),
  ]
  assert.deepEqual(
    offerableHarnesses(harnesses).map((h) => h.id),
    ['claude', 'pi'],
    'not installed, or turned off, is not on offer',
  )
  assert.deepEqual(offerableHarnesses(undefined), [])
})

test('two is the fewest that compares anything', () => {
  assert.equal(RACE_MIN, 2)
  assert.equal(RACE_MAX, MAX_PANES, 'the pane cap is the race cap')
  const plan = racePlan({ offerable: OFFERED, chosen: ['claude'], free: 4, prompt: 'x' })
  assert.equal(plan.canStart, false)
  assert.equal(plan.refusal.code, 'too-few')
})

test('a window with no free pane refuses before anything starts', () => {
  const plan = racePlan({ offerable: OFFERED, chosen: ['claude', 'codex'], free: 0, prompt: 'x' })
  assert.equal(plan.canStart, false)
  assert.equal(plan.refusal.code, 'no-panes')
  const one = racePlan({ offerable: OFFERED, chosen: ['claude', 'codex'], free: 1, prompt: 'x' })
  assert.equal(one.canStart, false, 'one pane cannot hold two chats')
  assert.equal(one.refusal.code, 'no-panes')
})

test('a race that does not fit names the harnesses that would be left out', () => {
  const plan = racePlan({
    offerable: OFFERED,
    chosen: ['claude', 'codex', 'grok'],
    free: 2,
    prompt: 'x',
  })
  assert.equal(plan.canStart, false)
  assert.equal(plan.refusal.code, 'not-enough-panes')
  assert.equal(plan.refusal.free, 2)
  assert.equal(plan.refusal.missing.length, 1, 'one harness does not fit, and it is named')
  assert.ok(plan.refusal.missing[0].length > 0)
})

test('four is the most a window shows, and an empty prompt starts nothing', () => {
  const four = racePlan({
    offerable: OFFERED,
    chosen: ['claude', 'codex', 'grok', 'pi'],
    free: 4,
    prompt: 'compare',
  })
  assert.equal(four.canStart, true, 'four is allowed at four free panes')
  assert.equal(four.count, 4)
  const empty = racePlan({ offerable: OFFERED, chosen: ['claude', 'codex'], free: 4, prompt: '  ' })
  assert.equal(empty.canStart, false)
  assert.equal(empty.refusal.code, 'no-prompt')
  const five = racePlan({
    offerable: [...OFFERED, installed('agy')],
    chosen: ['claude', 'codex', 'grok', 'pi', 'agy'],
    free: 4,
    prompt: 'x',
  })
  assert.equal(five.canStart, false)
  assert.equal(five.refusal.code, 'too-many')
})

test('a machine with nothing installed refuses in its own words', () => {
  const plan = racePlan({ offerable: [installed('claude', { available: false })], chosen: [], free: 4, prompt: 'x' })
  assert.equal(plan.canStart, false)
  assert.equal(plan.refusal.code, 'no-harnesses')
})

test('a harness the person did not pick, or one not on offer, is not in the plan', () => {
  const plan = racePlan({
    offerable: OFFERED,
    chosen: ['claude', 'claude', 'codex', 'agy'],
    free: 4,
    prompt: 'x',
  })
  assert.deepEqual(plan.chosen, ['claude', 'claude', 'codex'], 'unknown ids drop out')
  assert.equal(plan.count, 3)
})

test('the same prompt goes to every harness, trimmed once', () => {
  const calls = racePrompts(['claude', 'codex'], '  Which sorting is right?  ')
  assert.deepEqual(calls, [
    { harness: 'claude', text: 'Which sorting is right?' },
    { harness: 'codex', text: 'Which sorting is right?' },
  ])
  assert.deepEqual(racePrompts([], 'x'), [])
})

// A window whose focused pane is a chat of its own, so the race opens a new
// pane per chat instead of taking the primary.
const started = () => splitLeaf(newLayout(), 'p1', 'row', 'older-chat')

test('an empty primary pane takes the first chat, and the rest open beside it', () => {
  const race = raceLayout(newLayout(), ['a', 'b'])
  assert.equal(race.primary, 'a', 'the caller navigates the primary to the first chat')
  assert.equal(paneCount(race.layout), 2, 'one pane filled, one opened: no blank pane')
  assert.deepEqual(
    leaves(race.layout.root).map((leaf) => leaf.view),
    [null, 'b'],
    'the primary keeps its navigation view, so the order on screen is a then b',
  )
})

test('two to four chats fill the window, in the order they were chosen', () => {
  for (const count of [2, 3, 4]) {
    const views = Array.from({ length: count }, (_, i) => `chat-${i + 1}`)
    const race = raceLayout(newLayout(), views)
    assert.equal(race.primary, views[0], 'the primary pane takes the first chat')
    assert.equal(paneCount(race.layout), count, `${count} chats, ${count} panes`)
    assert.deepEqual(
      leaves(race.layout.root).map((leaf) => leaf.view),
      [null, ...views.slice(1)],
      'reading order is the order they were picked',
    )
  }
})

test('every race pane is the same width', () => {
  for (const count of [2, 3, 4]) {
    const views = Array.from({ length: count }, (_, i) => `chat-${i + 1}`)
    const layout = raceLayout(newLayout(), views).layout
    for (const size of layout.root.sizes) {
      assert.ok(Math.abs(size - 1 / count) < 0.001, `${count} chats share the window evenly`)
    }
  }
})

test('a race beside a chat you already had opens its own panes and evens the row', () => {
  // The focused pane is a chat, so it is not taken over: every race chat gets a
  // pane of its own, and the row they land in is evened out at one size, the
  // panes that were already in it included.
  const race = raceLayout(started(), ['a', 'b'])
  assert.equal(race.primary, null, 'a focused chat pane is not taken over')
  assert.equal(paneCount(race.layout), 4, 'the two chats already there, plus two')
  assert.deepEqual(
    leaves(race.layout.root).map((leaf) => leaf.view).slice(-2),
    ['a', 'b'],
    'the race chats read in the order they were picked',
  )
  for (const size of race.layout.root.sizes) {
    assert.ok(Math.abs(size - 0.25) < 0.001, 'four panes, one size each')
  }
})

test('free panes are what the cap leaves, counting a pane the race can fill', () => {
  assert.equal(freePanes(newLayout()), MAX_PANES, 'the primary is a pane a race can fill')
  assert.equal(freePanes(started()), MAX_PANES - 2, 'two panes, both in use')
  const full = raceLayout(started(), ['a', 'b']).layout
  assert.equal(paneCount(full), MAX_PANES)
  assert.equal(freePanes(full), 0)
  const refused = raceLayout(full, ['d', 'e'])
  assert.equal(refused.layout, full, 'past the cap the layout is handed back untouched')
  assert.equal(refused.primary, null)
})

test('a failed race retries only the harnesses that produced no chat', () => {
  // Three picked, the first two made chats, the third failed: retrying must
  // race only the third, in its place, never the two whose panes are already
  // on screen.
  assert.deepEqual(raceRetry(['claude', 'codex', 'grok'], ['claude', 'codex']), ['grok'])
  assert.deepEqual(
    raceRetry(['claude', 'codex', 'grok'], []),
    ['claude', 'codex', 'grok'],
    'nothing created: the whole selection comes back, so a failure before the first chat retries everything',
  )
  assert.deepEqual(
    raceRetry(['grok', 'claude'], ['claude']),
    ['grok'],
    'picking order is kept, not sorted',
  )
  assert.deepEqual(raceRetry([], ['claude']), [])
  assert.deepEqual(raceRetry(undefined, ['claude']), [])
})

test('a retry left with one harness is refused, so Start cannot fire over it', () => {
  // The case the bug report named: two picked, one opened, one failed. The
  // filter leaves one, and a race of one is a chat, so the same rules that
  // disable Start for a single pick disable it here.
  const left = raceRetry(['claude', 'codex'], ['claude'])
  assert.deepEqual(left, ['codex'])
  const plan = racePlan({ offerable: OFFERED, chosen: left, free: 4, prompt: 'which is right?' })
  assert.equal(plan.canStart, false)
  assert.equal(plan.refusal.code, 'too-few')
  // And with two left it is a race again, which is the point of filtering.
  const two = racePlan({
    offerable: OFFERED,
    chosen: raceRetry(['claude', 'codex', 'grok'], ['claude']),
    free: 4,
    prompt: 'which is right?',
  })
  assert.equal(two.canStart, true)
  assert.deepEqual(two.chosen, ['codex', 'grok'])
})
