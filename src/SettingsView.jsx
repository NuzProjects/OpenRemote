import { useEffect, useState } from 'react'
import AboutModal from './AboutModal.jsx'
import UpdatesRow from './UpdatesRow.jsx'
import McpServersSection from './McpServersSection.jsx'
import AgentsSection from './AgentsSection.jsx'
import DeleteChatModal from './DeleteChatModal.jsx'
import SignInModal from './SignInModal.jsx'
import PickerMenu from './PickerMenu.jsx'
import { useConsole } from './state/console.jsx'
import { signedIn } from './cloud.js'
import { isMobile } from './platform.js'
import { archivedSessions } from './archive.js'
import { harnessName } from './harness-names.js'
import { SIGNIN_HARNESSES, pickable } from './harness-manager.js'
import { loadDefaults, saveDefaults } from './defaults.js'
import { findModel, modelDisplayName } from './model-display.js'
import { modelMaker } from './model-maker.js'
import { ModelMark } from './model-marks.jsx'
import {
  loadPrefs,
  savePrefs,
  applyReduceMotion,
  applyDensity,
  applyPrivacyMode,
} from './settings.js'
import { hasTauri } from './pick-folder.js'
import { usePrivacyMode } from './privacy.js'
import { version } from '../package.json'
import './devices.css'
import './panels.css'
import './settings.css'
import './keyboard.css'
import { useKeyboard, isMac } from './keyboard.jsx'
import { ACTIONS, GROUPS, comboFromEvent, comboLabel, isOverridden } from './shortcuts.js'

// The harnesses whose own login command the daemon can relay - the
// Sign-in action renders only there (no dead UI elsewhere).

// The rail's contract: one anchor per section, in panel order. The ids
// match the section elements, so the rail stays honest as sections
// change - add a section, add its anchor here.
const SECTIONS = [
  { id: 'new-tasks', label: 'New tasks' },
  { id: 'appearance', label: 'Appearance' },
  { id: 'startup', label: 'Startup' },
  { id: 'keyboard', label: 'Keyboard' },
  { id: 'cloud', label: 'Cloud' },
  { id: 'daemon', label: 'Daemon' },
  { id: 'harnesses', label: 'Harnesses' },
  { id: 'agents', label: 'Agents' },
  { id: 'mcp-servers', label: 'MCP servers' },
  { id: 'archived', label: 'Archived chats' },
  { id: 'this-install', label: 'This install' },
]

// A phone runs no harnesses and has no daemon of its own to manage or
// start with the system: its settings are how it looks and its account.
const PHONE_SECTIONS = new Set(['appearance', 'cloud', 'this-install'])

