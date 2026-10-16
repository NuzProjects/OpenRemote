import assert from 'node:assert/strict'
import test from 'node:test'
import {
  agentInsertion,
  applyPick,
  argItems,
  chatInsertion,
  commandItems,
  fileInsertion,
  mentionItems,
  mentionedChats,
  menuAt,
  ownCommands,
  takeCommands,
} from './composer-menus.js'

test('the / and @ menus open at the start of a word, anywhere in the message', () => {
  assert.deepEqual(menuAt('/com', 4), { kind: '/', query: 'com', start: 0, end: 4 })
  assert.deepEqual(menuAt('fix it /rev', 11), { kind: '/', query: 'rev', start: 7, end: 11 })
  assert.deepEqual(menuAt('look at @src/ap', 15), { kind: '@', query: 'src/ap', start: 8, end: 15 })
  // a path is not a command, an email is not a mention
  assert.equal(menuAt('src/app.js', 10), null)
  assert.equal(menuAt('/usr/bin', 8), null)
  assert.equal(menuAt('me@example.com', 14), null)
  // after an OpenRemote command that takes a choice, the choices open
  assert.deepEqual(menuAt('/model ', 7), { kind: 'arg', command: 'model', arg: 'model', query: '', start: 7, end: 7 })
  assert.deepEqual(menuAt('/effort hi', 10), {
    kind: 'arg',
    command: 'effort',
    arg: 'effort',
    query: 'hi',
    start: 8,
    end: 10,
  })
  // a free-text argument has no menu
  assert.equal(menuAt('/rename ', 8), null)
})

test('a pick replaces the word and leaves the caret after it', () => {
  const menu = menuAt('please /com now', 11)
  assert.deepEqual(applyPick('please /com now', menu, '/compact'), { text: 'please /compact now', caret: 15 })
  const at = menuAt('@not', 4)
  assert.deepEqual(applyPick('@not', at, '@notes:', { space: false }), { text: '@notes:', caret: 7 })
})

test('what each pick inserts', () => {
  assert.equal(fileInsertion('src/app.js'), '@src/app.js')
  assert.equal(fileInsertion('my notes/a.md'), '@"my notes/a.md"')
  assert.equal(agentInsertion('Explore', 'claude'), '@agent-Explore')
  assert.equal(agentInsertion('notes:scribe', 'claude'), '@agent-notes:scribe')
  assert.equal(agentInsertion('general', 'opencode'), '@general')
  assert.equal(
    chatInsertion({ id: '3f2a9c1e-0000-4000-8000-000000000000', title: 'Fix the "login" bug' }),
    '@chat "Fix the login bug" (3f2a9c1e)',
  )
})

test('a message names the chats it points at by their ids', () => {
  const chats = [{ id: '3f2a9c1e-aaaa' }, { id: '9b8c7d6e-bbbb' }]
  const text = 'compare @chat "One" (3f2a9c1e) with @chat "Two" (9b8c7d6e) and @chat "Gone" (00000000)'
  assert.deepEqual(mentionedChats(text, chats), ['3f2a9c1e-aaaa', '9b8c7d6e-bbbb'])
  // the console's own shape: chats keyed by id
  const keyed = Object.fromEntries(chats.map((c) => [c.id, c]))
  assert.deepEqual(mentionedChats(text, keyed), ['3f2a9c1e-aaaa', '9b8c7d6e-bbbb'])
})

test("OpenRemote's commands run at send and leave the rest of the message", () => {
  assert.deepEqual(takeCommands('/model opus fix the bug'), {
    run: [{ name: 'model', arg: 'opus' }],
    text: 'fix the bug',
  })
  assert.deepEqual(takeCommands('fix it /effort high and /sync'), {
    run: [
      { name: 'effort', arg: 'high' },
      { name: 'sync', arg: null },
    ],
    text: 'fix it and',
  })
  assert.deepEqual(takeCommands('/rename "Login work" then go'), {
    run: [{ name: 'rename', arg: 'Login work' }],
    text: 'then go',
  })
  // /fast takes on/off only when it is there
  assert.deepEqual(takeCommands('/fast fix the bug'), { run: [{ name: 'fast', arg: null }], text: 'fix the bug' })
  assert.deepEqual(takeCommands('/fast off'), { run: [{ name: 'fast', arg: 'off' }], text: '' })
  // the harness's own commands stay as typed
  assert.deepEqual(takeCommands('/compact please'), { run: [], text: '/compact please' })
})

