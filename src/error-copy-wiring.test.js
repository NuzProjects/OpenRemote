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

// The shapes that mean a caught error is being shown in its own words.
const RAW = /String\(err\)|err\?\.message|err\.message/

// The transcript pane belongs to the founder and is not ours to change. It is
// named rather than the rule being narrowed, and the test below fails the day
// it is converted so the exemption cannot outlive its reason.
const NOT_OURS = new Set(['ChatView.jsx'])

test('no view shows a caught error in its own raw words', () => {
  const offenders = FILES.filter((file) => !NOT_OURS.has(file) && RAW.test(source(file)))
  assert.deepEqual(offenders, [], `views still showing a raw error: ${offenders.join(', ')}`)
})

test('the one exemption still has its reason', () => {
  assert.ok(RAW.test(source('ChatView.jsx')), 'ChatView.jsx was converted: drop it from NOT_OURS')
})

test('every view that calls the rule imports it, and the rule is the only place it lives', () => {
  const users = FILES.filter((file) => source(file).includes('errorCopy('))
  assert.ok(users.length > 10, 'the rule is in use')
  const missing = users.filter((file) => !source(file).includes("from './error-copy.js'"))
  assert.deepEqual(missing, [], `views using errorCopy without importing it: ${missing.join(', ')}`)
})
