import assert from 'node:assert/strict'
import test from 'node:test'
import { chatFromSession, chatStatus, foldEvent, mergeSessionIntoChat, railItems, titleFrom, vanishedChatIds, workspaceName } from './reducer.js'

const session = (over = {}) => ({
  id: 's1',
  harness: 'claude',
  workspace: 'C:\\dev\\webapp',
  status: 'idle',
  last_error: null,
  ...over,
})

const event = (seq, payload) => ({ seq, session_id: 's1', ...payload })

test('a session folds into a chat with workspace project and status', () => {
  const chat = chatFromSession(session({ status: 'working' }))
  assert.equal(chat.status, 'running')
  assert.equal(chat.project, 'webapp')
  assert.equal(chat.running, true)
  assert.equal(workspaceName('~/src/api/'), 'api')
  assert.equal(chatStatus('waiting'), 'waiting')
})

test('the timeline preserves event order: user, tools, decision, answer, agent', () => {
  let chat = chatFromSession(session())
  const events = [
    event(0, { type: 'session.created', session: session() }),
    event(1, { type: 'session.status_changed', status: 'working', reason: null }),
    event(2, {
      type: 'message.added',
      message: { id: 'm1', turn: 0, role: 'user', text: 'fix the failing test' },
    }),
    event(3, { type: 'tool.started', turn: 0, name: 'Bash', input: { command: 'npm test' } }),
    event(4, {
      type: 'decision.requested',
      decision: {
        id: 'd1',
        state: 'pending',
        kind: 'approval',
        harness_request: { tool_name: 'Bash', input: { command: 'npm test' } },
        options: [
          { id: 'allow', label: 'Allow' },
          { id: 'deny', label: 'Deny' },
        ],
      },
    }),
    event(5, { type: 'decision.responded', decision_id: 'd1', choice: 'allow' }),
    event(6, { type: 'tool.result', turn: 0, name: 'Bash', output: '2 passed', is_error: false }),
    event(7, {
      type: 'message.added',
      message: { id: 'm2', turn: 0, role: 'assistant', text: 'The race is fixed.' },
    }),
    event(8, { type: 'turn.completed', turn: 0, outcome: 'success', coarse: 'completed' }),
    event(9, { type: 'session.status_changed', status: 'idle', reason: null }),
  ]
  for (const e of events) chat = foldEvent(chat, e)

  const rail = railItems(chat)
  assert.equal(rail.length, 4)
  assert.equal(rail[0].kind, 'message')
  assert.equal(rail[0].role, 'user')
  assert.equal(rail[1].kind, 'tool')
  assert.equal(rail[1].name, 'Bash')
  assert.equal(rail[1].result, '2 passed')
  assert.equal(rail[2].kind, 'decision')
  assert.equal(rail[2].pending, false)
  assert.equal(rail[2].answeredChoice, 'allow')
  assert.equal(rail[3].kind, 'message')
  assert.equal(rail[3].role, 'agent')
  assert.equal(rail[3].text, 'The race is fixed.')
  assert.equal(chat.title, 'fix the failing test')
  assert.equal(chat.status, 'idle')
  assert.equal(chat.pendingDecisionId, null)
})

test('a pending decision marks the chat as waiting on the operator', () => {
  let chat = chatFromSession(session())
  chat = foldEvent(
    chat,
    event(4, {
      type: 'decision.requested',
      decision: {
        id: 'd2',
        state: 'pending',
        kind: 'approval',
        harness_request: { tool_name: 'Bash', input: { command: 'rm -rf' } },
        options: [
          { id: 'allow', label: 'Allow' },
          { id: 'deny', label: 'Deny' },
        ],
      },
    }),
  )
  const rail = railItems(chat)
  assert.equal(rail.at(-1).pending, true)
  assert.equal(rail.at(-1).toolName, 'Bash')
  assert.deepEqual(
    rail.at(-1).options.map((o) => o.id),
    ['allow', 'deny'],
  )
  assert.equal(chat.pendingDecisionId, 'd2')
})

