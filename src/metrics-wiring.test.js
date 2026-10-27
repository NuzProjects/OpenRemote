// The 14-day strip and the presence band are bars with no numbers on them, so
// the caption under each is the only thing that says what a bar is and what the
// window means. The sentences themselves are pinned in metrics.js's own test;
// this reads the view to prove it draws them, and that the band's right edge is
// marked as now instead of being left to be guessed.

import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'

const view = readFileSync(new URL('./MetricsView.jsx', import.meta.url), 'utf8')

test('the strip draws its caption from the rule, not a bare window', () => {
  assert.ok(
    view.includes('newChatsLine(days, dayLabel)'),
    'the caption names the window and the busiest day in it',
  )
  assert.equal(
    view.includes('the last 14 days'),
    false,
    'a window with no numbers in its name is the thing this replaced',
  )
})

test('the band names its hours and marks now', () => {
  assert.ok(
    view.includes('presenceLine(presence)'),
    'the band says how many hours of the day it was online',
  )
  assert.ok(view.includes('className="mx-now"'), 'its right edge is marked as now')
  assert.ok(
    view.includes('className="mx-now-label"'),
    'and the caption under that edge names the mark',
  )
})
