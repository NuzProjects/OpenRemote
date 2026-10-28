// What setup a chat implies for the next one.
//
// A person who decides the next task belongs in the same place does not want to
// re-pick five things. "New chat with this setup" reads this module: from a
// chat or session record it answers the fields a New chat can be seeded with,
// and nothing else.
//
// The rule is deliberately conservative about a field the record does not
// carry, and about one this console cannot offer today. An unset field is the
// honest answer, because New chat's own picker then shows its usual choice and
// the person sees what they are about to get; a guessed default would silently
// start the task in a different place than the chat they copied, and they would
// find out from the result rather than the screen. For the same reason a chat
// whose harness is not installed seeds no harness, and no field of that
// harness's vocabulary either: a model or an effort word from an agent this
// console cannot start says nothing about the chat it will run.
//
// The folder travels as the project that holds it, because New chat picks a
// project rather than a raw path (NewChat.jsx derives its workspace from the
// chosen project). A folder no registered project holds is not seeded at all,
// and neither is one from a chat that ran on another computer: that folder is
// that machine's, and this one would not find it.

import { text } from './shape.js'

/// The setup one chat implies, for a New chat seeded from it.
///
/// - `harness`: the record's harness, only while this console can offer it
///   (`harnesses` is the list New chat's own picker shows);
/// - `model`: the record's model, verbatim;
/// - `effort`: the record's effort, only when there is a model, because an
///   effort tier is a property of the model it was chosen on;
/// - `permission`: the record's approval word, only when the harness still
///   lists it;
/// - `projectId`: the registered project whose folder is the chat's workspace,
///   when the chat ran on this computer.
///
/// Every field is optional: an absent key means "let New chat keep its own",
/// not "use a default". The caller passes what it knows and reads what came
/// back; nothing here fetches or validates anything about the chat beyond the
/// lists it is handed.
export function chatSetup(record, { harnesses = [], projects = [], thisDevice = null } = {}) {
  if (!record || typeof record !== 'object') return {}
  const setup = {}

  const harnessId = text(record.harness).trim()
  const row = harnessId
    ? (harnesses ?? []).find((h) => (typeof h === 'string' ? h : h?.id) === harnessId) ?? null
    : null
  if (row) {
    setup.harness = harnessId
    const model = text(record.model).trim()
    if (model) {
      setup.model = model
      const effort = text(record.effort).trim()
      if (effort) setup.effort = effort
    }
    // The chat's live record spells this one camelCase and the polled session
    // record snake_case; both are the same word, so both are read.
    const permission = text(record.permissionMode ?? record.permission_mode).trim()
    const words = (row.permission_modes ?? []).map((w) => (typeof w === 'string' ? w : w?.w ?? null))
    if (permission && words.includes(permission)) setup.permission = permission
  }

  // A synced chat can have run on another device (Cloud); its folder is not
  // this computer's to open. No executor means the chat lives here.
  const ranHere = !record.executor || !thisDevice || record.executor === thisDevice
  const workspace = text(record.workspace).trim()
  if (ranHere && workspace) {
    const project = (projects ?? []).find(
      (p) => Array.isArray(p?.folders) && p.folders.includes(workspace),
    )
    if (project?.id) setup.projectId = project.id
  }

  return setup
}

/// Whether a setup can seed a New chat at all: a harness the console offers is
/// the one field without which the rest is another agent's vocabulary. The
/// palette offers its row on this answer, so a row that would open on a
/// different harness than the chat is never shown.
export function canSeedChat(setup) {
  return Boolean(setup && setup.harness)
}