test('a failed session keeps its reason and the title truncates', () => {
  let chat = chatFromSession(session())
  chat = foldEvent(chat, event(1, { type: 'session.status_changed', status: 'failed', reason: 'harness process exited' }))
  assert.equal(chat.status, 'failed')
  assert.equal(chat.running, false)
  assert.equal(chat.lastError, 'harness process exited')
  assert.equal(titleFrom('a'.repeat(60)).length, 45)
  assert.ok(titleFrom('a'.repeat(60)).endsWith('…'))
})

test('daemon errors land as notes in the transcript', () => {
  let chat = chatFromSession(session())
  chat = foldEvent(chat, event(7, { type: 'daemon.error', message: 'boom' }))
  const rail = railItems(chat)
  assert.equal(rail.at(-1).role, 'note')
  assert.equal(rail.at(-1).text, 'boom')
})

test('a session carries its fast mode and approved tools from the daemon', () => {
  const chat = chatFromSession(session({ fast: true, approved_tools: ['commandExecution'] }))
  assert.equal(chat.fast, true)
  assert.deepEqual(chat.approvedTools, ['commandExecution'])
  // old sessions (and harnesses without a fast mode) fold to the defaults
  const plain = chatFromSession(session())
  assert.equal(plain.fast, false)
  assert.deepEqual(plain.approvedTools, [])
})

test('session.updated folds the session-scoped grant into the chat', () => {
  let chat = chatFromSession(session())
  chat = foldEvent(
    chat,
    event(8, {
      type: 'session.updated',
      session: session({ status: 'waiting', fast: true, approved_tools: ['commandExecution'] }),
    }),
  )
  assert.equal(chat.fast, true)
  assert.deepEqual(chat.approvedTools, ['commandExecution'])
  assert.equal(chat.status, 'waiting')
  assert.equal(chat.running, true)
})

test('the permission word rides the session both ways', () => {
  // A session created with the harness's own word carries it from the
  // start; a stopped chat's settings change folds through session.updated.
  const chat = chatFromSession(session({ permission_mode: 'bypassPermissions' }))
  assert.equal(chat.permissionMode, 'bypassPermissions')
  let changed = chatFromSession(session())
  changed = foldEvent(
    changed,
    event(8, {
      type: 'session.updated',
      session: session({ status: 'stopped', permission_mode: 'plan' }),
    }),
  )
  assert.equal(changed.permissionMode, 'plan')
  // Old sessions and wordless harnesses fold to null - the chip never
  // renders a word the harness didn't say.
  assert.equal(chatFromSession(session()).permissionMode, null)
})

test('resumable follows the harness conversation: present, absent, arrived late', () => {
  // A chat that ran a turn has the harness's own conversation to resume.
  assert.equal(chatFromSession(session({ harness_session_ref: 'c-42' })).resumable, true)
  // One stopped before its first message never got one - nothing to
  // resume, ever, and the console must not offer it.
  assert.equal(chatFromSession(session()).resumable, false)
  // The ref rides the first turn's init; the session.updated that follows
  // turns a dead chat resumable without a reload.
  let chat = chatFromSession(session())
  chat = foldEvent(
    chat,
    event(9, { type: 'session.updated', session: session({ harness_session_ref: 'c-42' }) }),
  )
  assert.equal(chat.resumable, true)
})

test('the harness\'s own context numbers fold in, and compaction notes land in order', () => {
  let chat = chatFromSession(session())
  chat = foldEvent(chat, event(9, { type: 'context.used', used: 1250, window: 200000 }))
  assert.deepEqual(chat.context, { used: 1250, window: 200000 })
  // a harness that reports no window leaves it unset
  chat = foldEvent(chat, event(10, { type: 'context.used', used: 40 }))
  assert.deepEqual(chat.context, { used: 40, window: null })
  // the compaction marker becomes a transcript note, in event order
  chat = foldEvent(
    chat,
    event(11, { type: 'note.added', text: 'This session was compacted before this message.' }),
  )
  const rail = railItems(chat)
  assert.equal(rail.at(-1).role, 'note')
  assert.match(rail.at(-1).text, /compacted/)
})

