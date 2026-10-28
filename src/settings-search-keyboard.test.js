// The search field's keyboard, pinned as source text.
//
// The field and the result rows must reach the same opener, and Escape must
// clear before it leaves the field. Both are behaviours the console suite has
// no renderer for, so what is compared here is the wiring: the field's Enter
// branch goes through `resultToOpen` and calls the very `openResult` the rows
// call, and the Escape branch clears (or blurs) without letting the window's
// own Escape layer close Settings underneath it.

import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'

const read = (name) => readFileSync(new URL(`./${name}`, import.meta.url), 'utf8')

// The field's own handler: from its ref to its placeholder, which is the whole
// input including the onKeyDown it installs.
function fieldBlock(view) {
  const start = view.indexOf('ref={searchRef}')
  const end = view.indexOf('placeholder="Search settings"', start)
  assert.ok(start >= 0 && end > start, 'the search field and its placeholder are in the view')
  return view.slice(start, end)
}

test('the field Enter opens a row through the same opener the rows use', () => {
  const view = read('SettingsView.jsx')
  const field = fieldBlock(view)
  assert.match(field, /if \(e\.key === 'Enter'\)/, 'Enter is handled in the field')
  assert.match(field, /resultToOpen\(shown\)/, 'and asks the one rule which row it means')
  assert.match(field, /openResult\(entry\)/, 'and opens it with the rows own opener')
  assert.match(view, /onClick=\{\(\) => openResult\(entry\)\}/, 'the rows call that same opener')
  // No second path: the old inline "the first one" would let a click and a
  // keystroke drift apart.
  assert.doesNotMatch(view, /openResult\(shown\[0\]\)/, 'the field does not pick its own row')
  // The rule lives in the search module, so the two callers share one answer.
  assert.match(view, /resultToOpen.*from '\.\/settings-search\.js'/)
})

test('Escape clears the query before it leaves the field, and never closes Settings', () => {
  const field = fieldBlock(read('SettingsView.jsx'))
  const esc = field.slice(
    field.indexOf("if (e.key === 'Escape')"),
    field.indexOf("if (e.key === 'ArrowDown'"),
  )
  assert.match(esc, /e\.stopPropagation\(\)/, 'the window Escape layer does not see it')
  assert.match(esc, /if \(query\) setQuery\(''\)/, 'a query is cleared first')
  assert.match(esc, /else e\.currentTarget\.blur\(\)/, 'and an empty field is left second')
  assert.ok(
    esc.indexOf("if (query) setQuery('')") < esc.indexOf('else e.currentTarget.blur()'),
    'the clear comes before the leave',
  )
})

test('the caret keeps the keys it needs', () => {
  const field = fieldBlock(read('SettingsView.jsx'))
  // Only Down, Enter and Escape are taken; Left/Right/Home/End are the field's.
  for (const key of ['ArrowLeft', 'ArrowRight', 'Home', 'End']) {
    assert.doesNotMatch(field, new RegExp(`e\\.key === '${key}'`), `${key} is not swallowed`)
  }
})
