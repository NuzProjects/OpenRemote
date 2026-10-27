// Every view that shows a caught error builds its sentence with errorCopy, so
// a refusal is quoted as the daemon's words and a bare status code never
// reaches the screen.
//
// The subjects are discovered, not listed: the first version of this file kept
// a hand-written array of the views a commit had converted, and the very next
// commit (the Markdown copy) added a raw caught message to a view nobody had
// thought to add. A list like that is wrong the day it is written, so this
// scans every component for the shape instead, and keeps exactly one named
// exemption with the reason it exists.

import assert from 'node:assert/strict'
import test from 'node:test'
import { readdirSync, readFileSync } from 'node:fs'

const FILES = readdirSync(new URL('.', import.meta.url)).filter((file) => file.endsWith('.jsx'))
const source = (file) => readFileSync(new URL(`./${file}`, import.meta.url), 'utf8')

// The shape that means a caught error is being shown in its own words. It keys
// on the names a `catch` actually declares: a view that catches into `error` or
// `e` is the same defect with a different name, while a `error.message` that
// reads a prepared sentence off state is not a caught error at all and must not
// be flagged.
const caughtNames = (text) => {
  const names = new Set()
  for (const match of text.matchAll(/catch\s*\(\s*([A-Za-z_$][\w$]*)\s*\)/g)) names.add(match[1])
  return names
}

const rawShape = (name) => new RegExp(`(?:String\\(\\s*${name}\\s*\\)|\\b${name}\\s*\\??\\.\\s*message\\b)`)

// Source text carries comments and string literals that may name the shape
// without being it; a comment saying "do not use err.message here" is not a
// defect. Strip them before matching.
const stripNoise = (text) =>
  text
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/^[ \t]*\/\/.*$/gm, ' ')
    .replace(/(^|[^:\\])\/\/.*$/gm, '$1 ')
    .replace(/'(?:[^'\\\n]|\\.)*'/g, "''")
    .replace(/"(?:[^"\\\n]|\\.)*"/g, '""')
    .replace(/`(?:[^`\\]|\\.)*`/g, '``')

const rawIn = (file) => {
  const text = stripNoise(source(file))
  return [...caughtNames(text)].some((name) => rawShape(name).test(text))
}

// The transcript pane belongs to the founder and is not ours to change. It is
// named rather than the rule being narrowed, and the test below fails the day
// it is converted so the exemption cannot outlive its reason.
const NOT_OURS = new Set(['ChatView.jsx'])

test('no view shows a caught error in its own raw words', () => {
  const offenders = FILES.filter((file) => !NOT_OURS.has(file) && rawIn(file))
  assert.deepEqual(offenders, [], `views still showing a raw error: ${offenders.join(', ')}`)
})

test('the one exemption still has its reason', () => {
  assert.ok(rawIn('ChatView.jsx'), 'ChatView.jsx was converted: drop it from NOT_OURS')
})

test('the scan reads code, not prose about code', () => {
  // A comment or a string that mentions the shape is not the shape: without
  // this the suite fails on a sentence, which teaches people to edit comments.
  assert.equal(stripNoise('// never render err.message here').includes('err.message'), false)
  assert.equal(stripNoise("const note = 'call err.message'").includes('err.message'), false)
  assert.equal(stripNoise('const shown = error?.message').includes('error?.message'), true)
})

test('every view that calls the rule imports it, and the rule is the only place it lives', () => {
  const users = FILES.filter((file) => source(file).includes('errorCopy('))
  assert.ok(users.length > 10, 'the rule is in use')
  const missing = users.filter((file) => !source(file).includes("from './error-copy.js'"))
  assert.deepEqual(missing, [], `views using errorCopy without importing it: ${missing.join(', ')}`)
})
