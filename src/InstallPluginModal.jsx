// Install a plugin: say where it is (a folder, a git repo, an archive) or
// pick it in Discover, read what it is - its runtime, the powers it asks
// for, whether it runs outside a sandbox - and only then approve. Nothing
// is installed until the Install button; closing before that leaves
// nothing behind. A plugin a marketplace makes with a command shows the
// command first: nothing runs until the user has seen it. A plugin written
// for another app's layout also says what the install rewrites for Claude
// Code and what it leaves out, so the review matches what will run.

import { useEffect, useRef, useState } from 'react'
import { X } from '@phosphor-icons/react'
import { useConsole } from './state/console.jsx'
import { canPickFolder, pickFile, pickFolder } from './pick-folder.js'
import { CLAUDE_PART_LABEL, POWER_LABEL, RUNTIME_LABEL, entrySource, sourceRequest } from './plugins.js'
import './devices.css'
import './plugins.css'

const KINDS = [
  { id: 'folder', label: 'Folder', placeholder: 'The plugin folder on this computer' },
  { id: 'git', label: 'Git repo', placeholder: 'https://github.com/owner/plugin' },
  { id: 'archive', label: 'Archive', placeholder: 'A .zip or .tar.gz - a file or a link' },
]

export default function InstallPluginModal({ onClose, entry = null }) {
  const { stagePlugin, installStagedPlugin, cancelStagedPlugin } = useConsole()
  const [kind, setKind] = useState('folder')
  const [value, setValue] = useState('')
  const [busy, setBusy] = useState(Boolean(entry))
  const [staged, setStaged] = useState(null)
  const [needsCommand, setNeedsCommand] = useState(null)
  const [error, setError] = useState(null)
  const stagedRef = useRef(null)
  stagedRef.current = staged

  // Closing before approval drops the staged copy: nothing is left behind.
  const close = () => {
    const pending = stagedRef.current
    if (pending) cancelStagedPlugin(pending.stage_id).catch(() => {})
    onClose()
  }

  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape') close()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const read = async (source) => {
    if (!source) return
    setBusy(true)
    setError(null)
    try {
      const reply = await stagePlugin(source)
      if (reply.result?.needs_command) {
        setNeedsCommand(reply.result.needs_command)
      } else {
        setNeedsCommand(null)
        setStaged(reply.result)
      }
    } catch (err) {
      setError(err.message ?? String(err))
    } finally {
      setBusy(false)
    }
  }

  // From Discover: read the entry straight away.
  useEffect(() => {
    if (entry) read(entrySource(entry))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const install = async () => {
    setBusy(true)
    setError(null)
    try {
      await installStagedPlugin(staged.stage_id)
      setStaged(null)
      onClose()
    } catch (err) {
      setError(err.message ?? String(err))
      setBusy(false)
    }
  }

  const browse = async () => {
    const path = kind === 'folder' ? await pickFolder('Choose the plugin folder') : await pickFile('Choose the plugin archive')
    if (path) setValue(path)
  }

  const manifest = staged?.manifest
  const name = entry?.display_name ?? entry?.name ?? manifest?.name
  const updating = staged?.replaces != null
  const newPowers = staged?.new_powers ?? []
  const fromMarketplace = staged && staged.marketplace !== 'local'
  const title = manifest
    ? `${updating ? 'Update' : 'Install'} ${manifest.name}?`
    : needsCommand
      ? 'Run this command?'
      : entry
        ? `Install ${name}`
        : 'Install a plugin'

  return (
    <div
      className="dv-modal-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) close()
      }}
    >
      <div className="dv-modal dv-modal--form" role="dialog" aria-modal="true" aria-label={title}>
        <div className="dv-modal-head">
          <h2 className="dv-modal-title">{title}</h2>
          <button className="dv-modal-close" onClick={close} title="Close">
            <X size={14} weight="bold" />
          </button>
        </div>

        {manifest ? (
          <>
            <p className="dv-modal-hint">
              {manifest.version ? `Version ${manifest.version}. ` : ''}
              {manifest.description ?? ''}
            </p>
            {updating && (
              <p className="pg-note">
                This replaces the installed {staged.id}
                {staged.replaces ? ` ${staged.replaces}` : ''}.
              </p>
            )}
            {newPowers.length > 0 && (
              <p className="pg-warn-block">
                This version asks for more than the one you have: {newPowers.map((w) => POWER_LABEL[w] ?? w).join(', ').toLowerCase()}.
              </p>
            )}
            <div className="pg-review">
              {fromMarketplace && (
                <div className="pg-review-row">
                  <span className="pg-review-label">From</span>
                  <span>{staged.marketplace}</span>
                </div>
              )}
              <div className="pg-review-row">
                <span className="pg-review-label">Runs as</span>
                <span>{RUNTIME_LABEL[manifest.runtime] ?? manifest.runtime}</span>
              </div>
              {manifest.claude_parts.length > 0 && (
                <div className="pg-review-row">
                  <span className="pg-review-label">Carries</span>
                  <span>{manifest.claude_parts.map((p) => CLAUDE_PART_LABEL[p] ?? p).join(', ')}</span>
                </div>
              )}
              <div className="pg-review-row">
                <span className="pg-review-label">It may</span>
                {manifest.powers.length ? (
                  <ul className="pg-powers">
                    {manifest.powers.map((w) => (
                      <li key={w}>
                        {POWER_LABEL[w] ?? w}
                        {newPowers.includes(w) && <span className="pg-new">new</span>}
                      </li>
                    ))}
                  </ul>
                ) : (
                  <span>Nothing beyond itself</span>
                )}
              </div>
              {manifest.adapted?.length > 0 && (
                <div className="pg-review-row">
                  <span className="pg-review-label">Adapted</span>
                  <span>
                    <span className="pg-review-lead">Written for another app&apos;s plugin layout.</span>
                    <ul className="pg-powers">
                      {manifest.adapted.map((note) => (
                        <li key={note}>{note}.</li>
                      ))}
                    </ul>
                  </span>
                </div>
              )}
              {manifest.left_out?.length > 0 && (
                <div className="pg-review-row">
                  <span className="pg-review-label">Left out</span>
                  <ul className="pg-powers">
                    {manifest.left_out.map((note) => (
                      <li key={note}>{note}.</li>
                    ))}
                  </ul>
                </div>
              )}
              {staged.command && (
                <div className="pg-review-row">
                  <span className="pg-review-label">Made by</span>
                  <span>
                    <code className="pg-command pv">{staged.command.command}</code>
                    <span className="pg-review-sub">Runs again each time a Claude chat starts.</span>
                  </span>
                </div>
              )}
            </div>
            {manifest.not_sandboxed && (
              <p className="pg-warn-block">
                Runs as you, not sandboxed. It runs programs with your account&apos;s rights, and no
                operating system lets OpenRemote fence that in. Install it only if you trust where
                it came from.
              </p>
            )}
            {error && <p className="pn-error">{error}</p>}
            <div className="pg-review-actions">
              <button type="button" className="pn-btn" onClick={close} disabled={busy}>
                Cancel
              </button>
              <button type="button" className="dv-act" onClick={install} disabled={busy}>
                {busy ? (updating ? 'Updating…' : 'Installing…') : updating ? 'Update' : 'Install'}
              </button>
            </div>
          </>
        ) : needsCommand ? (
          <>
            <p className="dv-modal-hint">
              {name} is made by running this command on this computer. It runs as you, not
              sandboxed, and once installed it runs again each time a Claude chat starts.
            </p>
            <code className="pg-command pg-command--block pv">{needsCommand.command}</code>
            {error && <p className="pn-error">{error}</p>}
            <div className="pg-review-actions">
              <button type="button" className="pn-btn" onClick={close} disabled={busy}>
                Cancel
              </button>
              <button
                type="button"
                className="dv-act"
                disabled={busy}
                onClick={() => read(entrySource(entry, needsCommand.command))}
              >
                {busy ? 'Running…' : 'Run it and read the plugin'}
              </button>
            </div>
          </>
        ) : entry ? (
          <>
            <p className="dv-modal-hint">
              {busy ? `Fetching ${name} to read what it asks for…` : 'Nothing is installed until you have seen what it asks for.'}
            </p>
            {error && <p className="pn-error">{error}</p>}
            {!busy && (
              <div className="pg-review-actions">
                <button type="button" className="pn-btn" onClick={close}>
                  Close
                </button>
                <button type="button" className="dv-act" onClick={() => read(entrySource(entry))}>
                  Try again
                </button>
              </div>
            )}
          </>
        ) : (
          <>
            <p className="dv-modal-hint">Nothing is installed until you have seen what it asks for.</p>
            <div className="pn-pick">
              {KINDS.map((k) => (
                <button
                  key={k.id}
                  type="button"
                  className={k.id === kind ? 'on' : ''}
                  onClick={() => {
                    setKind(k.id)
                    setError(null)
                  }}
                >
                  <span className="pn-pick-name">{k.label}</span>
                </button>
              ))}
            </div>
            <label className="dv-host">
              {KINDS.find((k) => k.id === kind).label}
              <span className="pg-source-row">
                <input
                  className="dv-command"
                  value={value}
                  onChange={(e) => setValue(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') read(sourceRequest(kind, value))
                  }}
                  placeholder={KINDS.find((k) => k.id === kind).placeholder}
                  spellCheck={false}
                  autoComplete="off"
                />
                {canPickFolder && kind !== 'git' && (
                  <button type="button" className="pn-btn" onClick={browse}>
                    Browse
                  </button>
                )}
              </span>
            </label>
            {error && <p className="pn-error">{error}</p>}
            <button
              type="button"
              className="dv-act dv-connect"
              disabled={!sourceRequest(kind, value) || busy}
              onClick={() => read(sourceRequest(kind, value))}
            >
              {busy ? 'Reading…' : 'Read the plugin'}
            </button>
          </>
        )}
      </div>
    </div>
  )
}
