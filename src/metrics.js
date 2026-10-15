// The Metrics view's arithmetic, kept pure so it's tested without a
// daemon: the session record counted by status, by harness, by day, and
// by where the synced chats run. Everything derives from the polled
// session list alone - the running totals a chat folds (cost, thinking
// tokens) exist only for chats this console has watched, so they stay
// out until the daemon can aggregate them itself.

const STATUSES = ['starting', 'working', 'waiting', 'idle', 'stopped', 'failed']

const STATUS_WORD = {
  starting: 'starting',
  working: 'running',
  waiting: 'waiting',
  idle: 'idle',
  stopped: 'stopped',
  failed: 'failed',
}

/** Every status's count, zero included, in the fixed order the sentence reads. */
export function statusCounts(sessions) {
  const counts = Object.fromEntries(STATUSES.map((s) => [s, 0]))
  for (const session of sessions ?? []) {
    if (counts[session.status] != null) counts[session.status] += 1
  }
  return counts
}

/** "2 running · 1 stopped" - the nonzero statuses only, '' when there is none. */
export function statusSentence(sessions) {
  const counts = statusCounts(sessions)
  return STATUSES.filter((s) => counts[s] > 0)
    .map((s) => `${counts[s]} ${STATUS_WORD[s]}`)
    .join(' · ')
}

/** Chats per harness, most used first; ties by name. Harnessless rows never count. */
export function harnessCounts(sessions) {
  const counts = new Map()
  for (const session of sessions ?? []) {
    if (!session.harness) continue
    counts.set(session.harness, (counts.get(session.harness) ?? 0) + 1)
  }
  return [...counts.entries()]
    .map(([harness, count]) => ({ harness, count }))
    .sort((a, b) => b.count - a.count || a.harness.localeCompare(b.harness))
}

function dayKey(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

/**
 * Local-day buckets, oldest first: `days` bands ending today, each the
 * chats created that day. The bands step through the calendar (not
 * 86400000ms hops) so a month rollover or a DST shift never misplaces a
 * day. Chats older than the window are ignored - the strip is a window.
 */
export function createdPerDay(sessions, days = 14, now = Date.now()) {
  const bands = []
  for (let back = days - 1; back >= 0; back -= 1) {
    const start = new Date(now)
    start.setHours(0, 0, 0, 0)
    start.setDate(start.getDate() - back)
    const end = new Date(start)
    end.setDate(end.getDate() + 1)
    bands.push({ key: dayKey(start), start: start.getTime(), end: end.getTime(), count: 0 })
  }
  for (const session of sessions ?? []) {
    const at = session.created_at
    if (!Number.isFinite(at)) continue
    const band = bands.find((d) => at >= d.start && at < d.end)
    if (band) band.count += 1
  }
  return bands
}

/**
 * Private / runs here / runs elsewhere - the synced split of the record.
 * A private chat never leaves this computer; a synced one runs on the
 * device its executor names.
 */
export function syncSplit(sessions, thisDevice) {
  const split = { private: 0, here: 0, elsewhere: 0 }
  for (const session of sessions ?? []) {
    if (!session.executor) split.private += 1
    else if (session.executor === thisDevice) split.here += 1
    else split.elsewhere += 1
  }
  return split
}

/**
 * This computer's 24-hour agent-presence band, straight from the daemon's
 * own machine view in the poll: 48 half-hour slices, oldest first. Null
 * until the poll answers - the section stays away, never a dead band.
 */
export function machinePresence(machines) {
  const mine = (machines ?? []).find((m) => m?.machine?.this_machine)
  return Array.isArray(mine?.presence) ? mine.presence : null
}
