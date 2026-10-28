// The Metrics view's arithmetic, kept pure so it's tested without a
// daemon: the session record counted by status, by harness, by day, and
// by where the synced chats run. Everything derives from the polled
// session list alone - the running totals a chat folds (cost, thinking
// tokens) exist only for chats this console has watched, so they stay
// out until the daemon can aggregate them itself.

import { STATUSES, displayWord } from './status-words.js'

/** Every status's count, zero included, in the fixed order the sentence reads. */
export function statusCounts(sessions) {
  const counts = Object.fromEntries(STATUSES.map((s) => [s, 0]))
  for (const session of sessions ?? []) {
    // The poll's rows are the daemon's own words, which are the canonical
    // keys; a row with a status this console does not know is not counted.
    if (counts[session.status] != null) counts[session.status] += 1
  }
  return counts
}

/** "2 running · 1 stopped" - the nonzero statuses only, '' when there is none. */
export function statusSentence(sessions) {
  const counts = statusCounts(sessions)
  return STATUSES.filter((s) => counts[s] > 0)
    .map((s) => `${counts[s]} ${displayWord(s)}`)
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
 * The busiest day in the strip's window, the most recent one on a tie (the
 * nearer day is the one a person is thinking about), null when no day has a
 * chat.
 */
function busiestDay(days) {
  let best = null
  for (const day of days ?? []) {
    if (!(day?.count > 0)) continue
    if (!best || day.count >= best.count) best = day
  }
  return best
}

/**
 * "14 days to Oct 27, busiest 6 chats on Oct 24" - the strip's caption, which
 * names the window it draws and the peak inside it. `label` turns a band's
 * `start` into a date the way the view already prints one, so this stays a pure
 * sentence with no locale of its own.
 */
export function newChatsLine(days, label) {
  if (!Array.isArray(days) || days.length === 0) return ''
  const last = days[days.length - 1]
  const peak = busiestDay(days)
  const window = `${days.length} ${days.length === 1 ? 'day' : 'days'} to ${label(last.start)}`
  if (!peak) return window
  const chats = peak.count === 1 ? '1 chat' : `${peak.count} chats`
  return `${window}, busiest ${chats} on ${label(peak.start)}`
}

/**
 * "online 9.5 hours of the last 24" - the presence band's caption. The band is
 * 48 half-hour cells (the daemon's own view), so a count of cells is twice the
 * hours; the sentence says the cell size too, because a reader who is told the
 * span and the total will want to know what one cell is.
 */
export function presenceLine(presence) {
  if (!Array.isArray(presence) || presence.length === 0) return ''
  const hours = presence.filter(Boolean).length / 2
  const span = presence.length / 2
  const hoursText = Number.isInteger(hours) ? String(hours) : hours.toFixed(1)
  const spanText = Number.isInteger(span) ? String(span) : span.toFixed(1)
  return `online ${hoursText} ${hours === 1 ? 'hour' : 'hours'} of the last ${spanText}, each cell is half an hour`
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
