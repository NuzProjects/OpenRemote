// What the composer keeps across a mode switch. Local and Cloud offer
// different machines, and a project belongs to the machine that owns its
// folder, so a toggle can invalidate a pick. It must not cost one that is
// still valid: a glance at Cloud and back is the sequence this rule exists
// for.

/**
 * The selection after switching to `next`.
 *
 * `current` is `{ projectId, target }`; either may be null. `next` is
 * `{ mode, machines, projects }`, where `machines` is the picker's own list
 * for that mode and `projects` is the known project list, or null when the
 * list for the new target has not been read yet (an unknown list keeps the
 * pick, and the row resolves or falls back once it arrives).
 */
export function keepSelection(current, next) {
  const kept = { projectId: null, target: null }
  const dropped = []
  if (current?.target) {
    const machines = next?.machines ?? []
    if (next?.mode === 'cloud' && machines.some((m) => m.id === current.target)) {
      kept.target = current.target
    } else {
      dropped.push('machine')
    }
  }
  if (current?.projectId) {
    const projects = next?.projects
    if (projects == null || projects.some((p) => p.id === current.projectId)) {
      kept.projectId = current.projectId
    } else {
      dropped.push('project')
    }
  }
  return { kept, dropped }
}

const NOUN = { machine: 'machine', project: 'project' }

/** One line naming what the switch could not keep, or null when it kept all. */
export function keepLine(dropped) {
  const keys = (dropped ?? []).filter((key) => key in NOUN)
  if (keys.length === 0) return null
  const words = keys.map((key) => NOUN[key])
  const joined =
    words.length === 1 ? words[0] : `${words.slice(0, -1).join(', ')} and ${words[words.length - 1]}`
  return `The ${joined} did not come across the mode switch: pick again below.`
}
