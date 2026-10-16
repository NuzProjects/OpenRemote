import { useEffect, useRef, useState } from 'react'

// Machines change their projects without telling this one, so the lists
// are asked for again now and then while the sidebar is in use.
const REFRESH_MS = 30000
// A machine whose link is still coming up fails the first ask: try again
// a few times, backing off, before leaving it to the next refresh.
const RETRIES = 3
const RETRY_MS = 4000

/**
 * The registered projects of the account's other machines, for the sidebar
 * to group their chats under (Cloud, and the phone, which has no projects
 * of its own). A project lives on the machine that owns its folder, so each
 * list is asked of that machine the way New chat does - through this
 * daemon, `apiFor(machine).projects()` - and kept: a machine that goes
 * offline keeps its last list, so its chats stay under its projects.
 *
 * Asked when the set of online machines changes, when `rev` changes (a
 * project was added or removed from this console), and every half minute
 * while the window is showing. Returns { [deviceId]: [project] }.
 */
export function useMachineProjects({ enabled, devices, thisDevice, apiFor, connected, rev }) {
  const [lists, setLists] = useState({})
  const ask = useRef(apiFor)
  ask.current = apiFor

  // Only machines are asked: a desktop that is not one takes no requests,
  // and a phone runs nothing.
  const online = (devices ?? [])
    .filter((d) => d.kind === 'machine' && d.id !== thisDevice && d.online)
    .map((d) => d.id)
    .sort()
    .join(',')

  useEffect(() => {
    if (!enabled || !connected || !online) return undefined
    let stopped = false
    const timers = new Set()
    const load = (id, tried = 0) => {
      ask.current(id)
        .projects()
        .then(
          (list) => {
            if (stopped) return
            const next = list ?? []
            // The same answer keeps the same list, so nothing re-renders.
            setLists((current) =>
              JSON.stringify(current[id]) === JSON.stringify(next) ? current : { ...current, [id]: next },
            )
          },
          () => {
            if (stopped || tried >= RETRIES) return
            const timer = setTimeout(() => {
              timers.delete(timer)
              load(id, tried + 1)
            }, RETRY_MS * (tried + 1))
            timers.add(timer)
          },
        )
    }
    const loadAll = () => online.split(',').forEach((id) => load(id))
    loadAll()
    const refresh = setInterval(() => {
      if (!document.hidden) loadAll()
    }, REFRESH_MS)
    return () => {
      stopped = true
      clearInterval(refresh)
      timers.forEach(clearTimeout)
    }
  }, [enabled, connected, online, rev])

  return lists
}
