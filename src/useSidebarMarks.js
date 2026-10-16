import { useEffect, useRef, useState } from 'react'
import { loadList, saveList } from './sidebar-marks.js'

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