test('a chat with embedded events carries its folded seq, and a replay never doubles the transcript', () => {
  // A session fetched with its events folds them once.
  const withEvents = session({
    events: [
      event(2, { type: 'message.added', message: { id: 'm1', turn: 1, role: 'user', text: 'do the thing' } }),
      event(3, { type: 'message.added', message: { id: 'm2', turn: 1, role: 'assistant', text: 'done' } }),
    ],
  })
  const chat = chatFromSession(withEvents)
  assert.equal(chat.foldedSeq, 3)
  assert.equal(railItems(chat).length, 2)

  // The fold itself advances the seq - any path that folds without the
  // console's guard still cannot double: a replayed seq never regresses.
  const folded = foldEvent(chat, event(3, { type: 'message.added', message: { id: 'm2', turn: 1, role: 'assistant', text: 'done' } }))
  assert.equal(folded.foldedSeq, 3, 'a replayed seq does not regress the fold cursor')

  // A fresh event past the seq folds in and advances it.
  const next = foldEvent(folded, event(4, { type: 'message.added', message: { id: 'm3', turn: 2, role: 'user', text: 'again' } }))
  assert.equal(next.timeline.length, 3)
  assert.equal(next.foldedSeq, 4)
})

test('stream deltas grow a live item, and the settled message replaces it whole', () => {
  const chat = chatFromSession(session())
  // Three fragments of the agent's reply, then the settled message.
  foldEvent(chat, event(2, { type: 'turn.started', turn: 1 }))
  foldEvent(chat, event(3, { type: 'message.delta', turn: 1, text: 'Let me ' }))
  foldEvent(chat, event(4, { type: 'message.delta', turn: 1, text: 'check ' }))
  foldEvent(chat, event(5, { type: 'message.delta', turn: 1, text: 'that file.' }))
  let rail = railItems(chat)
  assert.equal(rail.length, 1, 'one live stream item grows')
  assert.equal(rail[0].kind, 'stream')
  assert.equal(rail[0].text, 'Let me check that file.')

  // The settled assistant message replaces the stream - never both.
  foldEvent(chat, event(6, {
    type: 'message.added',
    message: { id: 'm2', turn: 1, role: 'assistant', text: 'Let me check that file.' },
  }))
  rail = railItems(chat)
  assert.equal(rail.length, 1, 'the settled message replaces the stream item')
  assert.equal(rail[0].kind, 'message')
  assert.equal(rail[0].text, 'Let me check that file.')

  // A second turn streams into its own item, the first stays settled.
  foldEvent(chat, event(7, { type: 'turn.started', turn: 2 }))
  foldEvent(chat, event(8, { type: 'message.delta', turn: 2, text: 'Done. ' }))
  rail = railItems(chat)
  assert.equal(rail.length, 2)
  assert.equal(rail.at(-1).kind, 'stream')
  assert.equal(rail.at(-1).text, 'Done. ')
})

test('reasoning streams and settles as its own block, thinking tokens sum', () => {
  const chat = chatFromSession(session())
  // The thinking stream grows its own live item.
  foldEvent(chat, event(2, { type: 'reasoning.delta', turn: 1, text: 'Let me ' }))
  foldEvent(chat, event(3, { type: 'reasoning.delta', turn: 1, text: 'compute.' }))
  let rail = railItems(chat)
  assert.equal(rail.length, 1)
  assert.equal(rail[0].kind, 'reasoning-stream')
  assert.equal(rail[0].text, 'Let me compute.')

  // The settled thinking block replaces the stream.
  foldEvent(chat, event(4, { type: 'reasoning.added', turn: 1, text: 'Let me compute.' }))
  rail = railItems(chat)
  assert.equal(rail.length, 1)
  assert.equal(rail[0].kind, 'reasoning')
  assert.equal(rail[0].text, 'Let me compute.')

  // The reply lands unmixed, after the reasoning.
  foldEvent(chat, event(5, {
    type: 'message.added',
    message: { id: 'm1', turn: 1, role: 'assistant', text: '391' },
  }))
  rail = railItems(chat)
  assert.equal(rail.length, 2)
  assert.equal(rail[0].kind, 'reasoning')
  assert.equal(rail[1].text, '391')

  // Thinking tokens sum across turns.
  foldEvent(chat, event(6, { type: 'thinking.tokens', tokens: 42 }))
  foldEvent(chat, event(7, { type: 'thinking.tokens', tokens: 8 }))
  assert.equal(chat.thinkingTokens, 50)
})

