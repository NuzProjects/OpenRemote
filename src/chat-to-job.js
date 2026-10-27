// Turning a chat into a recurring job.
//
// A chat that produced a good daily review is a prompt worth repeating, and
// the rule editor can already build one: harness, model, the harness's own
// permission word, a project, and the task text. What a person cannot give
// it is the chat itself, so every field they already chose has to be
// retyped. This module reads those facts off the chat and hands the rule
// editor a draft.
//
// Two limits are deliberate and say so on screen:
//
//   * A schedule is the one thing only the person knows, so no time is
//     chosen here. The draft carries none, and the editor opens its time
//     field empty.
//   * The numbers and the words are what the chat reports, not what the
//     rule will do. The rule runs fresh, on the machine named in it, with
//     the harness's own defaults for anything this draft leaves out.
//
// The rule the daemon stores carries no effort (see the rule model: name,
// trigger, harness, model, permission_mode, workspace, machine, task), so a
// chat's effort tier has nowhere to go yet and is left out rather than
// quietly dropped.

import { pickable } from './harness-manager.js'
import { titleFrom } from './state/reducer.js'

// A chat's first message is its task. A pasted file is not a prompt, so the
// draft keeps the head of it: the editor shows the whole field, and the
// person can put back what matters before saving.
export const TASK_CAP = 2000

/// The chat's first task: its first non-empty user message, or ''.
export function firstTask(items) {
  for (const item of Array.isArray(items) ? items : []) {
    if (!item || item.kind !== 'message' || item.role !== 'user') continue
    const text = typeof item.text === 'string' ? item.text : ''
    if (text.trim()) return text
  }
  return ''
}

/// The one quiet line the rule editor shows above the fields it filled. It
/// names why the fields are already set and what is still the person's to
/// choose, so nobody has to guess why the form is not empty.
///
/// The editor asks for it again as the person works, so the sentence cannot
/// go stale: a time already picked takes its clause away, a webhook never
/// needed one, and a project chosen by hand stops being asked for.
export function jobSourceLine({ shortened = false, needsProject = false, when = 'schedule', timed = false } = {}) {
  const head = shortened
    ? 'Filled from this chat, with the first task shortened.'
    : 'Filled from this chat.'
  const asks = []
  if (when === 'schedule' && !timed) asks.push('pick when it should run')
  if (needsProject) asks.push('choose a project')
  if (asks.length === 0) return head
  const phrase = asks.length === 1 ? asks[0] : `${asks[0]}, and ${asks[1]}`
  return `${head} ${phrase[0].toUpperCase()}${phrase.slice(1)}.`
}

/// The fields a rule can carry that this chat can fill, in the order the
/// editor shows them. Kept as data so the report and the tests can name
/// them without re-reading the draft; the editor's own field name is on the
/// right of each pair, because a project is a workspace on the wire and a
/// permission word is `permission_mode`.
const FIELD_ORDER = [
  ['name', 'name'],
  ['harness', 'harness'],
  ['model', 'model'],
  ['permission', 'permission_mode'],
  ['project', 'workspace'],
  ['machine', 'machine'],
  ['task', 'task'],
]

