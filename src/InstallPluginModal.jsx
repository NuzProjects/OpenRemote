// Install a plugin: say where it is (a folder, a git repo, an archive),
// read what it is - its runtime, the powers it asks for, whether it runs
// outside a sandbox - and only then approve. Nothing is installed until
// the Install button; closing before that leaves nothing behind.

import { useEffect, useRef, useState } from 'react'
import { X } from '@phosphor-icons/react'
import { useConsole } from './state/console.jsx'
import { canPickFolder, pickFile, pickFolder } from './pick-folder.js'
import { CLAUDE_PART_LABEL, POWER_LABEL, RUNTIME_LABEL, sourceRequest } from './plugins.js'
import './devices.css'
import './plugins.css'

const KINDS = [
  { id: 'folder', label: 'Folder', placeholder: 'The plugin folder on this computer' },
  { id: 'git', label: 'Git repo', placeholder: 'https://github.com/owner/plugin' },
  { id: 'archive', label: 'Archive', placeholder: 'A .zip or .tar.gz - a file or a link' },
]

export default function InstallPluginModal({ onClose }) {
  const { stagePlugin, installStagedPlugin, cancelStagedPlugin } = useConsole()
  const [kind, setKind] = useState('folder')
  const [value, setValue] = useState('')
  const [busy, setBusy] = useState(false)
  const [staged, setStaged] = useState(null)
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

  const read = async () => {
    const source = sourceRequest(kind, value)
    if (!source) return
    setBusy(true)
    setError(null)
    try {
      const reply = await stagePlugin(source)
      setStaged(reply.result)
    } catch (err) {
      setError(err.message ?? String(err))
    } finally {
      setBusy(false)
    }
  }

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

  return (
    <div
      className="dv-modal-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) close()
      }}
    >
      <div className="dv-modal dv-modal--form" role="dialog" aria-modal="true" aria-label="Install a plugin">
        <div className="dv-modal-head">
          <h2 className="dv-modal-title">{manifest ? `Install ${manifest.name}?` : 'Install a plugin'}</h2>
          <button className="dv-modal-close" onClick={close} title="Close">
            <X size={14} weight="bold" />
          </button>
        </div>

        {!manifest ? (
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
                    if (e.key === 'Enter') read()
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
              onClick={read}
            >
              {busy ? 'Reading…' : 'Read the plugin'}
            </button>
          </>
        ) : (
          <>
            <p className="dv-modal-hint">
              {manifest.version ? `Version ${manifest.version}. ` : ''}
              {manifest.description ?? ''}
            </p>
            {staged.replaces != null && (
              <p className="pg-note">
                This replaces the installed {manifest.name}
                {staged.replaces ? ` ${staged.replaces}` : ''}.
              </p>
            )}
            <div className="pg-review">
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
                      <li key={w}>{POWER_LABEL[w] ?? w}</li>
                    ))}
                  </ul>
                ) : (
                  <span>Nothing beyond itself</span>
                )}
              </div>
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
                {busy ? 'Installing…' : 'Install'}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
