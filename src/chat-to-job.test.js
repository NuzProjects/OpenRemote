// Turning a chat into a recurring job: what a chat can seed, which fields it
// can honestly fill, what the editor says about it, and when no command is
// offered at all. Every rule here is a promise the palette and the rule
// editor keep on screen, so each one has its own case.

import assert from 'node:assert/strict'
import test from 'node:test'
import {
  JOB_REQUEST_MS,
  TASK_CAP,
  firstTask,
  jobSourceLine,
  onJobRequest,
  planJob,
  requestJob,
  takeJobRequest,
} from './chat-to-job.js'

// The shapes the console holds: a chat record (state/reducer.js) and the
// capability, machine and project lists a rule can be built from.
const chatOf = (over = {}) => ({
  id: 's1',
  title: 'Morning review',
  harness: 'claude',
  model: 'claude-opus-4-5',
  permissionMode: 'plan',
  workspace: 'C:\\work\\api',
  executor: null,
  timeline: [{ kind: 'message', role: 'user', text: 'Review the open pull requests.' }],
  ...over,
})
const harnessOf = (over = {}) => ({
  id: 'claude',
  name: 'Claude Code',
  available: true,
  enabled: true,
  permission_modes: ['plan', 'acceptEdits', 'bypassPermissions'],
  ...over,
})
const machineOf = (id, over = {}) => ({ machine: { id, name: id, status: 'online', ...over } })
const context = (over = {}) => ({
  harnesses: [harnessOf()],
  machines: [machineOf('me', { this_machine: true })],
  projects: [{ id: 'p1', folders: ['C:\\work\\api'] }],
  ...over,
})

test('the first task is the chat first user message, and nothing else', () => {
  assert.equal(firstTask(chatOf().timeline), 'Review the open pull requests.')
  // Agent text, tool calls, notes and decisions are not the task.
  assert.equal(
    firstTask([
      { kind: 'reasoning', text: 'thinking' },
      { kind: 'tool', name: 'Read', input: {} },
      { kind: 'note', text: 'a note' },
      { kind: 'message', role: 'agent', text: 'Hello' },
      { kind: 'message', role: 'user', text: '  the real task  ' },
    ]),
    '  the real task  ',
  )
  // An empty user message is not a task either, and a chat with none is ''.
  assert.equal(firstTask([{ kind: 'message', role: 'user', text: '   ' }]), '')
  assert.equal(firstTask([]), '')
  assert.equal(firstTask(null), '')
})

test('a chat with a task and a usable harness seeds a full draft', () => {
  const plan = planJob(chatOf(), context())
  assert.equal(plan.offer, true)
  assert.equal(plan.reason, null)
  assert.deepEqual(plan.filled, ['name', 'harness', 'model', 'permission', 'project', 'machine', 'task'])
  assert.equal(plan.draft.name, 'Morning review')
  assert.equal(plan.draft.harness, 'claude')
  assert.equal(plan.draft.model, 'claude-opus-4-5')
  assert.equal(plan.draft.permission_mode, 'plan')
  assert.equal(plan.draft.workspace, 'C:\\work\\api')
  assert.equal(plan.draft.task, 'Review the open pull requests.')
  assert.equal(plan.draft.fromChat, true)
  assert.equal(plan.shortened, false)
})

test('no schedule is chosen for the person: the draft carries no trigger', () => {
  const plan = planJob(chatOf(), context())
  assert.equal('trigger' in plan.draft, false)
  assert.equal('time' in plan.draft, false)
  assert.match(plan.line, /Pick when it should run\.$/)
})

test('the command is not offered when the chat has no first task', () => {
  const plan = planJob(chatOf({ timeline: [] }), context())
  assert.deepEqual(plan, { offer: false, reason: 'no-task', draft: null, filled: [], shortened: false, line: null })
  // The same for a transcript that has not arrived: only agent text so far.
  assert.equal(planJob(chatOf({ timeline: [{ kind: 'message', role: 'agent', text: 'hi' }] }), context()).reason, 'no-task')
})

