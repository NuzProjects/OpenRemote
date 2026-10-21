// Settings > MCP servers: tools a session can call, set up by hand on a
// machine; a key never leaves it. (Plugins can ship MCP servers of their
// own - those live with their plugin, not here.)

import { useState } from 'react'
import AddMcpServerModal from './AddMcpServerModal.jsx'
import { useConsole } from './state/console.jsx'
import './devices.css'
import './panels.css'

// The state word the design rules: derived, never stored.
function serverState(p) {
  if (!p.enabled) return 'off'
  if (p.needs_key && !p.has_key) return 'needs-key'
  return 'running'
}

const STATE_LABEL = { running: 'Running', 'needs-key': 'Needs a key', off: 'Off' }

function machineName(machines, id) {
  return (machines ?? []).find((m) => m.machine.id === id)?.machine.name ?? id
}

export default function McpServersSection() {
  const {
    machines,
    mcpServers,
    removeMcpServer,
    setMcpServerEnabled,
    acknowledgeMcpServerKey,
  } = useConsole()
  const [adding, setAdding] = useState(false)
  const [error, setError] = useState(null)
  const installed = mcpServers ?? []
  // One machine is the honest local state - the plural, the hostname, and
  // the install picker return by themselves when remote machines check in.
  const oneMachine = (machines ?? []).length <= 1
  const machineWord = oneMachine ? 'machine' : 'machines'

  const run = async (action, ...args) => {
    setError(null)
    try {
      await action(...args)
    } catch (err) {
      setError(err.message ?? String(err))
    }
  }

  return (
    <>
      <p className="pn-lead">
        {oneMachine
          ? 'Tools a session can call, set up by hand. Each runs on this computer, and a key never leaves it.'
          : 'Tools a session can call, set up by hand. Each runs on a machine, and a key never leaves that machine.'}
      </p>
      {installed.length === 0 && (
        <p className="pn-empty">No MCP servers on your {machineWord} yet.</p>
      )}
      <div className="pn-list pn-list--wide">
        {installed.map((p) => {
          const state = serverState(p)
          const host = machineName(machines, p.machine)
          return (
            <div key={p.id} className="pn-row pn-row--stack" data-stg={`mcp-${p.id}`}>
              <div className="pn-row-main">
                <div>
                  <div className="pn-name">{p.name}</div>
                  <div className="pn-detail">
                    {p.detail}
                    {oneMachine ? '' : <> · <span className="pv">{host}</span></>}
                  </div>
                </div>
                <div className="pn-actions">
                  <span className={`pn-state pn-state--${state}`}>{STATE_LABEL[state]}</span>
                  {state === 'running' && (
                    <button type="button" className="pn-btn" onClick={() => run(() => setMcpServerEnabled(p.id, false))}>
                      Disable
                    </button>
                  )}
                  {state === 'needs-key' && (
                    <button type="button" className="pn-btn on" onClick={() => run(() => acknowledgeMcpServerKey(p.id))}>
                      Add key
                    </button>
                  )}
                  {state === 'off' && (
                    <button type="button" className="pn-btn" onClick={() => run(() => setMcpServerEnabled(p.id, true))}>
                      Enable
                    </button>
                  )}
                  {state === 'needs-key' && (
                    <button type="button" className="pn-btn" onClick={() => run(() => setMcpServerEnabled(p.id, false))}>
                      Disable
                    </button>
                  )}
                  <button type="button" className="pn-btn" onClick={() => run(() => removeMcpServer(p.id))}>
                    Remove
                  </button>
                </div>
              </div>
              <code className="pn-command pv">{p.command}</code>
              {state === 'needs-key' && (
                <p className="pn-note">
                  The key stays on {oneMachine ? 'this computer' : <span className="pv">{host}</span>}. Adding it here only records that {oneMachine ? 'it has' : 'the machine has'} one.
                </p>
              )}
            </div>
          )
        })}
      </div>
      <div className="pn-list pn-list--tight">
        <div className="pn-row" data-stg="mcp-add">
          <div>
            <div className="pn-name">Add an MCP server</div>
            <div className="pn-detail">Its launch command, as the machine would start it.</div>
          </div>
          <button type="button" className="pn-btn" onClick={() => setAdding(true)}>
            Add
          </button>
        </div>
      </div>
      {error && <p className="pn-error">{error}</p>}
      {adding && <AddMcpServerModal onClose={() => setAdding(false)} />}
    </>
  )
}
