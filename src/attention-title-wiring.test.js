// The document title is attention without a toast, and attention is only worth
// having if it is quiet: the rule is pure (needs-you.js's attentionTitle), and
// the sidebar must write it only when it changed, or the title earns a repaint
// on every poll beat. The two facts it names - waiting and unread - come from
// two different places, so this reads the sidebar to prove they meet.

import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'

const sidebar = readFileSync(new URL('./Sidebar.jsx', import.meta.url), 'utf8')

test('the title carries both facts: waiting from needs-you, unread from unread.js', () => {
  assert.match(
    sidebar,
    /attentionTitle\(baseTitle\.current, needs\.count, unread\.size, watched\)/,
    'one call, both counts',
  )
})

test('the title is written only when it changed', () => {
  assert.match(sidebar, /if \(document\.title !== next\)/, 'no write when nothing moved')
  assert.match(sidebar, /writtenTitle\.current = next/, 'and what was written is remembered')
})

test('the base is read at the decision, not cached at mount', () => {
  assert.match(
    sidebar,
    /document\.title !== writtenTitle\.current/,
    'another writer taking the title makes it the console\'s own title',
  )
})