test('a poll merge preserves the folded transcript, its cursor, and the running totals', () => {
  let chat = chatFromSession(session({ status: 'working' }))
  foldEvent(chat, event(2, { type: 'message.added', message: { id: 'm1', turn: 1, role: 'user', text: 'do the thing' } }))
  foldEvent(chat, event(3, { type: 'usage.cost', cost_usd: 0.42 }))
  foldEvent(chat, event(4, { type: 'thinking.tokens', tokens: 1234 }))
  foldEvent(chat, event(5, { type: 'context.used', used: 1250, window: 200000 }))
  foldEvent(chat, event(6, {
    type: 'decision.requested',
    decision: { id: 'd9', state: 'pending', kind: 'approval', harness_request: { tool_name: 'Bash' }, options: [] },
  }))
  // The stream's decisions list is console-side, never folded - set it
  // the way the stream does before a beat lands.
  chat.decisionsList = [{ id: 'd9', state: 'pending' }]

  // The polled payload carries none of what the stream folded (the
  // session payload has no cost or thinking numbers), so the merge
  // must keep every folded fact or the next beat resets it.
  const merged = mergeSessionIntoChat(chat, session({ status: 'idle' }))
  assert.equal(merged.title, 'do the thing')
  assert.equal(merged.foldedSeq, 6, 'the fold cursor survives the beat')
  assert.equal(merged.timeline.length, 2, 'the transcript survives the beat')
  assert.deepEqual(merged.context, { used: 1250, window: 200000 })
  assert.equal(merged.costUsd, 0.42, 'the running cost survives the beat')
  assert.equal(merged.thinkingTokens, 1234, 'the thinking-token total survives the beat')
  assert.equal(merged.pendingDecisionId, 'd9')
  assert.deepEqual(merged.decisionsList, [{ id: 'd9', state: 'pending' }])
  // The identity facts still follow the polled session.
  assert.equal(merged.status, 'idle')
  assert.equal(merged.running, false)

  // Events folded after the merge add to the preserved totals.
  foldEvent(merged, event(7, { type: 'usage.cost', cost_usd: 0.08 }))
  assert.equal(merged.costUsd, 0.5)

  // A chat that never folded a total merges to zero, not undefined.
  const bare = mergeSessionIntoChat(chatFromSession(session()), session())
  assert.equal(bare.costUsd, 0)
  assert.equal(bare.thinkingTokens, 0)
})

test('vanished ids: only a chat a poll once carried and then lost counts as gone', () => {
  const chats = {
    s1: chatFromSession(session({ id: 's1' })),
    s2: chatFromSession(session({ id: 's2' })),
    // Fresh from the create response - the next poll beat has not listed
    // it yet. Its record is newer than the list; it is not gone.
    s3: chatFromSession(session({ id: 's3' })),
  }
  // Both s1 and s2 once appeared in a beat; this beat dropped s2 (a
  // delete from another device).
  const polled = new Set(['s1', 's2'])
  const beat = [session({ id: 's1' })]
  assert.deepEqual(vanishedChatIds(chats, beat, polled), ['s2'])
  // The next beat re-adds nothing: gone stays gone (the record was
  // pruned), and the fresh chat survives its first no-show because no
  // beat ever carried it. Once its id lands in a beat, a later drop
  // would count - the same synced-delete contract.
  assert.deepEqual(vanishedChatIds({ s1: chats.s1, s3: chats.s3 }, beat, polled), [])
  const beatWithFresh = [session({ id: 's1' }), session({ id: 's3' })]
  const polledAfter = new Set(['s1', 's2', 's3'])
  assert.deepEqual(vanishedChatIds({ s1: chats.s1, s3: chats.s3 }, beatWithFresh, polledAfter), [])
})