/// Read a chat into a rule draft, or explain why it cannot be one.
///
/// `offer` is false when the editor would open on a hole rather than on a
/// field the person chooses:
///
///   * `'no-chat'` - nothing on screen to read.
///   * `'no-task'` - the chat has no first task yet (never sent, or its
///     transcript has not streamed into this window), so the rule would
///     have no prompt to run.
///   * `'harness'` - the chat's harness is not one the console can offer a
///     rule (not installed, or switched off in Plugins), so the editor's own
///     harness picker could not hold the value.
///   * `'machine'` - no machine is online, so a rule could never run.
///   * `'workspace'` - the chat ran in no folder and no project is
///     registered, so the required workspace has no honest value and none to
///     pick.
///
/// A chat with no folder but registered projects still offers the command:
/// the project is the person's to choose, and the editor asks for it.
export function planJob(chat, context = {}) {
  if (!chat) return rejected('no-chat')
  const task = firstTask(chat.timeline)
  if (!task) return rejected('no-task')

  const harnesses = Array.isArray(context.harnesses) ? context.harnesses : []
  const harnessRow = harnesses.find((h) => h && h.id === chat.harness) ?? null
  if (!harnessRow || !pickable(harnessRow)) return rejected('harness')

  const machines = Array.isArray(context.machines) ? context.machines : []
  const online = machines.filter((m) => m?.machine?.status === 'online')
  if (online.length === 0) return rejected('machine')

  const projects = Array.isArray(context.projects) ? context.projects : []
  const workspace = typeof chat.workspace === 'string' ? chat.workspace.trim() : ''
  if (!workspace && projects.length === 0) return rejected('workspace')

  // The rule runs where the chat ran: its own machine when that machine is
  // online, else this computer when it is a machine, else the editor's own
  // default (it preselects the first online machine).
  const onlineIds = new Set(online.map((m) => m.machine.id))
  const thisMachine = machines.find((m) => m?.machine?.this_machine)?.machine.id ?? null
  const machine = onlineIds.has(chat.executor)
    ? chat.executor
    : onlineIds.has(thisMachine)
      ? thisMachine
      : null

  // The permission word is the harness's own vocabulary and only means
  // something while the harness still offers it.
  const words = harnessRow.permission_modes ?? []
  const permission = words.includes(chat.permissionMode) ? chat.permissionMode : null

  const shortened = task.length > TASK_CAP
  const needsProject = !workspace && projects.length > 0
  const draft = {
    // The editor reads `fromChat` to know it is drafting from a chat: the
    // time field opens empty, and the source line sits above the fields.
    // `shortened` rides along so the line can keep saying so while the
    // person edits.
    fromChat: true,
    shortened,
    name: (chat.title ?? '').trim() || titleFrom(task),
    harness: chat.harness,
    model: chat.model || null,
    permission_mode: permission,
    workspace,
    machine,
    task: shortened ? task.slice(0, TASK_CAP).trimEnd() : task,
  }
  const always = new Set(['name', 'harness', 'task'])
  const filled = FIELD_ORDER.filter(([field, key]) => always.has(field) || Boolean(draft[key])).map(
    ([field]) => field,
  )
  // The line as the editor opens it: no time yet, and a project only when the
  // chat had no folder to bring. The editor rewrites it as the person picks.
  return {
    offer: true,
    reason: null,
    draft,
    filled,
    shortened,
    line: jobSourceLine({ shortened, needsProject }),
  }
}

function rejected(reason) {
  return { offer: false, reason, draft: null, filled: [], shortened: false, line: null }
}

// The editor lives in the Automations view, which the palette cannot reach
// by props (it gets none for the current view), so the request travels
// through here: the palette stages the draft and asks the shell for that
// view, and the view collects the draft when it mounts. A request made while
// the view is already open (it can sit in a split pane) is delivered to the
// subscriber instead.
//
// A staged draft does not wait forever. The palette stages it and asks for
// the view in the same press, so a request nobody collected inside this
// window means the switch never landed (a crash, a reload that lost the
// shell's state, a phone). Delivering that draft on a much later visit would
// open the editor on the values of a chat the person left long ago, which
// looks like the editor inventing a rule.
export const JOB_REQUEST_MS = 30_000

let pending = null // { draft, expires } while no listener is open
const listeners = new Set()

/** Stage a draft for the rule editor, or hand it to the open one. */
export function requestJob(draft, now = Date.now()) {
  if (!draft) return
  if (listeners.size === 0) {
    pending = { draft, expires: now + JOB_REQUEST_MS }
    return
  }
  for (const fn of listeners) fn(draft)
}

/** Collect a draft staged before the editor's view mounted; null if none.
 *  An expired request is dropped here, so it can never be delivered twice
 *  and never arrives stale. */
export function takeJobRequest(now = Date.now()) {
  const held = pending
  pending = null
  if (!held) return null
  return now < held.expires ? held.draft : null
}

/** Follow requests while the editor's view is open. Returns the undo. */
export function onJobRequest(fn) {
  listeners.add(fn)
  return () => listeners.delete(fn)
}
