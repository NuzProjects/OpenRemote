// The palette's one way into the review surface. The palette gets no prop
// about the view, so these pin the two things that keep the row honest:
// which chat it reads (the address, the shell's own route) and that it is
// only offered when there is something to read.

import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'

const source = (file) => readFileSync(new URL(`./${file}`, import.meta.url), 'utf8')

test('the palette asks the review surface to open', () => {
  const palette = source('CommandPalette.jsx')
  assert.match(palette, /import \{ openChanges \} from '\.\/ChangesModal\.jsx'/)
  // The row's run reaches the opener after the palette has closed, beside
  // the other destinations, rather than navigating anywhere. It names the
  // chat, so a review opened for a pane cannot land on the wrong one.
  assert.match(palette, /else if \(r\.changes\) openChanges\(r\.changes\)/)
})

test('the row is offered for the chat the address names, and only with changes', () => {
  const palette = source('CommandPalette.jsx')
  // The address is the shell's route: App writes it on every navigation, and
  // it is the only signal the palette has about the chat on screen.
  assert.match(palette, /location\.hash\.replace\(\/\^#\/, ''\)/)
  assert.match(palette, /const reviewChat = chats\?\.\[onScreen\] \?\? null/)
  // A yes or no, not a fold: the palette recomputes on every stream beat.
  assert.match(palette, /import \{ hasFileChanges \} from '\.\/changes\.js'/)
  assert.match(palette, /hasFileChanges\(reviewChat\.timeline\)/)
  assert.doesNotMatch(palette, /fileChanges\(/)
  // The row's id is the chat it reviews, so a stale row cannot open another.
  assert.match(palette, /run: \{ changes: reviewChat\.id \}/)
})

test('the row reads as one action among the others, with its own mark', () => {
  const palette = source('CommandPalette.jsx')
  assert.match(palette, /name: 'Changes in this chat'/)
  assert.match(palette, /section: 'Actions'/)
  assert.match(palette, /<FileCode size=\{15\} \/>/)
  // It rides the empty query too: nothing else in the console reaches it yet.
  assert.match(palette, /'action:changes',/)
})

test('the palette keeps its other destinations intact', () => {
  // The new branch sits between actions and chats; the rest still resolve.
  const palette = source('CommandPalette.jsx')
  for (const branch of ['r.action', 'r.chat', 'r.project', 'r.machine']) {
    assert.match(palette, new RegExp(branch.replace('.', '\\.')), `${branch} still handled`)
  }
})

// ---- the palette's row identity ----

const palette = readFileSync(new URL('./CommandPalette.jsx', import.meta.url), 'utf8')

test('a token event does not rebuild the palette rows', () => {
  // The row list's dependencies no longer include the chat records, whose
  // every mutation used to rebuild two hundred rows.
  assert.match(palette, /\}, \[kb, sessions, archived, projects, devices, thisDevice, capabilities, machines, raceFree, moved, panes, savedLayouts, onScreen, reviewChat, markdownChat, hasFileChanges, focusedChatId, onRenameChat\]\)/)
  assert.doesNotMatch(palette, /\}, \[kb, sessions, chats,/)
  // The two timeline-reading rows are built apart and stabilised by their own
  // key, so an unchanged answer reuses the same row objects.
  assert.match(palette, /const chatActions = useMemo\(\(\) => \{/)
  assert.match(palette, /if \(chatActionsRef\.current\.key !== chatActions\.key\) chatActionsRef\.current = chatActions/)
})