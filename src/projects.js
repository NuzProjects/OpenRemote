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
 * The sidebar's two sections: registered projects (each with the chats
 * that ran in its folders), then the flat chats - every chat that
 * belongs to no project, in one list. A project with no chats keeps its
 * group: a project just added needs a row to press + on, and a row to
 * drop a chat onto.
 *
 * In Cloud a chat can run on another machine, and its folder is a path on
 * that machine - so it belongs to a project of that machine, not of this
 * computer. `remote` is { thisDevice, machines: [{ id, name, projects }] }:
 * the machines whose projects are known. Their projects follow this
 * computer's, each group carrying its machine; a chat on a machine not
 * listed (or off every one of its projects) stays in the flat list.
 *
 * Each group is { key, project, device, deviceName, items }: `key` is
 * unique across machines, `device` is null for this computer's own.
 */
export function sections(projects, rows, remote = null) {
  const local = (projects ?? []).map((project) => ({
    key: project.id,
    project,
    device: null,
    deviceName: null,
    items: [],
  }))
  const machines = (remote?.machines ?? []).map((machine) => ({
    id: machine.id,
    groups: (machine.projects ?? []).map((project) => ({
      key: `${machine.id}:${project.id}`,
      project,
      device: machine.id,
      deviceName: machine.name,
      items: [],
    })),
  }))
  const holds = (group, workspace) => (group.project.folders ?? []).includes(workspace)
  const flat = []
  for (const row of rows ?? []) {
    let group = null
    if (row.workspace) {
      // Without `remote` (Local) every chat runs here.
      const elsewhere = remote != null && Boolean(row.executor) && row.executor !== remote.thisDevice
      const pool = elsewhere ? (machines.find((m) => m.id === row.executor)?.groups ?? []) : local
      group = pool.find((g) => holds(g, row.workspace)) ?? null
    }
    if (group) group.items.push(row)
    else flat.push(row)
  }
  return { projects: [...local, ...machines.flatMap((m) => m.groups)], flat }
}
