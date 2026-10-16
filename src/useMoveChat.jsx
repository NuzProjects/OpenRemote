import { useCallback, useState } from 'react'
import { Check, Folders, FolderSimple, FolderSimpleDashed } from '@phosphor-icons/react'
import { useConsole } from './state/console.jsx'
import { chatAccess, deviceName } from './cloud.js'
import { projectFor } from './projects.js'
import { askBeforeMove, moveTargets } from './move-chat.js'
import MoveChatModal from './MoveChatModal.jsx'
import './move.css'

/**
 * Moving chats between projects, for any surface that offers it - the
 * sidebar (its drag and its menu), the chat's own menu, the pane menu, the
 * phone. A chat's projects are those of the machine that runs it: this
 * computer's are at hand, another machine's are asked for when a menu
 * opens (`prepare`). `menuItem` is the menus' row; `moveTo` is the drag's
 * way in. Every move asks first unless this device was told not to, and
 * the surface renders `modal` once.
 *
 * A chat here is { id, title, workspace, executor }.
 */
export function useMoveChat() {
  const { projects, apiFor, devices, thisDevice, cloud, moveChat } = useConsole()
  const [pending, setPending] = useState(null)
  // Another machine's projects, by device: { list } or { error }.
  const [remote, setRemote] = useState({})

  // Where the chat's projects live, and why they can't be reached when
  // they can't (the same reasons the chat's composer gives).
  const placeOf = (chat) => {
    const access = chatAccess(chat, devices, thisDevice, cloud)
    if (access === 'here') return { list: projects }
    const where = deviceName(devices, chat.executor)
    if (access === 'remote') {
      const known = remote[chat.executor]
      if (known?.list) return { list: known.list, device: where }
      return { note: known?.error ? `Couldn't reach ${where}` : 'Loading projects…', device: where }
    }
    return {
      note: {
        offline: `${where} is offline`,
        'not-machine': `${where} isn't a machine`,
        'signed-out': 'Sign in to Cloud first',
        gone: `${where} left your Cloud`,
      }[access],
      device: where,
    }
  }

  // Ask another machine for its projects as its chat's menu opens.
  const prepare = useCallback(
    (chat) => {
      if (chatAccess(chat, devices, thisDevice, cloud) !== 'remote') return
      const device = chat.executor
      apiFor(device)
        .projects()
        .then(
          (list) => setRemote((r) => ({ ...r, [device]: { list: list ?? [] } })),
          (err) => setRemote((r) => ({ ...r, [device]: { error: err.message ?? String(err) } })),
        )
    },
    [apiFor, devices, thisDevice, cloud],
  )

  // Asked first unless this device was told not to; a move made without
  // asking that fails opens the dialog to say why.
  const request = useCallback(
    (move) => {
      if (askBeforeMove()) {
        setPending({ move, failure: null })
        return
      }
      moveChat(move.chat.id, move.to?.id ?? null).catch((err) =>
        setPending({ move, failure: err.message ?? String(err) }),
      )
    },
    [moveChat],
  )

  // Move `chat` to `to` (a project of its machine, or null for none).
  const moveTo = (chat, to, place = placeOf(chat)) =>
    request({
      chat,
      to,
      from: projectFor(place.list, chat.workspace),
      device: place.device ?? null,
    })

  // The menus' "Move to project" row: "No project" and each project of
  // the chat's machine, the current one checked.
  const menuItem = (chat) => {
    const place = placeOf(chat)
    const submenu = place.list
      ? moveTargets(place.list, chat.workspace).map((target) => ({
          label: target.project ? <span className="pv">{target.name}</span> : target.name,
          icon: target.current ? (
            <Check size={14} />
          ) : target.project ? (
            <FolderSimple size={14} />
          ) : (
            <FolderSimpleDashed size={14} />
          ),
          disabled: target.current,
          onSelect: () => moveTo(chat, target.project, place),
        }))
      : [{ label: place.note, disabled: true }]
    return { label: 'Move to project', icon: <Folders size={14} />, submenu }
  }

  const closeModal = useCallback(() => setPending(null), [])
  const modal = pending && (
    <MoveChatModal move={pending.move} failure={pending.failure} onClose={closeModal} />
  )

  return { prepare, menuItem, moveTo, modal }
}