test('the command is not offered when no rule could name the chat harness', () => {
  // Missing from the capability list at all.
  assert.equal(planJob(chatOf(), context({ harnesses: [] })).reason, 'harness')
  // Installed but switched off in Plugins: a picker does not offer it.
  assert.equal(planJob(chatOf(), context({ harnesses: [harnessOf({ enabled: false })] })).reason, 'harness')
  // Not installed on this machine.
  assert.equal(planJob(chatOf(), context({ harnesses: [harnessOf({ available: false })] })).reason, 'harness')
})

test('the command is not offered when no machine is online', () => {
  assert.equal(planJob(chatOf(), context({ machines: [] })).reason, 'machine')
  assert.equal(
    planJob(chatOf(), context({ machines: [machineOf('me', { this_machine: true, status: 'offline' })] })).reason,
    'machine',
  )
})

test('the command is not offered when the workspace has no value and no project to pick', () => {
  const plan = planJob(chatOf({ workspace: null }), context({ projects: [] }))
  assert.equal(plan.reason, 'workspace')
  assert.equal(plan.offer, false)
})

test('a chat with no folder still offers, and asks the person for a project', () => {
  const plan = planJob(chatOf({ workspace: null }), context())
  assert.equal(plan.offer, true)
  assert.equal(plan.draft.workspace, '')
  assert.deepEqual(plan.filled, ['name', 'harness', 'model', 'permission', 'machine', 'task'], 'no project was filled')
  assert.match(plan.line, /choose a project\.$/)
})

test('the rule runs where the chat ran, when that machine is online', () => {
  const remote = planJob(chatOf({ executor: 'box' }), context({ machines: [machineOf('me', { this_machine: true }), machineOf('box')] }))
  assert.equal(remote.draft.machine, 'box')

  // Its machine is away: this computer takes it when it is a machine itself.
  const away = planJob(
    chatOf({ executor: 'box' }),
    context({ machines: [machineOf('me', { this_machine: true }), machineOf('box', { status: 'offline' })] }),
  )
  assert.equal(away.draft.machine, 'me')

  // A private chat with no executor and no machine here either: the editor's
  // own default applies, and the draft does not claim a machine.
  const none = planJob(chatOf(), context({ machines: [machineOf('box')] }))
  assert.equal(none.draft.machine, null)
  assert.deepEqual(none.filled, ['name', 'harness', 'model', 'permission', 'project', 'task'])
})

test('the permission word is carried only while the harness still offers it', () => {
  const kept = planJob(chatOf(), context())
  assert.equal(kept.draft.permission_mode, 'plan')

  const dropped = planJob(
    chatOf({ permissionMode: 'anOldWord' }),
    context({ harnesses: [harnessOf({ permission_modes: ['plan'] })] }),
  )
  assert.equal(dropped.draft.permission_mode, null)
  assert.equal(dropped.filled.includes('permission'), false)

  // A chat with no word at all: nothing to carry, nothing claimed.
  const unset = planJob(chatOf({ permissionMode: null }), context())
  assert.equal(unset.draft.permission_mode, null)
})

test('the name falls back to the first task when the chat is unnamed', () => {
  const plan = planJob(chatOf({ title: null }), context())
  assert.equal(plan.draft.name, 'Review the open pull requests.')
  // A very long first line is shortened by the console's own title rule.
  const long = planJob(
    chatOf({ title: '', timeline: [{ kind: 'message', role: 'user', text: 'a'.repeat(120) }] }),
    context(),
  )
  assert.equal(long.draft.name.length, 45, '44 characters and the ellipsis the console uses')
})

