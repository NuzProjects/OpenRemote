// Plugins: the six harnesses OpenRemote drives, built in, and the plugins
// the user installed - each with its runtime and the powers it was given.
// MCP servers set up by hand live in Settings, under MCP servers.

import { useState } from 'react'
import { useConsole } from './state/console.jsx'
import { HarnessMark } from './brand-marks.jsx'
import InstallPluginModal from './InstallPluginModal.jsx'
import { POWER_SHORT, RUNTIME_LABEL, notSandboxed, sourceLabel } from './plugins.js'
import './devices.css'
import './panels.css'
import './plugins.css'

export default function PluginsView() {
  const { plugins, setPluginEnabled, removePlugin } = useConsole()
  const [installing, setInstalling] = useState(false)
  const [confirmRemove, setConfirmRemove] = useState(null)
  const [error, setError] = useState(null)
  const builtin = plugins?.builtin ?? []
  const installed = plugins?.installed ?? []

  const run = async (action) => {
    setError(null)
    try {
      await action()
    } catch (err) {
      setError(err.message ?? String(err))
    }
  }

  return (
    <div className="panel">
      <header className="dv-head pn-head">
        <div>
          <h1 className="dv-title">Plugins</h1>
          <p className="dv-meta">
            The harnesses OpenRemote drives, and what you add to it. Each one is on this computer.
          </p>
        </div>
        <button type="button" className="dv-act" onClick={() => setInstalling(true)}>
          Install plugin
        </button>
      </header>

      <h2 className="pn-section">Built in</h2>
      <p className="pn-lead">Off hides a harness from every picker. Its chats keep working.</p>
      <div className="pn-list pn-list--tight">
        {builtin.map((p) => (
          <div className="pn-row" key={p.id}>
            <div className="pg-main">
              <HarnessMark harness={p.id} size={18} />
              <div>
                <div className="pn-name">{p.name}</div>
                <div className="pn-detail">
                  {p.available ? `Harness${p.version ? ` · ${p.version}` : ''}` : 'Harness · not installed on this computer'}
                </div>
              </div>
            </div>
            <button
              type="button"
              className={p.enabled ? 'pn-btn on' : 'pn-btn'}
              onClick={() => run(() => setPluginEnabled(p.id, !p.enabled))}
            >
              {p.enabled ? 'On' : 'Off'}
            </button>
          </div>
        ))}
      </div>

      <h2 className="pn-section">Installed</h2>
      {installed.length === 0 && (
        <p className="pn-empty">Nothing installed yet. A plugin comes from a folder, a git repo or an archive.</p>
      )}
      <div className="pn-list pn-list--wide">
        {installed.map((p) => (
          <div className="pn-row pn-row--stack" key={p.name}>
            <div className="pn-row-main">
              <div>
                <div className="pn-name">
                  {p.name}
                  {p.version && <span className="pg-version">{p.version}</span>}
                </div>
                <div className="pn-detail">{p.description ?? RUNTIME_LABEL[p.runtime]}</div>
              </div>
              <div className="pn-actions">
                <button
                  type="button"
                  className={p.enabled ? 'pn-btn on' : 'pn-btn'}
                  onClick={() => run(() => setPluginEnabled(p.name, !p.enabled))}
                >
                  {p.enabled ? 'On' : 'Off'}
                </button>
                {confirmRemove === p.name ? (
                  <button
                    type="button"
                    className="pn-btn pn-btn--danger"
                    onClick={() => {
                      setConfirmRemove(null)
                      run(() => removePlugin(p.name))
                    }}
                  >
                    Remove it
                  </button>
                ) : (
                  <button type="button" className="pn-btn" onClick={() => setConfirmRemove(p.name)}>
                    Remove
                  </button>
                )}
              </div>
            </div>
            <div className="pg-facts">
              <span className="pg-chip">{RUNTIME_LABEL[p.runtime] ?? p.runtime}</span>
              {(p.powers ?? []).map((w) => (
                <span key={w} className="pg-chip">
                  {POWER_SHORT[w] ?? w}
                </span>
              ))}
              {notSandboxed(p) && <span className="pg-chip pg-warn">Runs as you, not sandboxed</span>}
            </div>
            <div className="pg-source pv">{sourceLabel(p.source)}</div>
          </div>
        ))}
      </div>
      <p className="pn-lead pg-mcp-note">MCP servers you set up by hand are in Settings, under MCP servers.</p>
      {error && <p className="pn-error">{error}</p>}
      {installing && <InstallPluginModal onClose={() => setInstalling(false)} />}
    </div>
  )
}