test('parallel same-name tools in one turn pair, out-of-order completion included', () => {
  let chat = chatFromSession(session())
  // Two Bash calls in one turn, started in order A then B.
  foldEvent(chat, event(2, { type: 'tool.started', turn: 1, name: 'Bash', input: { command: 'npm test' } }))
  foldEvent(chat, event(3, { type: 'tool.started', turn: 1, name: 'Bash', input: { command: 'ls -la' } }))
  // B completes first - out of order. The most recent unanswered Bash of
  // that turn is B, so B's result lands on B and A stays open.
  foldEvent(chat, event(4, { type: 'tool.result', turn: 1, name: 'Bash', output: 'B ran', is_error: false }))
  let rail = railItems(chat)
  assert.equal(rail[0].result, null, 'A is still unanswered')
  assert.equal(rail[1].result, 'B ran')
  // A completes last and lands on the only unanswered Bash of that turn.
  foldEvent(chat, event(5, { type: 'tool.result', turn: 1, name: 'Bash', output: 'A ran', is_error: false }))
  rail = railItems(chat)
  assert.equal(rail[0].result, 'A ran')
  assert.equal(rail[1].result, 'B ran')
})

test('a late result never completes another turn\'s same-name tool', () => {
  let chat = chatFromSession(session())
  // Turn 1 is interrupted mid-tool: its Bash never got its result before
  // turn 2 starts the same tool.
  foldEvent(chat, event(2, { type: 'tool.started', turn: 1, name: 'Bash', input: { command: 'npm test' } }))
  foldEvent(chat, event(3, { type: 'tool.started', turn: 2, name: 'Bash', input: { command: 'ls -la' } }))
  // Turn 1's result arrives after turn 2's call started. Name-only
  // pairing would fold it onto turn 2's tool; turn scoping keeps
  // every result on its own turn's call.
  foldEvent(chat, event(4, { type: 'tool.result', turn: 1, name: 'Bash', output: 'turn 1 output', is_error: false }))
  let rail = railItems(chat)
  assert.equal(rail[0].result, 'turn 1 output')
  assert.equal(rail[1].result, null, 'turn 2\'s tool is untouched')
  // Turn 2's own result then completes its own tool.
  foldEvent(chat, event(5, { type: 'tool.result', turn: 2, name: 'Bash', output: 'turn 2 output', is_error: false }))
  rail = railItems(chat)
  assert.equal(rail[0].result, 'turn 1 output')
  assert.equal(rail[1].result, 'turn 2 output')
})

test('a failed chat\'s reason clears when the session is healthy again', () => {
  let chat = chatFromSession(session())
  chat = foldEvent(chat, event(1, { type: 'session.status_changed', status: 'failed', reason: 'harness process exited' }))
  assert.equal(chat.lastError, 'harness process exited')
  // The resume is a non-failed status with no reason: the latch clears.
  chat = foldEvent(chat, event(2, { type: 'session.status_changed', status: 'working', reason: null }))
  assert.equal(chat.lastError, null)
  // A later failure with no reason of its own shows nothing - not the
  // day-old text of the failure before it.
  chat = foldEvent(chat, event(3, { type: 'session.status_changed', status: 'failed', reason: null }))
  assert.equal(chat.lastError, null)
  // A failure that carries its own reason still latches.
  chat = foldEvent(chat, event(4, { type: 'session.status_changed', status: 'failed', reason: 'exited again' }))
  assert.equal(chat.lastError, 'exited again')
})

test('session.updated clears the error latch the same way', () => {
  let chat = chatFromSession(session())
  chat = foldEvent(chat, event(1, { type: 'session.status_changed', status: 'failed', reason: 'harness process exited' }))
  // A settings update riding a healthy, error-less session clears the
  // stale reason instead of keeping it forever.
  chat = foldEvent(chat, event(2, { type: 'session.updated', session: session({ status: 'working' }) }))
  assert.equal(chat.lastError, null)
  // A failed session payload carries its error and latches it.
  chat = foldEvent(chat, event(3, { type: 'session.updated', session: session({ status: 'failed', last_error: 'exited' }) }))
  assert.equal(chat.lastError, 'exited')
})

