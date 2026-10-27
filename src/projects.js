// Projects: the pure helpers every surface shares. A project is its
// folders - the name is the folder's basename, never stored, so the disk
// stays the only place it lives.

import { workspaceName } from './state/reducer.js'

/** A project's name: its first folder's basename. */
export function projectName(project) {
  const folder = project?.folders?.[0]
  return folder ? workspaceName(folder) : 'project'
}

/**
 * Group chats by project: a chat belongs to the project whose folders
 * contain its workspace. Chats with no workspace, or one no project
 * holds, belong to none - they render in the flat Chats section.
 */
export function projectFor(projects, workspace) {
  if (!workspace) return null
  return (projects ?? []).find((p) => (p.folders ?? []).includes(workspace)) ?? null
}

/**
 * The sidebar's sections: registered projects (each with the chats that ran
 * in its folders), then the flat chats - every chat that belongs to no
 * project, in one list.
 *
 * Every registered project comes back, including one with no chats: the first
 * thing a new user does is register a folder, and a project that is missing
 * from the list until a chat exists in it reads as an action the app dropped.
 * The caller draws the zero and says the project has no chats yet.
 */
/// Where each project's folders point, built once per `projects` change.
/// The sidebar groups on every beat, and a scan of every project per row made
/// that cost chats x projects x folders: the wrong way round for a list that
/// grows. First project wins, the same rule `projectFor` has.
export function projectIndex(projects) {
  const byFolder = new Map()
  for (const project of projects ?? []) {
    for (const folder of project.folders ?? []) {
      if (!byFolder.has(folder)) byFolder.set(folder, project)
    }
  }
  return byFolder
}

/// The projects that hold an unread chat, in one pass over `rows`. Counting
/// after grouping re-walked every group, which is the same quadratic in a
/// different place.
export function unreadProjects(rows, unread, index) {
  const hot = new Set()
  if (!unread || unread.size === 0) return hot
  for (const row of rows ?? []) {
    if (!unread.has(row.id)) continue
    const project = index?.get(row.workspace) ?? null
    if (project) hot.add(project.id)
  }
  return hot
}

export function sections(projects, rows, index = null) {
  const byProject = new Map((projects ?? []).map((p) => [p.id, { project: p, items: [] }]))
  const byFolder = index ?? projectIndex(projects)
  const flat = []
  for (const row of rows ?? []) {
    const project = byFolder.get(row.workspace) ?? null
    if (project && byProject.has(project.id)) byProject.get(project.id).items.push(row)
    else flat.push(row)
  }
  return {
    projects: [...byProject.values()],
    flat,
  }
}
