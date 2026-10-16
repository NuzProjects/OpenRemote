// Moving a chat between projects: the pure rules every surface shares -
// the sidebar's drag and its menu, the chat's own menu, the phone. A chat
// belongs to the project whose folder is its workspace, so a move changes
// that folder, and its agent works in the new one from its next message.

import { projectFor, projectName } from './projects.js'
import { loadPrefs, savePrefs } from './settings.js'

/** How far a pressed chat row travels before it is a drag, not a click. */
export const DRAG_DISTANCE = 10

/**
 * Where a chat can go: "No project" first, then the projects of the
 * machine that runs it. The one it is in now is marked current - a chat in
 * a folder no project holds is already in "No project".
 */
export function moveTargets(projects, workspace) {
  const here = projectFor(projects, workspace)
  return [
    { project: null, name: 'No project', current: !here },
    ...(projects ?? []).map((project) => ({
      project,
      name: projectName(project),
      current: here?.id === project.id,
    })),
  ]
}

/** Whether a drop on `project` (null: the Chats section) would move it. */
export function wouldMove(projects, workspace, project) {
  const here = projectFor(projects, workspace)
  return project ? here?.id !== project.id : here != null
}

/**
 * A running turn keeps a chat where it is. "Starting" doesn't: a harness
 * that names its conversation at the first message shows it until then,
 * and the daemon itself refuses the rare move that lands mid-spawn.
 */
export function busyReason(status) {
  if (status === 'running' || status === 'waiting') {
    return 'A turn is running in this chat. Wait for it to finish, or stop it, then move the chat.'
  }
  return null
}

/** Whether moves are asked first on this device. */
export function askBeforeMove() {
  return loadPrefs().ask_move_chat
}

/** The dialog's "Don't show this again", or Settings turning it back on. */
export function setAskBeforeMove(ask) {
  savePrefs({ ask_move_chat: Boolean(ask) })
}
