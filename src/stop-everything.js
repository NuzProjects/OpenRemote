// Stop everything: the palette's one command that ends every running chat,
// for a person closing the laptop rather than visiting six chats.
//
// A running chat is one whose session says it is working or waiting: those
// are the two states where a harness process and a meter are both live. A
// chat that is still starting has not taken its first turn yet, and the
// plan's scope stops here.
//
// What this daemon can stop is what this daemon holds. A chat a synced
// account lists from another computer is named and skipped rather than
// failed: the stop action is one daemon's route, and inventing a mesh call
// for this pane would be a different feature with a different trust story.
//
// Pure rules only. CommandPalette does the asking and the calling, so the
// counting, the order, the cap and every sentence can be tested without a
// DOM.

export const RUNNING_STATUSES = ['working', 'waiting']
// A handful of names under the question; the rest is "and N more".
export const NAMED_CAP = 4

const WORDS = ['none', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine']

// Sentence-initial capital for the small numbers a person stops by hand.
function word(n) {
  return WORDS[n] ?? String(n)
}

/** Whether this session is doing work right now. */
export function isRunning(session) {
  return RUNNING_STATUSES.includes(session?.status)
}

/**
 * The sessions to stop, oldest first. Its input is the daemon's session rows,
 * never a console chat record (which carries `updatedAt` only): the palette
 * passes `sessions` straight from the poll. `created_at` is when the work
 * began - the session with the smallest one has been burning the longest,
 * which is the one a person closing the laptop most wants named. Ties (and
 * rows without timestamps) fall back to the last activity, then the title, so
 * the order is stable between two polls of the same list.
 */
export function orderForStop(sessions) {
  const at = (session, key) =>
    typeof session?.[key] === 'number' && Number.isFinite(session[key]) ? session[key] : null
  const rank = (chat) => {
    const created = at(chat, 'created_at')
    if (created != null) return created
    const updated = at(chat, 'updated_at')
    return updated != null ? updated : Number.MAX_SAFE_INTEGER
  }
  return [...(sessions ?? [])].sort((a, b) => {
    const byRank = rank(a) - rank(b)
    if (byRank !== 0) return byRank
    const byUpdated = (at(a, 'updated_at') ?? 0) - (at(b, 'updated_at') ?? 0)
    if (byUpdated !== 0) return byUpdated
    return String(a?.title ?? '').localeCompare(String(b?.title ?? ''))
  })
}

/**
 * Split the running chats into the ones this daemon can stop and the ones
 * it can only name. `device_id` is the device a synced chat runs on; null
 * means a private chat on this computer.
 */
export function stopTargets(sessions, { thisDevice = null } = {}) {
  const running = orderForStop((sessions ?? []).filter(isRunning))
  const stoppable = []
  const elsewhere = []
  for (const session of running) {
    if (session?.device_id && session.device_id !== thisDevice) elsewhere.push(session)
    else stoppable.push(session)
  }
  return { running, stoppable, elsewhere }
}

/** The question: a number is what makes someone read it. */
export function stopQuestion(count) {
  return count === 1 ? 'Stop 1 chat?' : `Stop ${count} chats?`
}

/** The row under the question: what those chats are, oldest first, capped. */
export function namedChats(chats, cap = NAMED_CAP) {
  const rows = (chats ?? []).slice(0, cap).map((chat) => ({
    id: chat.id,
    name: chat.title ?? 'A new task',
    harness: chat.harness ?? null,
  }))
  return { rows, more: Math.max(0, (chats ?? []).length - cap) }
}

/** Said while the stops are still landing; the outcome follows. */
export function stoppingLine(count) {
  return `Stopping ${count}.`
}

/**
 * What actually happened, in one sentence per kind of outcome. A skipped
 * chat is not a failure and is not hidden: it is named as the thing that
 * kept running, because that is the fact the person needs before closing
 * the laptop.
 */
export function stopSummary({ stopped = 0, elsewhere = 0, gone = 0, failed = 0 } = {}) {
  const parts = [stopped > 0 ? `Stopped ${stopped}.` : 'Nothing was stopped.']
  if (elsewhere === 1) parts.push('One is on another computer, so it kept running.')
  else if (elsewhere > 1) parts.push(`${word(elsewhere)} are on other computers, so they kept running.`)
  if (gone === 1) parts.push('One was already gone.')
  else if (gone > 1) parts.push(`${word(gone)} were already gone.`)
  if (failed === 1) parts.push('One did not answer.')
  else if (failed > 1) parts.push(`${word(failed)} did not answer.`)
  return parts.join(' ')
}

/** The palette row's right-hand sub line: how much work the command would end. */
export function runningLabel(count) {
  return count === 1 ? '1 running' : `${count} running`
}

/** One calm line for the question when some of the running chats are elsewhere. */
export function elsewhereAside(count) {
  if (count === 1) return 'One more is on another computer and will keep running.'
  if (count > 1) return `${word(count)} more are on other computers and will keep running.`
  return ''
}