test('a pasted-file task is shortened, and the line says so', () => {
  const text = 'x'.repeat(TASK_CAP + 500)
  const plan = planJob(chatOf({ timeline: [{ kind: 'message', role: 'user', text }] }), context())
  assert.equal(plan.shortened, true)
  assert.equal(plan.draft.task.length, TASK_CAP)
  assert.match(plan.line, /^Filled from this chat, with the first task shortened\./)
  assert.match(plan.line, /Pick when it should run\.$/)
})

test('the line names what is still the person to choose, in every case it can be in', () => {
  // The editor opens on the first two; the rest are the same line as the
  // person works, so it can never go stale.
  assert.equal(jobSourceLine(), 'Filled from this chat. Pick when it should run.')
  assert.equal(
    jobSourceLine({ shortened: true }),
    'Filled from this chat, with the first task shortened. Pick when it should run.',
  )
  assert.equal(
    jobSourceLine({ needsProject: true }),
    'Filled from this chat. Pick when it should run, and choose a project.',
  )
  assert.equal(
    jobSourceLine({ shortened: true, needsProject: true }),
    'Filled from this chat, with the first task shortened. Pick when it should run, and choose a project.',
  )
  // A time picked: its clause goes.
  assert.equal(jobSourceLine({ timed: true }), 'Filled from this chat.')
  assert.equal(jobSourceLine({ timed: true, shortened: true }), 'Filled from this chat, with the first task shortened.')
  assert.equal(
    jobSourceLine({ timed: true, needsProject: true }),
    'Filled from this chat. Choose a project.',
  )
  // A webhook never needed a time, and still asks for the project.
  assert.equal(jobSourceLine({ when: 'webhook' }), 'Filled from this chat.')
  assert.equal(jobSourceLine({ when: 'webhook', needsProject: true }), 'Filled from this chat. Choose a project.')
  assert.equal(
    jobSourceLine({ when: 'webhook', needsProject: true, shortened: true }),
    'Filled from this chat, with the first task shortened. Choose a project.',
  )
})

test('nothing at all is offered without a chat', () => {
  for (const chat of [null, undefined]) {
    const plan = planJob(chat, context())
    assert.equal(plan.offer, false)
    assert.equal(plan.reason, 'no-chat')
  }
})

test('a request waits for the editor view when nothing is listening yet', () => {
  // The palette stages the draft before the shell has switched views.
  const draft = planJob(chatOf(), context()).draft
  requestJob(draft)
  assert.equal(takeJobRequest(), draft, 'collected when the view mounts')
  assert.equal(takeJobRequest(), null, 'and only once')
})

test('a request reaches an open editor, and a subscriber can stand down', () => {
  const seen = []
  const undo = onJobRequest((d) => seen.push(d))
  const draft = planJob(chatOf(), context()).draft
  requestJob(draft)
  assert.deepEqual(seen, [draft])
  assert.equal(takeJobRequest(), null, 'a delivered request is not also stashed')
  undo()
  const after = { ...draft, name: 'second' }
  requestJob(after)
  assert.deepEqual(seen, [draft], 'the unsubscribed listener hears nothing')
  assert.equal(takeJobRequest(), after, 'and the request waits instead')
})

test('a request the editor never collects expires instead of waiting forever', () => {
  // The palette stages the draft and asks the shell for the Automations view
  // in the same press. If that switch never lands (a crash, a reload that
  // lost the shell's state, a phone), the draft must not still be there on a
  // much later visit: the editor would open on the values of a chat the
  // person left long ago, which looks like the editor inventing a rule.
  const draft = planJob(chatOf(), context()).draft
  requestJob(draft, 1_000)
  assert.equal(takeJobRequest(1_000 + JOB_REQUEST_MS - 1), draft, 'inside its lifetime')
  requestJob(draft, 1_000)
  assert.equal(takeJobRequest(1_000 + JOB_REQUEST_MS), null, 'expired at the boundary')
  assert.equal(takeJobRequest(1_000), null, 'and it was dropped, not kept for later')
})
