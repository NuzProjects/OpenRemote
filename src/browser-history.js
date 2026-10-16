// History's small rules: visits grouped under the day they happened on
// (the user's own time zone), and the time ranges "Clear browsing data"
// offers. Pure: tested without a DOM.

const DAY = 24 * 60 * 60 * 1000

export function startOfDay(ms) {
  const d = new Date(ms)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

// "Today - Friday, October 16, 2026", "Yesterday - ...", else the date.
export function dayLabel(ms, now = Date.now()) {
  const date = new Date(ms).toLocaleDateString(undefined, {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  })
  const days = Math.round((startOfDay(now) - startOfDay(ms)) / DAY)
  if (days === 0) return `Today - ${date}`
  if (days === 1) return `Yesterday - ${date}`
  return date
}

export function timeLabel(ms) {
  return new Date(ms).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
}

// Visits, newest first, as days: [{ key, label, visits }].
export function groupByDay(visits, now = Date.now()) {
  const groups = []
  for (const visit of visits) {
    const key = startOfDay(visit.at)
    let group = groups[groups.length - 1]
    if (!group || group.key !== key) {
      group = { key, label: dayLabel(visit.at, now), visits: [] }
      groups.push(group)
    }
    group.visits.push(visit)
  }
  return groups
}

// Chrome's ranges for clearing history.
export const CLEAR_RANGES = [
  { id: 'hour', label: 'Last hour', ms: 60 * 60 * 1000 },
  { id: 'day', label: 'Last 24 hours', ms: DAY },
  { id: 'week', label: 'Last 7 days', ms: 7 * DAY },
  { id: 'month', label: 'Last 4 weeks', ms: 28 * DAY },
  { id: 'all', label: 'All time', ms: null },
]

// Where a range starts, or null for all of it.
export function sinceFor(range, now = Date.now()) {
  const found = CLEAR_RANGES.find((r) => r.id === range)
  return found?.ms ? now - found.ms : null
}
