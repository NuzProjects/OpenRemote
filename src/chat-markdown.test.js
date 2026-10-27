// A chat as Markdown: what each item kind becomes, what is left out on
// purpose, the cap on a tool's output, and the one line the palette answers
// with. The rules are the interesting part, so the tests pin the text, not
// just that something was produced.

import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { TOOL_CAP, chatMarkdown, copiedLine, fenceFor, thousands } from './chat-markdown.js'

const chatOf = (timeline, over = {}) => ({ id: 'c1', title: 'Triage the failing tests', harness: 'claude', timeline, ...over })

const message = (role, text) => ({ kind: 'message', role, text })
const tool = (over = {}) => ({ kind: 'tool', name: 'Bash', turn: 1, input: { command: 'cargo test --locked' }, state: 'ok', result: 'ok. 12 passed', ...over })

test('the whole shape, from the title to an answered decision', () => {
  const { text } = chatMarkdown(
    chatOf([
      message('user', 'Why is the daemon job red?'),
      message('agent', 'The format check is the first step.'),
      message('note', 'The daemon restarted.'),
      tool({ result: 'error: 42 hunks in 8 files', state: 'failed' }),
      { kind: 'decision', id: 'd1', toolName: 'Bash', input: { command: 'cargo fmt --all' }, pending: false, answeredChoice: 'allow' },
    ]),
  )
  const lines = text.split('\n')
  assert.equal(lines[0], '# Triage the failing tests')
  assert.match(text, /\*\*You\*\*\n\nWhy is the daemon job red\?/)
  // The harness speaks in the console's own display name for it.
  assert.match(text, /\*\*Claude Code\*\*\n\nThe format check is the first step\./)
  assert.match(text, /> The daemon restarted\./)
  assert.match(text, /\*\*Tool: Bash \(failed\)\*\*\n\n```sh\ncargo test --locked\n```/)
  assert.match(text, /Result:\n\n```\nerror: 42 hunks in 8 files\n```/)
  assert.match(text, /\*\*Decision\*\*\n\nBash: cargo fmt --all\n\n\*\*Answered:\*\* allow/)
})

test('a note that runs over several lines keeps every line quoted', () => {
  const { text } = chatMarkdown(chatOf([message('note', 'First line.\nSecond line.')]))
  assert.match(text, /> First line\.\n> Second line\./)
})

test('a decision with no answer says it is waiting, and invents no choice', () => {
  const { text } = chatMarkdown(chatOf([{ kind: 'decision', id: 'd2', toolName: null, input: { questions: [{ question: 'Which database?' }] }, pending: true, answeredChoice: null }]))
  assert.match(text, /\*\*Decision\*\*\n\nWhich database\?\n\n\*\*Waiting for an answer\.\*\*/)
  assert.doesNotMatch(text, /Answered/)
})

test('a tool that only started, and one that only answered, each render what they have', () => {
  const started = chatMarkdown(chatOf([tool({ result: null })])).text
  assert.match(started, /\*\*Tool: Bash\*\*\n\n```sh\ncargo test --locked\n```/)
  assert.doesNotMatch(started, /Result:/)
  const answered = chatMarkdown(chatOf([tool({ name: 'Read', input: null, result: 'file contents' })])).text
  assert.match(answered, /\*\*Tool: Read\*\*\n\nResult:\n\n```\nfile contents\n```/)
})

test('a tool with neither input nor output, and an empty message, write nothing', () => {
  const bare = { kind: 'tool', name: 'Bash', input: null, result: null, state: 'ok' }
  assert.equal(chatMarkdown(chatOf([bare])), null)
  assert.equal(chatMarkdown(chatOf([message('agent', '   ')])), null)
  // And a chat with one real line still does not show the empty ones.
  const { text } = chatMarkdown(chatOf([bare, message('user', 'One line.'), message('agent', '')]))
  assert.equal(text.match(/\*\*Claude Code\*\*/g), null)
})

