// The line under a waiting chat's title: which words a decision carries,
// the first line, the cut and its marker, and the cache that keeps the
// sidebar to one read per question. The wiring half reads the sidebar and
// its stylesheet, the style this repo uses where no renderer exists.

import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import {
  CUT_MARK,
  LINE_LIMIT,
  cutLine,
  decisionText,
  firstLine,
  hasLine,
  lineFor,
  missingLines,
  pruneLines,
  questionKey,
  questionLine,
  questionText,
  rememberLine,
  wantedKeys,
} from './question-line.js'

const decision = (over = {}) => ({
  id: 'd1',
  state: 'pending',
  kind: 'approval',
  tool_name: 'Bash',
  harness_request: { command: 'cargo test --locked', description: 'run the tests' },
  options: [],
  ...over,
})

test('a question carries its own words first', () => {
  const claudeQuestion = decision({
    kind: 'question',
    tool_name: 'AskUserQuestion',
    harness_request: { questions: [{ question: 'Which tests should I run?' }] },
  })
  assert.deepEqual(decisionText(claudeQuestion), { text: 'Which tests should I run?', via: 'question' })
  assert.equal(questionText([claudeQuestion]), 'Which tests should I run?')
  // The flat key wins over the nested one, because it is the same question.
  assert.equal(decisionText(decision({ harness_request: { question: 'Pick one', title: 'T' } })).via, 'question')
})

test('a title is the next best thing a harness gives', () => {
  assert.deepEqual(decisionText(decision({ kind: 'question', harness_request: { title: 'Which database?' } })), {
    text: 'Which database?',
    via: 'title',
  })
})

test('an approval is about a command, named with its tool', () => {
  const approval = decisionText(decision())
  assert.deepEqual(approval, { text: 'Bash: cargo test --locked', via: 'command' })
  // An action word reads the same way (opencode's own vocabulary).
  assert.equal(decisionText(decision({ harness_request: { action: 'bash' } })).text, 'Bash: bash')
  // No tool name to prefix, so the command stands on its own.
  assert.equal(decisionText(decision({ tool_name: undefined })).text, 'cargo test --locked')
})

test('a description is the last words before a sentence is built', () => {
  assert.deepEqual(decisionText(decision({ harness_request: { description: 'reach the build box' } })), {
    text: 'reach the build box',
    via: 'description',
  })
})

test('a decision with no words at all still says something true', () => {
  assert.deepEqual(decisionText({ kind: 'approval', tool_name: 'Write', harness_request: {} }), {
    text: 'It wants to use Write.',
    via: 'kind',
  })
  assert.equal(decisionText({ kind: 'approval', harness_request: {} }).text, 'It is waiting on an approval.')
  assert.equal(decisionText({ kind: 'question', harness_request: {} }).text, 'It is waiting for your answer.')
  assert.equal(decisionText({ harness_request: {} }).text, 'It is waiting.')
})

test('the first line is the first line, whatever whitespace the harness kept', () => {
  assert.equal(firstLine('Which tests?\nThe long story follows.'), 'Which tests?')
  assert.equal(firstLine('\n\n  Which   database?\n'), 'Which database?')
  assert.equal(firstLine('one\ttab'), 'one tab')
  assert.equal(firstLine(''), null)
  assert.equal(firstLine(null), null)
  assert.equal(firstLine(42), null)
})

test('a short question is shown whole and says it is whole', () => {
  assert.deepEqual(cutLine('Which tests should I run?'), { text: 'Which tests should I run?', cut: false })
})

test('a long question is cut at a word boundary and the marker says so', () => {
  const long = 'Should I rewrite the whole adaptor so the retry ladder is honest about a wedged daemon?'
  const line = cutLine(long)
  assert.equal(line.cut, true)
  assert.ok(line.text.endsWith(CUT_MARK))
  assert.ok(line.text.length <= LINE_LIMIT + CUT_MARK.length)
  // Cut at a space, not mid-word: what is kept is a prefix of the question,
  // and the next character in the whole sentence is where the word ended.
  const kept = line.text.slice(0, -CUT_MARK.length)
  assert.ok(long.startsWith(kept))
  assert.equal(long.slice(kept.length, kept.length + 1), ' ', 'the cut lands on a space')
  assert.equal(line.text, line.text.replace(/\s+\$/, ''), 'no trailing space before the marker')
})

test('a wall of text with no space is cut hard, still with the marker', () => {
  const url = `https://example.test/${'a'.repeat(200)}`
  const line = cutLine(url)
  assert.equal(line.cut, true)
  assert.ok(line.text.endsWith(CUT_MARK))
  assert.equal(line.text.slice(0, -CUT_MARK.length).length, LINE_LIMIT)
})