export default function SettingsView({ onReplay, onOpenChat }) {
  const privacy = usePrivacyMode()
  const {
    connection,
    capabilities,
    api,
    sessions,
    disconnect,
    modelsFor,
    cloud,
    signOutCloud,
    projects: projectsList,
    removeProject,
    chats,
    archived,
    setChatArchived,
    deleteChat,
  } = useConsole()
  const [deleting, setDeleting] = useState(null)
  const archivedRows = archivedSessions(sessions, archived)
  const [confirmSignOut, setConfirmSignOut] = useState(false)
  const inCloud = signedIn(cloud)
  const harnessList = capabilities?.harnesses ?? []
  const available = (harnessList ?? []).filter(pickable)
  const [defaults, setDefaults] = useState(() => loadDefaults())
  const [models, setModels] = useState([])
  const [picker, setPicker] = useState(null)
  const [about, setAbout] = useState(false)
  const [signInFor, setSignInFor] = useState(null)
  const [prefs, setPrefs] = useState(() => loadPrefs())
  const [confirmDisconnect, setConfirmDisconnect] = useState(false)
  // Keyboard: the action waiting for its new keys, and the last move's
  // note ("moved from New chat") under the action that took the key.
  const kb = useKeyboard()
  const [capturing, setCapturing] = useState(null)
  const [moved, setMoved] = useState(null)

  // While an action waits for its keys, every keystroke is the binding:
  // Esc cancels, Backspace or Delete clears the key, a lone modifier
  // waits for the rest. A click anywhere else cancels too.
  useEffect(() => {
    if (!capturing || !kb) return
    kb.setCapturing(true)
    const onKey = (e) => {
      e.preventDefault()
      e.stopPropagation()
      const bare = !e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey
      if (e.key === 'Escape' && bare) {
        setCapturing(null)
        return
      }
      if ((e.key === 'Backspace' || e.key === 'Delete') && bare) {
        kb.unbind(capturing)
        setMoved(null)
        setCapturing(null)
        return
      }
      const combo = comboFromEvent(e, isMac)
      if (!combo) return
      const displaced = kb.rebind(capturing, combo)
      setMoved(
        displaced.length
          ? { id: capturing, from: displaced.map((id) => ACTIONS.find((a) => a.id === id)?.label ?? id).join(', ') }
          : null,
      )
      setCapturing(null)
    }
    const onDown = () => setCapturing(null)
    window.addEventListener('keydown', onKey, true)
    window.addEventListener('mousedown', onDown, true)
    return () => {
      kb.setCapturing(false)
      window.removeEventListener('keydown', onKey, true)
      window.removeEventListener('mousedown', onDown, true)
    }
  }, [capturing, kb])
  const defaultHarness = available.find((h) => h.id === defaults.harness) ?? available[0] ?? null

  // The model row only renders where the default harness advertises -
  // the same rule the composer holds.
  useEffect(() => {
    let cancelled = false
    if (!defaultHarness) {
      setModels([])
      return
    }
    modelsFor(defaultHarness.id).then((list) => {
      if (!cancelled) setModels(list ?? [])
    })
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [defaultHarness?.id, connection.state])

  const set = (partial) => {
    saveDefaults(partial)
    setDefaults(loadDefaults())
    setPicker(null)
  }

  // The effort row offers only the default model's own tiers - the same
  // rule the composer holds. A default model without tiers, or a saved
  // tier the model doesn't offer, means no row: never a dead selection.
  const defaultModel =
    models.find((m) => m.model === defaults.model) ??
    models.find((m) => m.is_default) ??
    null
  const effortTiers = defaultModel?.reasoning_efforts ?? []
  const savedEffort = defaults.efforts?.[defaultHarness?.id] ?? null
  const chosenEffort = effortTiers.includes(savedEffort) ? savedEffort : null
  // The permission row offers only the default harness's own words -
  // the same rule the composer holds. No words, no row.
  const permissionWords = defaultHarness?.permission_modes ?? []
  const savedPermission = defaults.permissions?.[defaultHarness?.id] ?? null
  const chosenPermission = permissionWords.includes(savedPermission)
    ? savedPermission
    : null

  const setPref = (partial) => {
    savePrefs(partial)
    setPrefs(loadPrefs())
  }

  const openPicker = (kind) => (e) => setPicker({ kind, x: e.clientX, y: e.clientY })

  const toggleReduce = () => {
    const value = !prefs.reduce_motion
    setPref({ reduce_motion: value })
    applyReduceMotion(document, value)
  }

  const togglePrivacy = () => {
    const value = !prefs.privacy_mode
    setPref({ privacy_mode: value })
    applyPrivacyMode(document, value)
  }

  // The Windows startup toggle: the shell's autostart plugin writes the
  // Run key. The fact is asked once on open; toggling flips it through
  // the plugin and re-reads. Browser dev has no shell - the row never
  // renders there.
  const [autoStart, setAutoStart] = useState(null)
  useEffect(() => {
    if (!hasTauri || isMobile) return
    let cancelled = false
    ;(async () => {
      try {
        const { isEnabled } = await import('@tauri-apps/plugin-autostart')
        const enabled = await isEnabled()
        if (!cancelled) setAutoStart(enabled)
      } catch {
        /* the row stays absent */
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])
  const toggleAutoStart = async () => {
    if (autoStart == null) return
    try {
      const { isEnabled, enable, disable } = await import('@tauri-apps/plugin-autostart')
      if (autoStart) await disable()
      else await enable()
      setAutoStart(await isEnabled())
    } catch {
      /* the fact stays what it was */
    }
  }

  // Keeping OpenRemote in the tray when the window closes: the shell's own
  // setting (on by default when this computer is a machine). Absent in the
  // browser, and where no tray can be shown.
  const [tray, setTray] = useState(null)
  useEffect(() => {
    if (!hasTauri || isMobile) return
    let cancelled = false
    ;(async () => {
      try {
        const { invoke } = await import('@tauri-apps/api/core')
        const view = await invoke('tray_prefs')
        if (!cancelled) setTray(view)
      } catch {
        /* the row stays absent */
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])
  const toggleTray = async () => {
    if (!tray) return
    try {
      const { invoke } = await import('@tauri-apps/api/core')
      setTray(await invoke('set_tray_prefs', { keepRunning: !tray.keep_running }))
    } catch {
      /* the fact stays what it was */
    }
  }

  // The shell restart: this side is a single invoke; the console heals
  const [restarting, setRestarting] = useState(false)
  const restartDaemon = async () => {
    if (!hasTauri || restarting) return
    setRestarting(true)
    try {
      const { invoke } = await import('@tauri-apps/api/core')
      await invoke('daemon_restart')
    } catch {
      /* the poll reports the outcome either way */
    }
    setTimeout(() => setRestarting(false), 4000)
  }

  // The daemon's port and data dir, straight from the shell's own
  // record of the sidecar. Browser dev has no sidecar - no dead rows.
  const [daemonDetail, setDaemonDetail] = useState(null)
  useEffect(() => {
    if (!hasTauri) return
    let cancelled = false
    const ask = async () => {
      try {
        const { invoke } = await import('@tauri-apps/api/core')
        const info = await invoke('daemon_info')
        if (!cancelled && info?.url) setDaemonDetail(info)
      } catch {
        /* the row simply stays absent */
      }
    }
    ask()
    return () => {
      cancelled = true
    }
  }, [connection.state])

  return (
    <div className="settings">
      <nav className="stg-nav" aria-label="Settings sections">
        {(isMobile ? SECTIONS.filter((s) => PHONE_SECTIONS.has(s.id)) : SECTIONS).map((s) => (
          <a
            key={s.id}
            href={`#stg-${s.id}`}
            className="stg-nav-btn"
            onClick={
              // On a phone a hash link would be a history entry, and the
              // back button would land on it.
              isMobile
                ? (e) => {
                    e.preventDefault()
                    document.getElementById(`stg-${s.id}`)?.scrollIntoView({ behavior: 'smooth' })
                  }
                : undefined
            }
          >
            {s.label}
          </a>
        ))}
      </nav>
      <div className="panel stg-panel">

      {!isMobile && (
      <>
      <h2 className="pn-section" id="stg-new-tasks">New tasks</h2>
      <p className="pn-lead">What a new chat starts with. The composers still change their minds.</p>
      <div className="pn-list pn-list--tight">
        <div className="pn-row">
          <div>
            <div className="pn-name">Harness</div>
            <div className="pn-detail">What a new task starts on.</div>
          </div>
          <button
            type="button"
            className="pn-btn"
            data-unset={!defaultHarness || undefined}
            onClick={openPicker('harness')}
            aria-haspopup="listbox"
            aria-expanded={picker?.kind === 'harness'}
          >
            {defaultHarness?.name ?? 'No harness installed'}
          </button>
          {picker?.kind === 'harness' && (
            <PickerMenu
              label="Harness"
              searchPlaceholder="Search harnesses"
              items={available.map((h) => ({ id: h.id, name: h.name }))}
              groups={null}
              selectedId={defaultHarness?.id ?? ''}
              onChoose={(id) => set({ harness: id, model: null })}
              onClose={() => setPicker(null)}
              anchor={{ left: picker.x, top: picker.y }}
            />
          )}
        </div>
        {models.length > 0 && (
          <div className="pn-row">
            <div>
              <div className="pn-name">Model</div>
              <div className="pn-detail">{defaultHarness?.name}'s own catalog.</div>
            </div>
            <button
              type="button"
              className="pn-btn"
              onClick={openPicker('model')}
              aria-haspopup="listbox"
              aria-expanded={picker?.kind === 'model'}
            >
              {(() => {
                // The chosen model's own maker mark, where the catalog
                // names one; the harness default row carries the
                // default model's, not none.
                const shown = defaults.model && models.some((m) => m.model === defaults.model)
                  ? findModel(models, defaults.model)
                  : null
                const row = shown ?? models.find((m) => m.is_default) ?? null
                const maker = modelMaker(defaultHarness?.id, row?.model, row?.resolved_model)
                return maker ? <ModelMark maker={maker} size={14} /> : null
              })()}
              {defaults.model && models.some((m) => m.model === defaults.model)
                ? modelDisplayName(models, defaults.model)
                : `${defaultHarness?.name} default`}
            </button>
            {picker?.kind === 'model' && (
              <PickerMenu
                label="Model"
                searchPlaceholder="Search models"
                wide
                items={models.map((m) => ({
                  id: m.model,
                  name: m.display_name ?? m.model,
                  resolved_model: m.resolved_model,
                }))}
                groups={null}
                selectedId={defaults.model ?? ''}
                onChoose={(id) => set({ model: id })}
                onClose={() => setPicker(null)}
                anchor={{ left: picker.x, top: picker.y }}
                renderIcon={(m) => (
                  <ModelMark maker={modelMaker(defaultHarness?.id, m.id, m.resolved_model)} size={14} />
                )}
              />
            )}
          </div>
        )}
        {effortTiers.length > 0 && (
          <div className="pn-row">
            <div>
              <div className="pn-name">Effort</div>
              <div className="pn-detail">{defaultHarness?.name}'s own tier words for {defaultModel?.display_name ?? defaultModel?.model}.</div>
            </div>
            <button
              type="button"
              className="pn-btn"
              onClick={openPicker('effort')}
              aria-haspopup="listbox"
              aria-expanded={picker?.kind === 'effort'}
            >
              {chosenEffort ?? `${defaultHarness?.name} default`}
            </button>
            {picker?.kind === 'effort' && (
              <PickerMenu
                label="Effort"
                searchPlaceholder="Search efforts"
                items={effortTiers.map((t) => ({ id: t, name: t }))}
                groups={null}
                selectedId={chosenEffort ?? ''}
                onChoose={(id) =>
                  set({ efforts: { ...defaults.efforts, [defaultHarness.id]: id } })
                }
                onClose={() => setPicker(null)}
                anchor={{ left: picker.x, top: picker.y }}
              />
            )}
          </div>
        )}
        {permissionWords.length > 0 && (
          <div className="pn-row">
            <div>
              <div className="pn-name">Permission</div>
              <div className="pn-detail">
                What {defaultHarness?.name} may do without asking, in its own words.
              </div>
            </div>
            <button
              type="button"
              className="pn-btn"
              onClick={openPicker('permission')}
              aria-haspopup="listbox"
              aria-expanded={picker?.kind === 'permission'}
            >
              {chosenPermission ?? `${defaultHarness?.name} default`}
            </button>
            {picker?.kind === 'permission' && (
              <PickerMenu
                label="Permission"
                searchPlaceholder="Search permission words"
                items={permissionWords.map((word) => ({ id: word, name: word }))}
                groups={null}
                selectedId={chosenPermission ?? ''}
                onChoose={(id) =>
                  set({ permissions: { ...defaults.permissions, [defaultHarness.id]: id } })
                }
                onClose={() => setPicker(null)}
                anchor={{ left: picker.x, top: picker.y }}
                renderSubline={(item) =>
                  item.id === defaultHarness?.default_permission ? (
                    <span className="nc-item-sub">
                      {defaultHarness?.name} runs this by default
                    </span>
                  ) : null
                }
              />
            )}
          </div>
        )}
        <div className="pn-row">
          <div>
            <div className="pn-name">Projects</div>
            <div className="pn-detail">
              {projectsList.length
                ? 'The folders whose chats group under their project. Removing a project keeps every chat.'
                : 'No projects yet. Add one from the home screen.'}
            </div>
          </div>
          <div className="pn-actions">
            {projectsList.map((p) => (
              <button
                key={p.id}
                type="button"
                className="pn-btn"
                title={privacy ? 'Remove the project - its chats stay' : `Remove the project - its chats stay. Folder: ${p.folders[0]}`}
                onClick={() => removeProject(p.id)}
              >
                <span className="pv">{p.folders[0].split(/[\\/]/).filter(Boolean).pop()}</span> ✕
              </button>
            ))}
          </div>
        </div>
      </div>
      </>
      )}

      <h2 className="pn-section" id="stg-appearance">Appearance</h2>
      <p className="pn-lead">Space, not themes - the dark theme is the contract.</p>
      <div className="pn-list pn-list--tight">
        <div className="pn-row">
          <div>
            <div className="pn-name">Density</div>
            <div className="pn-detail">Compact pulls the rows and gutters in.</div>
          </div>
          <button
            type="button"
            className={prefs.density === 'compact' ? 'pn-btn on' : 'pn-btn'}
            onClick={() => {
              const value = prefs.density === 'compact' ? 'comfortable' : 'compact'
              setPref({ density: value })
              applyDensity(document, value)
            }}
          >
            {prefs.density === 'compact' ? 'Compact' : 'Comfortable'}
          </button>
        </div>
        <div className="pn-row">
          <div>
            <div className="pn-name">Reduce motion</div>
            <div className="pn-detail">Stops the running-dot breathe and picker transitions.</div>
          </div>
          <button
            type="button"
            className={prefs.reduce_motion ? 'pn-btn on' : 'pn-btn'}
            onClick={toggleReduce}
          >
            {prefs.reduce_motion ? 'On' : 'Off'}
          </button>
        </div>
        <div className="pn-row">
          <div>
            <div className="pn-name">Privacy mode</div>
            <div className="pn-detail">
              For recordings and streams: blurs chat titles, projects, paths, device names, your
              email and the transcript. What you type stays readable.
            </div>
          </div>
          <button
            type="button"
            className={prefs.privacy_mode ? 'pn-btn on' : 'pn-btn'}
            onClick={togglePrivacy}
          >
            {prefs.privacy_mode ? 'On' : 'Off'}
          </button>
        </div>
      </div>

      {!isMobile && (
      <>
      <h2 className="pn-section" id="stg-startup">Startup</h2>
      <p className="pn-lead">What the app does when it opens.</p>
      <div className="pn-list pn-list--tight">
        <div className="pn-row">
          <div>
            <div className="pn-name">Reopen</div>
            <div className="pn-detail">The view you left, or always New chat.</div>
          </div>
          <button
            type="button"
            className="pn-btn"
            onClick={openPicker('startup')}
            aria-haspopup="listbox"
            aria-expanded={picker?.kind === 'startup'}
          >
            {prefs.startup_view === 'last' ? 'Last view' : 'New chat'}
          </button>
          {picker?.kind === 'startup' && (
            <PickerMenu
              label="Reopen"
              searchPlaceholder="Search"
              items={[
                { id: 'new', name: 'New chat' },
                { id: 'last', name: 'Last view' },
              ]}
              groups={null}
              selectedId={prefs.startup_view}
              onChoose={(id) => setPref({ startup_view: id })}
              onClose={() => setPicker(null)}
              anchor={{ left: picker.x, top: picker.y }}
            />
          )}
        </div>
        {autoStart != null && (
          <div className="pn-row">
            <div>
              <div className="pn-name">Launch at login</div>
              <div className="pn-detail">Starts OpenRemote when you sign in to this computer.</div>
            </div>
            <button
              type="button"
              className={autoStart ? 'pn-btn on' : 'pn-btn'}
              onClick={toggleAutoStart}
            >
              {autoStart ? 'On' : 'Off'}
            </button>
          </div>
        )}
        {tray?.available && (
          <div className="pn-row">
            <div>
              <div className="pn-name">Keep running in the tray</div>
              <div className="pn-detail">
                {tray.machine
                  ? 'Closing the window leaves OpenRemote running, so your other devices can still reach this one. Quit from the tray icon.'
                  : 'Closing the window leaves OpenRemote running, so chats here keep going. Quit from the tray icon.'}
              </div>
            </div>
            <button type="button" className={tray.keep_running ? 'pn-btn on' : 'pn-btn'} onClick={toggleTray}>
              {tray.keep_running ? 'On' : 'Off'}
            </button>
          </div>
        )}
      </div>
      </>
      )}

      {!isMobile && kb && (
      <>
      <h2 className="pn-section" id="stg-keyboard">Keyboard</h2>
      <p className="pn-lead">
        Click an action, then press its new keys. A key another action holds moves here.
        Backspace clears a key, Esc cancels.
      </p>
      {GROUPS.map((group) => (
        <div key={group.id} className="pn-list pn-list--tight kb-set">
          <div className="kb-group-label">{group.label}</div>
          {ACTIONS.filter((a) => a.group === group.id).map((a) => (
            <div className="pn-row" key={a.id}>
              <div>
                <div className="pn-name">{a.label}</div>
                {moved?.id === a.id && <div className="pn-detail">Moved from {moved.from}.</div>}
              </div>
              <div className="pn-actions">
                {isOverridden(kb.overrides, a.id) && (
                  <button
                    type="button"
                    className="pn-btn"
                    onClick={() => {
                      kb.reset(a.id)
                      setMoved(null)
                    }}
                  >
                    Reset
                  </button>
                )}
                <button
                  type="button"
                  className={capturing === a.id ? 'pn-btn on' : 'pn-btn'}
                  // Its own mousedown would cancel the capture it starts.
                  onMouseDown={(e) => e.stopPropagation()}
                  onClick={() => setCapturing(capturing === a.id ? null : a.id)}
                >
                  {capturing === a.id ? (
                    'Press keys…'
                  ) : kb.bindings[a.id] ? (
                    <kbd className="kb-keys">{comboLabel(kb.bindings[a.id], isMac)}</kbd>
                  ) : (
                    'No key'
                  )}
                </button>
              </div>
            </div>
          ))}
        </div>
      ))}
      {Object.keys(kb.overrides).length > 0 && (
        <div className="pn-list pn-list--tight">
          <div className="pn-row">
            <div>
              <div className="pn-name">Every key back to its default</div>
            </div>
            <button
              type="button"
              className="pn-btn"
              onClick={() => {
                kb.resetAll()
                setMoved(null)
              }}
            >
              Reset all
            </button>
          </div>
        </div>
      )}
      </>
      )}

      <h2 className="pn-section" id="stg-cloud">Cloud</h2>
      <p className="pn-lead">Your moreweb account, and {isMobile ? "this phone's" : "this computer's"} place in it.</p>
      <div className="pn-list pn-list--tight">
        <div className="pn-row">
          <div>
            <div className="pn-name">
              {inCloud ? (
                cloud.account?.email ? (
                  <>Signed in as <span className="pv">{cloud.account.email}</span></>
                ) : (
                  'Signed in as your account'
                )
              ) : (
                'Not signed in'
              )}
            </div>
            <div className="pn-detail">
              {inCloud
                ? confirmSignOut
                  ? `Synced chats stay on ${isMobile ? 'this phone' : 'this computer'}; they stop syncing until you sign in again.`
                  : isMobile
                    ? `This phone is ${cloud.device?.name ?? 'here'}.`
                    : `This computer is ${cloud.device?.name ?? 'here'}, ${cloud.device?.kind === 'machine' ? 'a machine your other devices can run chats on' : 'a desktop'}.`
                : 'Switch to Cloud to sign in. Local chats never need an account.'}
            </div>
          </div>
          {inCloud &&
            (confirmSignOut ? (
              <div className="pn-actions">
                <button
                  type="button"
                  className="pn-btn"
                  onClick={async () => {
                    setConfirmSignOut(false)
                    await signOutCloud()
                  }}
                >
                  Sign out
                </button>
                <button type="button" className="pn-btn" onClick={() => setConfirmSignOut(false)}>Cancel</button>
              </div>
            ) : (
              <button type="button" className="pn-btn" onClick={() => setConfirmSignOut(true)}>
                Sign out
              </button>
            ))}
        </div>
      </div>

      {!isMobile && (
      <>
      <h2 className="pn-section" id="stg-daemon">Daemon</h2>
      <p className="pn-lead">The local process the chats run through.</p>
      <div className="pn-list pn-list--tight">
        <div className="pn-row">
          <div>
            <div className="pn-name">{connection.state === 'connected' ? 'Connected' : 'Not connected'}</div>
            <div className="pn-detail">{connection.state === 'connected' ? 'Bearer token accepted.' : connection.error ?? 'Start the app or connect from the first-run steps.'}</div>
          </div>
          {confirmDisconnect ? (
            <div className="pn-actions">
              <button type="button" className="pn-btn" onClick={disconnect}>Disconnect</button>
              <button type="button" className="pn-btn" onClick={() => setConfirmDisconnect(false)}>Cancel</button>
            </div>
          ) : (
            <button
              type="button"
              className="pn-btn"
              onClick={() => setConfirmDisconnect(true)}
              disabled={connection.state !== 'connected'}
            >
              {connection.state === 'connected' ? 'Forget' : '-'}
            </button>
          )}
        </div>
        <div className="pn-row">
          <div>
            <div className="pn-name">{(sessions ?? []).length} {(sessions ?? []).length === 1 ? 'chat' : 'chats'} on record</div>
            <div className="pn-detail">Sessions survive daemon restarts; stopped ones can resume.</div>
          </div>
        </div>
        {daemonDetail?.url && (
          <div className="pn-row">
            <div>
              <div className="pn-name">{daemonDetail.url.replace(/^https?:\/\//, '')}</div>
              <div className="pn-detail">
                {daemonDetail.data_dir ? <span className="pv">{daemonDetail.data_dir}</span> : 'The local address the console talks to.'}
              </div>
            </div>
          </div>
        )}
        {hasTauri && (
          <div className="pn-row">
            <div>
              <div className="pn-name">Restart</div>
              <div className="pn-detail">
                {restarting
                  ? 'The daemon is coming back; the console reconnects on its own.'
                  : 'Stops running chats (stopped ones can resume) and starts a fresh daemon.'}
              </div>
            </div>
            <button
              type="button"
              className="pn-btn"
              onClick={restartDaemon}
              disabled={restarting}
            >
              {restarting ? 'Restarting' : 'Restart'}
            </button>
          </div>
        )}
      </div>

      <h2 className="pn-section" id="stg-harnesses">Harnesses</h2>
      <p className="pn-lead">What the daemon can drive on this machine. Install a harness's own CLI and it appears here.</p>
      <div className="pn-list pn-list--tight">
        {(harnessList ?? []).map((h) => (
          <div className="pn-row" key={h.id}>
            <div>
              <div className="pn-name">{harnessName(h.id)}</div>
              <div className="pn-detail">{h.available ? <span className="pv">{h.path}</span> : 'Not found on this machine.'}</div>
            </div>
            {h.available && h.signed_in === false && SIGNIN_HARNESSES.has(h.id) ? (
              <button type="button" className="pn-btn" onClick={() => setSignInFor(h.id)}>
                Sign in
              </button>
            ) : (
              <span className={`pn-btn${h.available && h.signed_in !== false ? ' on' : ''}`}>
                {!h.available ? 'Missing' : h.signed_in === false ? 'Not signed in' : h.signed_in ? 'Signed in' : 'Ready'}
              </span>
            )}
          </div>
        ))}
      </div>
      </>
      )}

      {!isMobile && (
        <>
          <h2 className="pn-section" id="stg-agents">Agents</h2>
          <AgentsSection />
          <h2 className="pn-section" id="stg-mcp-servers">MCP servers</h2>
          <McpServersSection />
        </>
      )}

      <h2 className="pn-section" id="stg-archived">Archived chats</h2>
      <div className="pn-list pn-list--tight">
        {archivedRows.length === 0 ? (
          <div className="pn-row">
            <div>
              <div className="pn-name">Nothing archived</div>
              <div className="pn-detail">Archive a chat from the sidebar to tuck it away here.</div>
            </div>
          </div>
        ) : (
          archivedRows.map((s) => (
            <div className="pn-row" key={s.id}>
              <div>
                <div className="pn-name pv">{chats[s.id]?.title ?? s.title ?? 'A new task'}</div>
                <div className="pn-detail">
                  {harnessName(s.harness)}
                  {s.workspace ? <> · <span className="pv">{s.workspace}</span></> : ''}
                </div>
              </div>
              <button type="button" className="pn-btn" onClick={() => onOpenChat(s.id)}>Open</button>
              <button type="button" className="pn-btn" onClick={() => setChatArchived(s.id, false)}>Restore</button>
              {s.executor && (
                <button
                  type="button"
                  className="pn-btn pn-btn--danger"
                  title="Delete this chat from every device"
                  onClick={() => setDeleting(s)}
                >
                  Delete
                </button>
              )}
            </div>
          ))
        )}
        <div className="pn-detail">Archived chats are hidden on this computer only. They keep running and syncing as usual. Delete removes a synced chat from every device; a private chat can't be deleted.</div>
      </div>

      <h2 className="pn-section" id="stg-this-install">This install</h2>
      <div className="pn-list pn-list--tight">
        <div className="pn-row">
          <div>
            <div className="pn-name">OpenRemote {version}</div>
            <div className="pn-detail">Daemon {capabilities?.daemon ?? '-'} · the parity build</div>
          </div>
          <button type="button" className="pn-btn" onClick={() => setAbout(true)}>About</button>
        </div>
        {!isMobile && <UpdatesRow />}
        {!isMobile && (
          <div className="pn-row">
            <div>
              <div className="pn-name">First-run steps</div>
              <div className="pn-detail">Shows them again. The chats stay.</div>
            </div>
            <button type="button" className="pn-btn" onClick={onReplay}>Show</button>
          </div>
        )}
      </div>

      </div>
      {deleting && (
        <DeleteChatModal
          title={chats[deleting.id]?.title ?? deleting.title ?? 'This chat'}
          onClose={() => setDeleting(null)}
          onDelete={() => deleteChat(deleting.id)}
        />
      )}
      {about && (
        <AboutModal
          onClose={() => setAbout(false)}
          daemonVersion={capabilities?.daemon ?? null}
          api={api}
        />
      )}
      {signInFor && <SignInModal harnessId={signInFor} onDone={() => setSignInFor(null)} />}
    </div>
  )
}