test('an empty chat has nothing to write, and a chat with a missing title still has one', () => {
  assert.equal(chatMarkdown({ title: 'Empty', timeline: [] }), null)
  assert.equal(chatMarkdown(null), null)
  assert.equal(chatMarkdown({}), null)
  assert.match(chatMarkdown(chatOf([message('user', 'hi')], { title: '' })).text, /^# A new task\n/)
})

test('reasoning is left out: it is thinking, not what was said', () => {
  const { text } = chatMarkdown(chatOf([{ kind: 'reasoning', text: 'hmm' }, { kind: 'reasoning-stream', text: 'hmmm' }, message('user', 'hi')]))
  assert.doesNotMatch(text, /hmm/)
  assert.match(text, /\*\*You\*\*/)
})

test('an assistant message still arriving is written, not dropped', () => {
  const { text } = chatMarkdown(chatOf([{ kind: 'stream', turn: 2, text: 'Reading the log so far' }]))
  assert.match(text, /\*\*Claude Code\*\*\n\nReading the log so far/)
})

test('one huge tool output is capped, and the marker says how much was left out', () => {
  const huge = 'x'.repeat(TOOL_CAP + 1234)
  const result = chatMarkdown(chatOf([tool({ result: huge })]))
  assert.equal(result.shortened, 1)
  assert.match(result.text, new RegExp(`\\[\\.\\.\\. truncated: ${thousands(huge.length)} characters total, ${thousands(TOOL_CAP)} kept \\.\\.\\.\\]`))
  // What is kept is exactly the cap, and the whole output is not in there.
  assert.ok(result.text.includes('x'.repeat(TOOL_CAP)))
  assert.ok(!result.text.includes('x'.repeat(TOOL_CAP + 1)))
})

test('two shortened sections are counted, and a chat with none says so by omission', () => {
  const huge = 'y'.repeat(TOOL_CAP + 1)
  const two = chatMarkdown(chatOf([tool({ result: huge }), tool({ result: huge })]))
  assert.equal(two.shortened, 2)
  assert.equal(chatMarkdown(chatOf([tool()])).shortened, 0)
})

test('a long line in a message is kept long: nothing is wrapped or cut', () => {
  const long = 'a'.repeat(3000)
  const { text } = chatMarkdown(chatOf([message('agent', long)]))
  assert.ok(text.includes(long))
  assert.equal(text.split('\n').filter((line) => line.startsWith('a')).length, 1)
})

test('a fence grows when the output already holds one', () => {
  const body = 'before\n```\ninner\n```\nafter'
  const { text } = chatMarkdown(chatOf([tool({ result: body })]))
  assert.match(text, /````\nbefore\n```\ninner\n```\nafter\n````/)
  assert.equal(fenceFor('no fences'), '```')
  assert.equal(fenceFor('a ```` run'), '`````')
})

test('a large tool input is capped like an output, and counted', () => {
  const huge = 'x'.repeat(TOOL_CAP + 250)
  const one = chatMarkdown(chatOf([tool({ input: { command: huge }, result: 'ok' })]))
  assert.equal(one.shortened, 1)
  assert.match(one.text, /\[\.\.\. truncated: 4,250 characters total, 4,000 kept \.\.\.\]/)
  // Both halves cut in one call: two sections, as the answer line says.
  const both = chatMarkdown(chatOf([tool({ input: { command: huge }, result: huge })]))
  assert.equal(both.shortened, 2)
  assert.match(copiedLine(both), /\(2 sections shortened\)\.$/)
  // A small input stays whole, with its language tag.
  const small = chatMarkdown(chatOf([tool({ input: { command: 'ls -la' }, result: 'ok' })]))
  assert.match(small.text, /```sh\nls -la\n```/)
  assert.equal(small.shortened, 0)
})

test('the answer line counts the lines and the shortened sections', () => {
  assert.equal(copiedLine({ lines: 1 }), 'Copied 1 line.')
  assert.equal(copiedLine({ lines: 42 }), 'Copied 42 lines.')
  assert.equal(copiedLine({ lines: 1204 }), 'Copied 1,204 lines.')
  assert.equal(copiedLine({ lines: 1204, shortened: 1 }), 'Copied 1,204 lines (1 section shortened).')
  assert.equal(copiedLine({ lines: 1204, shortened: 3 }), 'Copied 1,204 lines (3 sections shortened).')
  assert.equal(copiedLine({}), 'Copied 0 lines.')
})

// ---- the palette row ----

const palette = readFileSync(new URL('./CommandPalette.jsx', import.meta.url), 'utf8')

test('the palette offers the copy for the focused chat, and only while it has items', () => {
  assert.match(palette, /import \{ chatMarkdown, copiedLine \} from '\.\/chat-markdown\.js'/)
  assert.match(palette, /name: 'Copy this chat as Markdown'/)
  // The chat is the focused pane's, not the address's: a split can show one
  // chat in the primary view and another under the focus, and copying the
  // wrong transcript is the one way a copy can lie.
  assert.match(palette, /const markdownChat = focusedChatId \? chats\?\.\[focusedChatId\] \?\? null : null/)
  assert.match(palette, /const markdown = markdownChat && \(markdownChat\.timeline \?\? \[\]\)\.length > 0/)
  assert.doesNotMatch(palette, /const markdown = reviewChat/)
  assert.match(palette, /\.\.\.review, \.\.\.markdown,/)
})

test('copying writes the clipboard and answers with the module line, in the palette', () => {
  assert.match(palette, /if \(r\.markdown\) \{/)
  assert.match(palette, /navigator\.clipboard\?\.writeText\?\.\(file\.text\)/)
  assert.match(palette, /\.then\(\(\) => setCopied\(copiedLine\(file\)\)\)/)
  assert.match(palette, /className="kb-copied" role="status"/)
})

test('a clipboard that refuses is said in one sentence, never silently', () => {
  assert.match(palette, /Could not copy: this window has no clipboard\./)
  // A refused write goes through the console's one error rule, so a caught
  // message is never pasted in as if the app had said it.
  assert.match(palette, /\.catch\(\(err\) => setCopied\(errorCopy\(err\)\)\)/)
  // And a chat that turns out to have nothing to write says so rather than
  // copying an empty document.
  assert.match(palette, /Nothing to copy in this chat\./)
})
