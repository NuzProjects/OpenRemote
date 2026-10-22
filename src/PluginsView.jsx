// Plugins, in three tabs. Discover: every plugin the marketplaces offer.
// Installed: the six harnesses OpenRemote drives, built in, and the
// plugins the user installed - each with its runtime and the powers it
// was given. Marketplaces: where Discover's plugins come from. MCP servers
// set up by hand live in Settings, under MCP servers.

import { useState } from 'react'
import { useConsole } from './state/console.jsx'
import { HarnessMark } from './brand-marks.jsx'
import InstallPluginModal from './InstallPluginModal.jsx'
import PluginDiscover from './PluginDiscover.jsx'
import PluginIcon from './PluginIcon.jsx'
import PluginMarketplaces from './PluginMarketplaces.jsx'
import { POWER_SHORT, RUNTIME_LABEL, clashes, notSandboxed, sourceLabel } from './plugins.js'
import './devices.css'
import './panels.css'
import './plugins.css'

const TABS = [
  { id: 'discover', label: 'Discover' },
  { id: 'installed', label: 'Installed' },
  { id: 'marketplaces', label: 'Marketplaces' },
]

export default function PluginsView() {
  const [tab, setTab] = useState('discover')
  // What the Install dialog is open for: a Discover entry, or a direct
  // install (folder, git repo, archive).
  const [installing, setInstalling] = useState(null)

  return (
    <div className="panel pg-panel">
      <header className="dv-head pn-head pg-head">
        <div>
          <h1 className="dv-title">Plugins</h1>
          <p className="dv-meta">
            The harnesses OpenRemote drives, and what you add to it. Each one is on this computer.
          </p>
        </div>
        <button type="button" className="dv-act" onClick={() => setInstalling({ entry: null })}>
          Install from a file or link
        </button>
      </header>

      <div className="pg-tabs" role="tablist" aria-label="Plugins">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={tab === t.id}
            className={tab === t.id ? 'pg-tab on' : 'pg-tab'}
            onClick={() => setTab(t.id)}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === 'discover' && <PluginDiscover onInstall={(entry) => setInstalling({ entry })} />}
      {tab === 'installed' && <InstalledPlugins onUpdate={(entry) => setInstalling({ entry })} />}
      {tab === 'marketplaces' && <PluginMarketplaces />}

      {installing && <InstallPluginModal entry={installing.entry} onClose={() => setInstalling(null)} />}
    </div>
  )
}

function InstalledPlugins({ onUpdate }) {
  const { plugins, catalog, marketplaces, setPluginEnabled, removePlugin } = useConsole()
  const [confirmRemove, setConfirmRemove] = useState(null)
  const [error, setError] = useState(null)
  const builtin = plugins?.builtin ?? []
  const installed = plugins?.installed ?? []
  const entries = new Map((catalog?.entries ?? []).map((e) => [e.id, e]))
  const known = new Set((marketplaces ?? []).map((m) => m.name))
  const clashing = clashes(installed)

  const run = async (action) => {
    setError(null)
    try {
      await action()
    } catch (err) {
      setError(err.message ?? String(err))
    }
  }

  return (
    <div className="pg-installed-view">
      {clashing.map((c) => (
        <p key={c.name} className="pg-warn-block pg-clash">
          Two plugins named {c.name} are on: {c.ids.join(' and ')}. Their skills and commands share
          the name, so a Claude chat may mix them up. Turn one off to be sure.
        </p>
      ))}

      <h2 className="pn-section">Built in</h2>
      <p className="pn-lead">Off hides a harness from every picker. Its chats keep working.</p>
      <div className="pn-list pg-list-full pn-list--tight">
        {builtin.map((p) => (
          <div className="pn-row" key={p.id}>
            <div className="pg-main">
              <div className="pg-icon-tile">
                <HarnessMark harness={p.id} size={18} />
              </div>
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
        <p className="pn-empty">
          Nothing installed yet. Find plugins under Discover, or install one from a folder, a git repo
          or an archive.
        </p>
      )}
      <div className="pn-list pg-list-full">
        {installed.map((p) => {
          const entry = entries.get(p.id)
          const orphaned = p.marketplace !== 'local' && !known.has(p.marketplace)
          const author = p.author ?? entry?.author
          return (
            <div className="pn-row pn-row--stack" key={p.id}>
              <div className="pn-row-main">
                <div className="pg-main">
                  <PluginIcon
                    name={p.name}
                    id={p.id}
                    category={entry?.category}
                    size={36}
                  />
                  <div>
                    <div className="pn-name">
                      {p.name}
                      {p.version && <span className="pg-version">{p.version}</span>}
                      {author && <span className="pg-author-badge">by {author}</span>}
                      <span className="pg-badge-marketplace">@{p.marketplace}</span>
                    </div>
                    <div className="pn-detail">{p.description ?? RUNTIME_LABEL[p.runtime]}</div>
                  </div>
                </div>
                <div className="pn-actions">
                  {entry?.update && (
                    <button type="button" className="pn-btn pg-update" onClick={() => onUpdate(entry)}>
                      Update{entry.version ? ` to ${entry.version}` : ''}
                    </button>
                  )}
                  <button
                    type="button"
                    className={p.enabled ? 'pn-btn on' : 'pn-btn'}
                    onClick={() => run(() => setPluginEnabled(p.id, !p.enabled))}
                  >
                    {p.enabled ? 'On' : 'Off'}
                  </button>
                  {confirmRemove === p.id ? (
                    <button
                      type="button"
                      className="pn-btn pn-btn--danger"
                      onClick={() => {
                        setConfirmRemove(null)
                        run(() => removePlugin(p.id))
                      }}
                    >
                      Remove it
                    </button>
                  ) : (
                    <button type="button" className="pn-btn" onClick={() => setConfirmRemove(p.id)}>
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
              {orphaned && (
                <div className="pg-sub">Its marketplace was removed: it keeps working, with no more updates.</div>
              )}
            </div>
          )
        })}
      </div>
      <p className="pn-lead pg-mcp-note">MCP servers you set up by hand are in Settings, under MCP servers.</p>
      {error && <p className="pn-error">{error}</p>}
    </div>
  )
}
