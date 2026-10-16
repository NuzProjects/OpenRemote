import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { KEYS, endedTurn, loadList, pruned, saveList, toggled } from './sidebar-marks.js'

/**
 * A list of ids kept on this device: state that is read from storage once
 * and written back whenever it changes. The write waits for a change, so
 * opening the app never rewrites what is already there.
 */
export function usePersistedList(key) {
  const [list, setList] = useState(() => loadList(key))
  const first = useRef(true)
  useEffect(() => {
    if (first.current) {
      first.current = false
      return
    }
    saveList(key, list)
  }, [key, list])
  return [list, setList]
}

/**
 * "Done, not seen": the chats whose turn ended or failed while another
 * chat was on screen, until they are opened. The console already polls
 * every chat's status, so a turn that finished off screen is seen as a
 * status change here - no daemon support, and each device keeps its own
 * marks (a phone and a desktop do not clear each other's).
 *
 * - `statuses`: a Map of every chat's id to its status, as the sidebar
 *   shows it. The first look at a chat is a baseline, never news.
 * - `archived`: a Set of ids; an archived chat is put away on purpose, so
 *   a turn ending in it marks nothing.
 * - `active`: the chat on screen (the focused pane's). It is cleared when
 *   it becomes the active one - not for as long as it stays so, so
 *   "Mark as unread" on the open chat holds until the user comes back.
 * - `alive`: a Set of the ids that exist, or null until the list of chats
 *   has loaded; marks of deleted chats are dropped against it.
 */
export function useUnseen({ statuses, archived, active, alive }) {
  const [list, setList] = usePersistedList(KEYS.unseen)
  const before = useRef(new Map())
  const shown = useRef(active)
  shown.current = active

  useEffect(() => {
    const was = before.current
    before.current = statuses
    setList((current) => {
      let next = current
      for (const [id, status] of statuses) {
        if (id === shown.current || archived.has(id)) continue
        if (endedTurn(was.get(id), status)) next = toggled(next, id, true)
      }
      return next
    })
    // The poll and the open chat's stream both feed `statuses`; the rest
    // is read as it is when they change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [statuses])

  useEffect(() => {
    if (active) setList((current) => toggled(current, active, false))
  }, [active, setList])

  useEffect(() => {
    if (alive) setList((current) => pruned(current, alive))
  }, [alive, setList])

  const unseen = useMemo(() => new Set(list), [list])
  const mark = useCallback((id, on) => setList((current) => toggled(current, id, on)), [setList])
  return { unseen, mark }
}