test('the line for a chat is its first pending decision, and nothing else', () => {
  assert.equal(questionText([decision()]), 'Bash: cargo test --locked')
  // An answered decision is not the question any more.
  assert.equal(questionText([decision({ state: 'answered' }), decision({ id: 'd2', kind: 'question', harness_request: { question: 'Now?' } })]), 'Now?')
  assert.equal(questionText([decision({ state: 'answered' })]), null)
  assert.equal(questionText([]), null)
})

test('an unreadable answer produces no line, never an error', () => {
  for (const answer of [null, undefined, 'a string', 42, { decisions: [decision()] }]) {
    assert.equal(questionText(answer), null, String(answer))
    assert.equal(questionLine(answer), null)
  }
})

test('the key is the chat and the stamp it is waiting under', () => {
  assert.equal(questionKey('chat-1', 1700), 'chat-1@1700')
  assert.equal(questionKey('chat-1', undefined), 'chat-1@0')
})

test('a steady state asks for no reads; a new question asks for one', () => {
  const waiting = [{ id: 'a', updatedAt: 10 }, { id: 'b', updatedAt: 20 }]
  assert.equal(missingLines({}, waiting).length, 2)
  const cache = rememberLine(rememberLine({}, questionKey('a', 10), 'Ask A?'), questionKey('b', 20), null)
  // Read once each, including the one that had nothing to say: no retry
  // loop, because the stamp has not changed.
  assert.deepEqual(missingLines(cache, waiting), [])
  assert.deepEqual(wantedKeys(waiting), ['a@10', 'b@20'])
  // The chat answers, then asks again: its stamp moved, so one read.
  const again = [{ id: 'a', updatedAt: 31 }, { id: 'b', updatedAt: 20 }]
  assert.deepEqual(missingLines(cache, again).map((row) => row.id), ['a'])
})

test('a chat that stops waiting is dropped, and a stale line cannot show', () => {
  const cache = rememberLine({}, questionKey('a', 10), 'Ask A?')
  assert.deepEqual(pruneLines(cache, wantedKeys([{ id: 'b', updatedAt: 20 }])), {})
  // The same chat with a newer stamp gets a fresh read rather than the old line.
  assert.equal(lineFor(cache, 'a', 31), null)
  assert.equal(hasLine(cache, 'a', 31), false)
  assert.equal(lineFor(cache, 'a', 10), 'Ask A?')
})

test('remembering nothing is remembering: absent and null are different', () => {
  const cache = rememberLine({}, 'k', null)
  assert.deepEqual(cache, { k: null })
  assert.equal(hasLine(cache, 'chat-1', 0) === false, true, 'not this key')
})

// ---- the sidebar wiring ----

const sidebar = readFileSync(new URL('./Sidebar.jsx', import.meta.url), 'utf8')
const css = readFileSync(new URL('./sidebar.css', import.meta.url), 'utf8')

test('the waiting row renders the line under the title, never as a control', () => {
  assert.match(sidebar, /className="chat-titles"/)
  assert.match(sidebar, /className="chat-question pv">\{row\.question\}/)
  const row = sidebar.slice(sidebar.indexOf('className="chat-question'), sidebar.indexOf('className="chat-question') + 120)
  assert.ok(!/onClick|onKeyDown/.test(row), 'the question is text, not a button')
})

test('the rule that the sidebar never answers is written down where it renders', () => {
  assert.match(sidebar, /never answers|answers, approves or dismisses/)
})

test('one decision read per waiting chat, and only for a stamp not yet read', () => {
  assert.match(sidebar, /from '\.\/question-line\.js'/)
  assert.match(sidebar, /missingLines\(/)
  assert.match(sidebar, /api\.decisions\(/)
  assert.equal((sidebar.match(/decisions\(/g) ?? []).length, 1, 'one read site')
  // No polling loop of its own: the sessions beat is the only clock.
  assert.doesNotMatch(sidebar, /setInterval/)
})

test('the group emptying reads nothing and holds nothing', () => {
  assert.match(sidebar, /if \(!needs\.chats\.length\)/)
  assert.match(sidebar, /pruneLines\(/)
})

test('a failed read is remembered so it is not retried beat after beat', () => {
  assert.match(sidebar, /catch \{/)
  assert.match(sidebar, /rememberLine\(cache, questionKey\(row\.id, row\.updatedAt\), line\)/)
  assert.match(sidebar, /Kept even when null/, 'the rule is written down')
})

test('the line is one quiet row under the title', () => {
  assert.match(css, /\.chat-titles \{/)
  const rule = css.slice(css.indexOf('.chat-question {'), css.indexOf('.chat-question {') + 260)
  assert.match(rule, /white-space: nowrap/)
  assert.match(rule, /text-overflow: ellipsis/)
  assert.match(rule, /color: var\(--text-3\)/)
})