test('non-finite cost and token payloads never poison the running totals', () => {
  let chat = chatFromSession(session())
  // A missing field, a string, NaN, Infinity - none of them fold;
  // 0 + undefined would render "$NaN" and survive every merge.
  foldEvent(chat, event(2, { type: 'usage.cost' }))
  foldEvent(chat, event(3, { type: 'usage.cost', cost_usd: 'free' }))
  foldEvent(chat, event(4, { type: 'usage.cost', cost_usd: NaN }))
  foldEvent(chat, event(5, { type: 'thinking.tokens' }))
  foldEvent(chat, event(6, { type: 'thinking.tokens', tokens: Infinity }))
  assert.equal(chat.costUsd, 0)
  assert.equal(chat.thinkingTokens, 0)
  // A real number after the malformed ones still folds.
  foldEvent(chat, event(7, { type: 'usage.cost', cost_usd: 0.42 }))
  foldEvent(chat, event(8, { type: 'thinking.tokens', tokens: 42 }))
  assert.equal(chat.costUsd, 0.42)
  assert.equal(chat.thinkingTokens, 42)
})

test('the queue folds from the session and from queue.changed, and an empty one is never held', () => {
  const chat = chatFromSession({
    id: 's1',
    harness: 'claude',
    status: 'working',
    queue: [{ id: 'q1', text: 'second', at: 1 }],
    queue_paused: false,
  })
  assert.deepEqual(chat.queue.map((m) => m.text), ['second'])
  assert.equal(chat.queuePaused, false)
  foldEvent(chat, {
    seq: 1,
    type: 'queue.changed',
    queue: [{ id: 'q1', text: 'second', at: 1 }],
    paused: true,
  })
  assert.equal(chat.queuePaused, true)
  foldEvent(chat, { seq: 2, type: 'queue.changed', queue: [], paused: true })
  assert.deepEqual(chat.queue, [])
  assert.equal(chat.queuePaused, false)
  // A session.updated never rewinds the queue.
  foldEvent(chat, { seq: 3, type: 'queue.changed', queue: [{ id: 'q2', text: 'third', at: 2 }], paused: false })
  foldEvent(chat, { seq: 4, type: 'session.updated', session: { id: 's1', harness: 'claude', status: 'working' } })
  assert.deepEqual(chat.queue.map((m) => m.text), ['third'])
})

test('a rename lands live, and a beat snapshotted before it never takes the name back', () => {
  let chat = chatFromSession(session({ status: 'working', updated_at: 1000 }))
  foldEvent(chat, event(2, { type: 'message.added', message: { id: 'm1', turn: 1, role: 'user', text: 'do the thing' } }))
  // A fresh chat is never anonymous: the console names it from the first
  // prompt before the daemon has written a title of its own.
  assert.equal(chat.title, 'do the thing')

  // /rename stores the title, and the daemon emits the whole session.
  foldEvent(chat, event(3, { type: 'session.updated', session: session({ status: 'working', title: 'Release triage', updated_at: 2000 }) }))
  assert.equal(chat.title, 'Release triage', 'the rename folds into the open chat')

  // The poll beat read the session before the rename wrote it, and its
  // answer lands after: the older snapshot must not take the name back.
  const stale = mergeSessionIntoChat(chat, session({ status: 'working', title: 'do the thing', updated_at: 1500 }))
  assert.equal(stale.title, 'Release triage', 'a beat taken before the rename keeps the new name')
  assert.equal(stale.updatedAt, 2000, 'the record keeps the newest session stamp it has seen')

  // The next beat is newer than the rename and agrees with it.
  const next = mergeSessionIntoChat(stale, session({ status: 'idle', title: 'Release triage', updated_at: 2400 }))
  assert.equal(next.title, 'Release triage')
  assert.equal(next.updatedAt, 2400)
})

test('a rename made on another device reaches a chat this console is not streaming', () => {
  // With no live stream the poll beat is the only witness, so the
  // payload's newer name has to land.
  const record = chatFromSession(session({ status: 'idle', title: 'do the thing', updated_at: 1000 }))
  const merged = mergeSessionIntoChat(record, session({ status: 'idle', title: 'Renamed elsewhere', updated_at: 5000 }))
  assert.equal(merged.title, 'Renamed elsewhere')
})