test('the / menu hides harness names OpenRemote takes over and dims what cannot run', () => {
  const own = ownCommands({ inChat: true, cloud: false })
  assert.ok(!own.some((c) => c.name === 'sync'), 'no Cloud, no /sync')
  assert.ok(!ownCommands({ inChat: false, cloud: true }).some((c) => c.name === 'stop'))
  const items = commandItems('', {
    harnessCommands: [
      { name: 'compact', description: 'Compact', source: 'harness', available: true },
      { name: 'model', description: "claude's own", source: 'harness', available: true },
      { name: 'notes:jot', description: 'Jot', source: 'plugin', available: false, why: 'needs a harness that runs plugins' },
    ],
    own,
  })
  const labels = items.map((i) => i.label)
  assert.ok(labels.includes('/compact'), 'an everyday command shows before typing')
  assert.equal(items.filter((i) => i.label === '/model').length, 1)
  assert.equal(items.find((i) => i.label === '/model').group, 'OpenRemote')
  assert.ok(!labels.includes('/notes:jot'), 'skills wait for a search')
  assert.ok(items.at(-1).note, 'and the menu says how much a search finds')
  const jot = commandItems('jot', {
    harnessCommands: [{ name: 'notes:jot', description: 'Jot', source: 'plugin', available: false, why: 'x' }],
  }).find((i) => i.label === '/notes:jot')
  assert.equal(jot.group, 'Skills')
  assert.equal(jot.disabled, true)
  assert.equal(jot.badge, 'plugin')
  // a query ranks names that start with it first
  assert.equal(commandItems('com', { harnessCommands: [{ name: 'compact' }, { name: 'recompile' }] })[0].label, '/compact')
})

test('the / menu leaves out what the harness keeps for itself and keeps rows short', () => {
  const harnessCommands = [
    { name: '__remote-workflow', description: 'Internal' },
    { name: 'agents', description: '(removed) Ask Claude to manage subagents' },
    { name: 'advisor', description: 'Let Claude consult a stronger model at key moments. More text here.', argument_hint: '[fable|opus|sonnet|off]' },
    { name: 'auto-mode-setup', description: 'Set up', argument_hint: '[--request-id <uuid>] (--wizard posture=...)' },
    { name: 'deep-research', description: 'Use this skill when the prompt needs research' },
  ]
  const labels = commandItems('a', { harnessCommands }).map((i) => i.label)
  assert.ok(!labels.includes('/__remote-workflow'))
  assert.ok(!labels.includes('/agents'))
  const advisor = commandItems('advisor', { harnessCommands })[0]
  assert.equal(advisor.detail, 'Let Claude consult a stronger model at key moments.')
  assert.equal(advisor.hint, '[fable|opus|sonnet|off]', 'a short hint stays')
  assert.equal(commandItems('auto', { harnessCommands })[0].hint, '', 'a usage line goes')
  assert.equal(commandItems('deep', { harnessCommands })[0].group, 'Skills')
})

test('the @ menu groups files, agents, servers and chats', () => {
  const items = mentionItems('no', {
    files: [{ path: 'notes.md', kind: 'file' }, { path: 'src', kind: 'dir' }],
    agents: [{ name: 'notes:scribe', source: 'plugin', available: true }],
    servers: [{ name: 'notes-db', source: 'plugin', plugin: 'notes@local' }],
    chats: [{ id: 'abc12345-x', title: 'Notes cleanup', harness: 'claude' }],
    harness: 'claude',
  })
  assert.deepEqual(
    items.map((i) => i.group),
    ['Files', 'Files', 'Agents', 'MCP servers', 'Chats'],
  )
  assert.equal(items[1].label, 'src/')
  assert.equal(items[2].insertion, '@agent-notes:scribe')
  assert.equal(items[3].insertion, '@notes-db:')
  assert.equal(items[3].space, false)
  assert.equal(argItems('op', [{ id: 'opus', name: 'Opus' }, { id: 'haiku' }]).map((i) => i.insertion)[0], 'opus')
})
