// The composer's plugin buttons: one for each composer input an enabled
// JavaScript plugin adds (a microphone for dictation, say), in the foot's
// right group beside the send button. A click goes to the plugin's hidden
// frame along with this composer's handle - the plugin may then write in
// this composer, and only in one the user clicked it in. The plugin sets
// the button's state: active (it breathes), busy, or at rest, with a
// short label beside it. With no such plugin nothing renders.

import { useEffect, useId, useRef } from 'react'
import { usePlugins } from './plugins-host.jsx'
import { PluginIcon } from './plugin-icons.jsx'
import { insertAt } from './plugin-runtime.js'

export default function PluginComposerButtons({ inputRef, setText, composer, disabled = false }) {
  const host = usePlugins()
  const handle = useId()
  // The plugin's text goes in at the cursor, or over the selection; the
  // cursor ends after it, in the field, ready for more typing.
  const insertRef = useRef(null)
  insertRef.current = (piece) => {
    const field = inputRef.current
    const start = field?.selectionStart
    const end = field?.selectionEnd
    let caret = null
    setText((current) => {
      const next = insertAt(current, start, end, piece)
      caret = next.caret
      return next.text
    })
    requestAnimationFrame(() => {
      if (!field || caret == null || field.disabled) return
      field.focus()
      field.setSelectionRange(caret, caret)
    })
  }
  const registerComposer = host?.registerComposer
  useEffect(() => {
    if (!registerComposer) return undefined
    return registerComposer(handle, { insert: (piece) => insertRef.current(piece), attachKey: composer })
  }, [registerComposer, handle, composer])

  if (!host || host.inputs.length === 0) return null
  return host.inputs.map(({ pluginId, pluginName, input }) => {
    const state = host.inputState(pluginId, input.id, handle)
    return (
      <button
        key={`${pluginId}/${input.id}`}
        type="button"
        className="plg-input"
        data-state={state.state}
        disabled={disabled}
        aria-pressed={state.state === 'active'}
        aria-label={state.label ? `${input.label}: ${state.label}` : input.label}
        title={state.title ?? `${input.label} (${pluginName})`}
        onClick={() => host.clickInput(pluginId, input.id, handle)}
      >
        <PluginIcon name={input.icon} size={16} />
        {state.label && <span className="plg-input-label">{state.label}</span>}
      </button>
    )
  })
}