test('a beat that carries no title keeps the one derived from the first prompt', () => {
  // The daemon names a session from its first prompt too, but a session
  // created before that write reports none: the console's own name is all
  // there is, and a beat must not blank it.
  let chat = chatFromSession(session({ status: 'working', updated_at: 1000 }))
  foldEvent(chat, event(2, { type: 'message.added', message: { id: 'm1', turn: 1, role: 'user', text: 'do the thing' } }))
  const merged = mergeSessionIntoChat(chat, session({ status: 'working', updated_at: 1200 }))
  assert.equal(merged.title, 'do the thing')
})

test('a turn that ends without its settled message retires the live reply', () => {
  let chat = chatFromSession(session({ status: 'working' }))
  foldEvent(chat, event(2, { type: 'message.added', message: { id: 'm1', turn: 1, role: 'user', text: 'count them' } }))
  foldEvent(chat, event(3, { type: 'reasoning.delta', turn: 1, text: 'counting' }))
  foldEvent(chat, event(4, { type: 'message.delta', turn: 1, text: 'There are ' }))
  assert.equal(railItems(chat).at(-1).kind, 'stream')

  // Esc. The harness never sends the assistant message that would have
  // settled the stream, so the partial text is all there is - and a live
  // block would keep a caret breathing in an idle chat.
  foldEvent(chat, event(5, { type: 'turn.completed', turn: 1, outcome: 'interrupted', coarse: 'stopped' }))
  const rail = railItems(chat)
  assert.equal(rail.length, 3, 'the ending adds and drops nothing')
  assert.equal(rail[1].kind, 'reasoning')
  assert.equal(rail[1].text, 'counting')
  assert.equal(rail[2].kind, 'message')
  assert.equal(rail[2].role, 'agent')
  assert.equal(rail[2].text, 'There are ', 'the partial reply is kept, not deleted')
  assert.ok(!rail.some((item) => item.kind === 'stream' || item.kind === 'reasoning-stream'))
})

test('an interrupted turn settles only its own live items', () => {
  let chat = chatFromSession(session({ status: 'working' }))
  foldEvent(chat, event(2, { type: 'message.delta', turn: 1, text: 'first ' }))
  foldEvent(chat, event(3, { type: 'turn.completed', turn: 1, outcome: 'interrupted', coarse: 'stopped' }))
  foldEvent(chat, event(4, { type: 'message.delta', turn: 2, text: 'second ' }))
  assert.equal(railItems(chat).at(-1).kind, 'stream', 'the next turn still streams')
  foldEvent(chat, event(5, { type: 'turn.completed', turn: 2, outcome: 'failed', coarse: 'failed' }))
  const rail = railItems(chat)
  assert.equal(rail[0].kind, 'message')
  assert.equal(rail[1].kind, 'message')
  assert.equal(rail[1].text, 'second ')
})

test('a session that dies mid-reply retires the live reply with no turn event', () => {
  // A harness that exits mid-turn reports the failure as a status. There
  // is no turn.completed to name the turn, and the caret must still go.
  let chat = chatFromSession(session({ status: 'working' }))
  foldEvent(chat, event(2, { type: 'message.delta', turn: 1, text: 'Half a sen' }))
  foldEvent(chat, event(3, { type: 'session.status_changed', status: 'failed', reason: 'the harness exited' }))
  let rail = railItems(chat)
  assert.equal(rail[0].kind, 'message')
  assert.equal(rail[0].text, 'Half a sen')
  assert.equal(chat.lastError, 'the harness exited')

  // A stop ends it the same way.
  const stopped = chatFromSession(session({ status: 'working' }))
  foldEvent(stopped, event(2, { type: 'message.delta', turn: 1, text: 'Halfway' }))
  foldEvent(stopped, event(3, { type: 'session.status_changed', status: 'stopped', reason: null }))
  assert.equal(railItems(stopped)[0].kind, 'message')

  // A turn waiting on the user's answer is not over: its reply is still
  // being written, and its caret is the truth.
  const waiting = chatFromSession(session({ status: 'working' }))
  foldEvent(waiting, event(2, { type: 'message.delta', turn: 1, text: 'I need to ask' }))
  foldEvent(waiting, event(3, { type: 'session.status_changed', status: 'waiting', reason: null }))
  assert.equal(railItems(waiting)[0].kind, 'stream')
})
