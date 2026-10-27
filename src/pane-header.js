// What a pane's header says.
//
// When the window is split, every header has to tell its pane from the others,
// so a pane holding a chat says the chat's title, its project when it has one,
// its harness mark and its status. A pane holding no chat keeps the role's name
// ("New chat", "Plugins"), which is what it said before.
//
// The title is the shell's own label for the pane (`paneLabel` in App), never a
// second one: this module reads the chat record for what the label cannot carry
// - the project, the harness, the live status - and leaves the words to the
// caller. The status is passed through as the console reports it, because the
// dot it becomes is the sidebar's own language (running, waiting, idle); a
// status with no dot style draws nothing, exactly as it does in the sidebar.

import { projectName } from './projects.js'

/**
 * The chat a pane's header is about, or null when the pane holds no chat.
 *
 * A leaf carries its own view, except the primary: the shell keeps the primary
 * pane's view in its own navigation rather than in the tree (the leaf's view is
 * null), so the primary is the one pane that has to be told which chat is on
 * screen. The shell passes the chat it is showing; a view that belongs to no
 * chat record falls back to the role name at the call site.
 */
export function paneChatId(view, currentChat = null) {
  if (view === null || view === undefined) return currentChat ?? null
  return view
}

/**
 * The word a pane header and a sidebar row share while a chat's stream is
 * between attempts. A word, not a dot: the dot still says the chat's status,
 * and the transport's retry is not a status the dot language should grow.
 */
export const RECONNECTING = 'reconnecting'

/**
 * One pane header's parts: the title, and for a chat pane the project, the
 * harness, the status and whether its stream is between attempts. `label` is
 * the shell's label for the pane, used as the title in every case; `chat` is
 * the chat record, or null for a pane that holds none; `project` is the
 * registered project the chat ran in, when one holds its folder;
 * `reconnecting` is the console's mirror of the stream's retry.
 */
export function paneHeader({ label = '', chat = null, project = null, reconnecting = false } = {}) {
  if (!chat) {
    return { chat: false, title: label, project: null, harness: null, status: null, reconnecting: false }
  }
  return {
    chat: true,
    title: label,
    project: project ? projectName(project) : null,
    harness: typeof chat.harness === 'string' && chat.harness ? chat.harness : null,
    // The sidebar's own fallback for a chat with no live status.
    status: chat.status ?? 'idle',
    reconnecting: reconnecting === true,
  }
}
