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
 * for that mode and `projects` the known project list - or null for either
 * while that list has not answered yet. Null means unknown, not empty: an
 * unanswered list keeps the pick, because a machine the person chose has not
 * stopped existing just because the poll has not landed. An answered list that
 * does not carry it is a different fact, and drops it.
 */
export function keepSelection(current, next) {
  const kept = { projectId: null, target: null }
  const dropped = []
  if (current?.target) {
    const machines = next?.machines
    // Only Cloud offers a machine choice; Local runs the chat here, so a
    // target never survives the trip back whatever the list says.
    if (next?.mode === 'cloud' && (machines == null || machines.some((m) => m.id === current.target))) {
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
