// Add an MCP server by hand (Settings > MCP servers). The
// command is what that machine would start; a key, if it needs one,
// stays there.

import { useRef, useState } from 'react'
import { X } from '@phosphor-icons/react'
import { useConsole } from './state/console.jsx'
import './devices.css'
import { useBack } from './use-back.js'
import { useDialog } from './dialog-focus.js'
import { checkMcpCommand } from './form-checks.js'

const STATUS = { online: 'Online', offline: 'Offline', waiting: 'Has not checked in' }

export default function AddMcpServerModal({ onClose }) {
  useBack(true, onClose)
  const panelRef = useRef(null)
  useDialog(panelRef, onClose)
  const { machines, mcpServers, addMcpServer } = useConsole()
  const online = (machines ?? []).find((m) => m.machine.status === 'online')
  const [name, setName] = useState('')
  const [detail, setDetail] = useState('')
  const [command, setCommand] = useState('')
  const [machineId, setMachineId] = useState(null)
  const [needsKey, setNeedsKey] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  // The modal can open before the machine list has arrived (the daemon
  // restarting, the first seconds after launch), so a mount-time pick
  // would stick null forever. While no machine was picked, the choice
  // follows the first online one - the Add button wakes when the list
  // does instead of staying dead for the modal's lifetime.
  const effectiveMachineId = machineId ?? online?.machine.id ?? null
  const machine = (machines ?? []).find((m) => m.machine.id === effectiveMachineId)?.machine ?? null
  const ready = name.trim() && detail.trim() && command.trim() && machine?.status === 'online'
  // The command's own shape, said under the field once the person has left it:
  // an empty field on a form nobody has typed in yet is not an error, but an
  // emptied one is, and a dead Add button with no reason is the habit this
  // replaces.
  const commandProblem = checkMcpCommand(command)
  const [commandTouched, setCommandTouched] = useState(false)
  const duplicate =
    ready &&
    (mcpServers ?? []).some(
      (p) => p.machine === effectiveMachineId && p.name.toLowerCase() === name.trim().toLowerCase(),
    )

  const oneMachine = (machines ?? []).filter((m) => m.machine.status === 'online').length <= 1
  const hint = duplicate
    ? `${name.trim()} is already on ${oneMachine ? 'this computer' : machine.name}.`
    : oneMachine
      ? 'The command is what this computer starts. A key, if it needs one, stays here.'
      : 'The command is what that machine would start. A key, if it needs one, stays there.'

  const add = async () => {
    if (!ready || duplicate || busy) return
    setBusy(true)
    setError(null)
    try {
      await addMcpServer(effectiveMachineId, {
        name: name.trim(),
        detail: detail.trim(),
        command: command.trim(),
        needsKey,
      })
      onClose()
    } catch (err) {
      setError(err.message ?? String(err))
      setBusy(false)
    }
  }

  return (
    <div
      className="dv-modal-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div className="dv-modal dv-modal--form" ref={panelRef} tabIndex={-1} role="dialog" aria-modal="true" aria-label="Add an MCP server">
        <div className="dv-modal-head">
          <h2 className="dv-modal-title">Add an MCP server</h2>
          <button className="dv-modal-close" onClick={onClose} title="Close">
            <X size={14} weight="bold" />
          </button>
        </div>
        <p className="dv-modal-hint">
          An MCP server you run yourself. Plugins can bring their own; this is for one that comes
          with none.
        </p>
        <label className="dv-host">
          Name
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Notes"
            spellCheck={false}
            autoComplete="off"
          />
        </label>
        <label className="dv-host">
          What it does
          <input
            value={detail}
            onChange={(e) => setDetail(e.target.value)}
            placeholder="Read the notes repo"
            spellCheck={false}
          />
        </label>
        <label className="dv-host">
          Command
          <input
            className="dv-command"
            value={command}
            onChange={(e) => setCommand(e.target.value)}
            onBlur={() => setCommandTouched(true)}
            placeholder="npx -y @scope/server"
            spellCheck={false}
            autoComplete="off"
            aria-invalid={commandTouched && commandProblem ? 'true' : undefined}
            aria-describedby={commandTouched && commandProblem ? 'mcp-command-problem' : undefined}
          />
        </label>
        {/* The Add button is disabled on an empty command; this is the reason,
            under the field, once the person has been in it. */}
        {commandTouched && commandProblem && (
          <p className="pn-note" id="mcp-command-problem" role="alert">
            {commandProblem}
          </p>
        )}
        {!oneMachine && (
          <div className="dv-host">
            Machine
            <div className="pn-pick">
              {(machines ?? []).map((m) => (
                <button
                  key={m.machine.id}
                  type="button"
                  disabled={m.machine.status !== 'online'}
                  className={m.machine.id === effectiveMachineId ? 'on' : ''}
                  onClick={() => setMachineId(m.machine.id)}
                >
                  <span className="pn-pick-name">{m.machine.name}</span>
                  <span>{STATUS[m.machine.status] ?? m.machine.status}</span>
                </button>
              ))}
            </div>
          </div>
        )}
        <button
          type="button"
          className={`dv-check${needsKey ? ' on' : ''}`}
          aria-pressed={needsKey}
          onClick={() => setNeedsKey((v) => !v)}
        >
          {oneMachine ? 'It needs a key' : 'It needs a key on that machine'}
        </button>
        <p className="dv-host-hint">{hint}</p>
        {error && <p className="pn-error">{error}</p>}
        <button
          type="button"
          className="dv-act dv-connect"
          disabled={!ready || duplicate || busy}
          onClick={add}
        >
          {busy ? 'Adding…' : 'Add MCP server'}
        </button>
      </div>
    </div>
  )
}
