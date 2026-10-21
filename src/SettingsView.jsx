import { useEffect, useMemo, useRef, useState } from 'react'
import {
  Archive,
  Cloud,
  Info,
  Keyboard as KeyboardIcon,
  MagnifyingGlass,
  Palette,
  Plugs,
  Power,
  Robot,
  Sparkle,
  TerminalWindow,
  X,
} from '@phosphor-icons/react'
import AboutModal from './AboutModal.jsx'
import McpServersSection from './McpServersSection.jsx'
import DeleteChatModal from './DeleteChatModal.jsx'
import SignInModal from './SignInModal.jsx'
import PickerMenu from './PickerMenu.jsx'
import Toggle from './Toggle.jsx'
import { SECTIONS, SETTING_GROUPS, SETTINGS_ENTRIES, searchSettings, visibleSections } from './settings-search.js'
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

// The tab icon per section. The sections themselves and the search index
// live in settings-search.js, so a new tab is one entry there.
const SECTION_ICONS = {
  'new-tasks': Sparkle,
  appearance: Palette,
  startup: Power,
  keyboard: KeyboardIcon,
  cloud: Cloud,
  daemon: TerminalWindow,
  harnesses: Robot,
  'mcp-servers': Plugs,
  archived: Archive,
  'this-install': Info,
}

const MAX_RESULTS = 24

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
    mcpServers,
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

  // Tabs and search: the panel shows one section at a time, and a query
  // replaces it with results gathered from every section this device has.
  const [tab, setTab] = useState(isMobile ? 'appearance' : 'new-tasks')
  const [query, setQuery] = useState('')
  const [shortcutQuery, setShortcutQuery] = useState('')
  const [flash, setFlash] = useState(null)
  const panelRef = useRef(null)
  const searchRef = useRef(null)
  const shortcutSearchRef = useRef(null)
  const navRef = useRef(null)
  const tabs = useMemo(() => visibleSections(isMobile), [])
  const active = tabs.some((s) => s.id === tab) ? tab : tabs[0].id
  const navGroups = useMemo(
    () =>
      SETTING_GROUPS.map((group) => ({
        ...group,
        sections: tabs.filter((section) => section.group === group.id),
      })).filter((group) => group.sections.length > 0),
    [tabs],
  )
  const sectionLabel = (id) => SECTIONS.find((s) => s.id === id)?.label ?? id

  const index = useMemo(() => {
    const dynamic = [
      ...harnessList.map((h) => ({
        key: `harness-${h.id}`,
        section: 'harnesses',
        label: harnessName(h.id),
        detail: h.available ? 'Installed on this machine.' : 'Not found on this machine.',
        terms: ['harness', 'cli', 'install', h.id],
      })),
      ...(mcpServers ?? []).map((p) => ({
        key: `mcp-${p.id}`,
        section: 'mcp-servers',
        label: p.name,
        detail: p.detail ?? 'An MCP server.',
        terms: ['mcp', 'server', 'tool'],
      })),
      ...archivedRows.map((s) => ({
        key: `archived-${s.id}`,
        section: 'archived',
        label: chats[s.id]?.title ?? s.title ?? 'A new task',
        detail: harnessName(s.harness),
        terms: ['archive', 'chat', 'restore', 'delete'],
      })),
    ]
    return [...SETTINGS_ENTRIES, ...dynamic]
  }, [harnessList, mcpServers, archivedRows, chats])

  // A row that is not on screen (no model catalog, no tray, browser dev)
  // must not answer the search: a result that lands nowhere is dead UI.
  const absent = useMemo(() => {
    const keys = new Set()
    if (!models.length) keys.add('new-tasks-model')
    if (!effortTiers.length) keys.add('new-tasks-effort')
    if (!permissionWords.length) keys.add('new-tasks-permission')
    if (autoStart == null) keys.add('startup-launch')
    if (!tray?.available) keys.add('startup-tray')
    if (!daemonDetail?.url) keys.add('daemon-address')
    if (!hasTauri) keys.add('daemon-restart')
    if (isMobile) keys.add('install-first-run')
    return keys
  }, [models, effortTiers, permissionWords, autoStart, tray, daemonDetail])

  const searchable = useMemo(() => {
    const ids = new Set(tabs.map((s) => s.id))
    return index.filter((e) => ids.has(e.section) && !absent.has(e.key))
  }, [index, absent, tabs])
  const results = useMemo(() => searchSettings(query, searchable), [query, searchable])
  const shown = results.slice(0, MAX_RESULTS)
  const counts = useMemo(() => {
    const map = {}
    for (const entry of results) map[entry.section] = (map[entry.section] ?? 0) + 1
    return map
  }, [results])

  // The Keyboard tab's own filter: an action answers by its name, its
  // group, and both spellings of its key, and the row being rebound stays
  // on screen while its old keys stop matching.
  const keyboardFilter = shortcutQuery.trim().toLowerCase()
  const keyboardGroups = useMemo(() => {
    const words = keyboardFilter.split(/\s+/).filter(Boolean)
    return GROUPS.map((group) => ({
      ...group,
      actions: ACTIONS.filter((a) => {
        if (a.group !== group.id) return false
        if (!words.length || capturing === a.id) return true
        const combo = kb?.bindings?.[a.id] ?? null
        const hay = [
          a.label,
          group.label,
          combo ? comboLabel(combo, isMac) : '',
          combo ?? '',
          combo ? '' : 'no key unbound',
        ]
          .join(' ')
          .toLowerCase()
        return words.every((word) => hay.includes(word))
      }),
    })).filter((group) => group.actions.length > 0)
  }, [keyboardFilter, kb, capturing])
  const shortcutCount = keyboardGroups.reduce((sum, group) => sum + group.actions.length, 0)

  const selectTab = (id) => {
    setTab(id)
    setQuery('')
    setShortcutQuery('')
    setPicker(null)
    setFlash(null)
  }

  const openResult = (entry) => {
    setQuery('')
    setShortcutQuery('')
    setTab(entry.section)
    setFlash(entry.key)
    setPicker(null)
  }

  const onTabKey = (e) => {
    const at = tabs.findIndex((s) => s.id === active)
    let next = null
    if (e.key === 'ArrowDown' || e.key === 'ArrowRight') next = (at + 1) % tabs.length
    else if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') next = (at - 1 + tabs.length) % tabs.length
    else if (e.key === 'Home') next = 0
    else if (e.key === 'End') next = tabs.length - 1
    else return
    e.preventDefault()
    const id = tabs[next].id
    selectTab(id)
    // The tab buttons stay mounted, so moving focus now survives the
    // render the selection starts.
    navRef.current?.querySelector(`#stg-tab-${id}`)?.focus()
  }

  // Every new tab or query starts at the top; a chosen result then finds
  // its own row.
  useEffect(() => {
    if (panelRef.current) panelRef.current.scrollTop = 0
  }, [active, query])

  useEffect(() => {
    const panel = panelRef.current
    if (!panel) return
    panel.querySelectorAll('.stg-found').forEach((el) => el.classList.remove('stg-found'))
    if (!flash || query) return
    const target = panel.querySelector(`[data-stg="${flash}"]`)
    if (target) {
      target.classList.add('stg-found')
      panel.focus({ preventScroll: true })
      target.scrollIntoView({ block: 'center' })
    }
  }, [flash, active, query])

  // "/" reaches the settings search from anywhere in the window, except
  // from a field that is already typing and while a key is being bound.
  useEffect(() => {
    const onKey = (e) => {
      if (e.key !== '/' || e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return
      if (capturing || picker || deleting || about || signInFor) return
      const target = e.target
      if (
        target instanceof HTMLElement &&
        (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName))
      ) {
        return
      }
      e.preventDefault()
      const field =
        active === 'keyboard' ? shortcutSearchRef.current ?? searchRef.current : searchRef.current
      field?.focus()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [capturing, picker, deleting, about, signInFor, active])

  return (
    <div className="settings">
      <aside className="stg-side">
        <label className="stg-search">
          <MagnifyingGlass size={14} className="stg-search-icon" />
          <input
            ref={searchRef}
            type="search"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value)
              setFlash(null)
            }}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                e.preventDefault()
                e.stopPropagation()
                if (query) setQuery('')
                else e.currentTarget.blur()
                return
              }
              if (e.key === 'ArrowDown' && shown.length) {
                e.preventDefault()
                panelRef.current?.querySelector('.stg-result')?.focus()
                return
              }
              if (e.key === 'Enter' && shown.length) {
                e.preventDefault()
                openResult(shown[0])
              }
            }}
            placeholder="Search settings"
            aria-label="Search settings"
            spellCheck={false}
          />
          {query ? (
            <button
              type="button"
              className="stg-search-clear"
              onClick={() => setQuery('')}
              title="Clear the search"
              aria-label="Clear the search"
            >
              <X size={11} weight="bold" />
            </button>
          ) : (
            <kbd className="stg-search-key" aria-hidden="true">
              /
            </kbd>
          )}
        </label>
        <nav
          ref={navRef}
          className="stg-nav"
          role="tablist"
          aria-label="Settings sections"
          aria-orientation={isMobile ? 'horizontal' : 'vertical'}
          onKeyDown={onTabKey}
        >
          {navGroups.map((group) => (
            <div key={group.id} className="stg-nav-group">
              {!isMobile && <div className="stg-nav-group-label">{group.label}</div>}
              {group.sections.map((s) => {
                const Icon = SECTION_ICONS[s.id] ?? Info
                const count = counts[s.id] ?? 0
                return (
                  <button
                    key={s.id}
                    type="button"
                    id={`stg-tab-${s.id}`}
                    role="tab"
                    aria-selected={active === s.id}
                    aria-controls={`stg-${s.id}`}
                    tabIndex={active === s.id ? 0 : -1}
                    className={active === s.id ? 'stg-nav-btn on' : 'stg-nav-btn'}
                    onClick={() => selectTab(s.id)}
                  >
                    <Icon size={15} className="stg-nav-icon" />
                    <span className="stg-nav-label">{s.label}</span>
                    {query && count > 0 && (
                      <span className="stg-nav-count" aria-hidden="true">
                        {count}
                      </span>
                    )}
                  </button>
                )
              })}
            </div>
          ))}
        </nav>
      </aside>
      <div className="panel stg-panel" ref={panelRef} tabIndex={-1}>
        <div
          className="stg-results-view"
          role="region"
          aria-label="Search results"
          hidden={!query}
          onKeyDown={(e) => {
            // A query's Esc clears the search even after the arrow keys
            // moved focus into the results; it never closes the window.
            if (e.key === 'Escape' && query) {
              e.preventDefault()
              e.stopPropagation()
              setQuery('')
              searchRef.current?.focus()
            }
          }}
        >
          <header className="stg-head">
            <h2 className="stg-title">Search results</h2>
            <p className="stg-lead" aria-live="polite">
              {results.length
                ? `${results.length} ${results.length === 1 ? 'setting matches' : 'settings match'} "${query.trim()}".`
                : ''}
            </p>
          </header>
          {results.length === 0 ? (
            <div className="stg-empty">
              <p className="stg-empty-name">Nothing matches "{query.trim()}".</p>
              <p className="stg-empty-detail">
                Try a section name, or a word like "motion", "shortcut", or "daemon".
              </p>
            </div>
          ) : (
            <>
              <div className="stg-result-list">
                {shown.map((entry) => (
                  <button
                    key={entry.key}
                    type="button"
                    className="stg-result"
                    onClick={() => openResult(entry)}
                  >
                    <span className="stg-result-main">
                      <span className="stg-result-name">{entry.label}</span>
                      <span className="stg-result-detail">{entry.detail}</span>
                    </span>
                    <span className="stg-result-where">{sectionLabel(entry.section)}</span>
                  </button>
                ))}
              </div>
              {results.length > shown.length && (
                <p className="stg-more">
                  Showing the first {shown.length}. Refine the search to narrow it.
                </p>
              )}
            </>
          )}
        </div>

        {!isMobile && (
          <section
            className="stg-section"
            id="stg-new-tasks"
            role="tabpanel"
            aria-labelledby="stg-tab-new-tasks"
            data-stg="new-tasks"
            hidden={!!query || active !== 'new-tasks'}
          >
            <header className="stg-head">
              <h2 className="stg-title">New tasks</h2>
              <p className="stg-lead">What a new chat starts with. The composers still change their minds.</p>
            </header>
            <div className="pn-list pn-list--tight">
              <div className="pn-row" data-stg="new-tasks-harness">
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
                <div className="pn-row" data-stg="new-tasks-model">
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
                      const shownModel = defaults.model && models.some((m) => m.model === defaults.model)
                        ? findModel(models, defaults.model)
                        : null
                      const row = shownModel ?? models.find((m) => m.is_default) ?? null
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
                <div className="pn-row" data-stg="new-tasks-effort">
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
                <div className="pn-row" data-stg="new-tasks-permission">
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
              <div className="pn-row" data-stg="new-tasks-projects">
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
          </section>
        )}

        <section
          className="stg-section"
          id="stg-appearance"
          role="tabpanel"
          aria-labelledby="stg-tab-appearance"
          data-stg="appearance"
          hidden={!!query || active !== 'appearance'}
        >
          <header className="stg-head">
            <h2 className="stg-title">Appearance</h2>
            <p className="stg-lead">Space, not themes - the dark theme is the contract.</p>
          </header>
          <div className="pn-list pn-list--tight">
            <div className="pn-row" data-stg="appearance-density">
              <div>
                <div className="pn-name">Compact density</div>
                <div className="pn-detail">Pulls the rows and gutters in.</div>
              </div>
              <Toggle
                checked={prefs.density === 'compact'}
                onChange={() => {
                  const value = prefs.density === 'compact' ? 'comfortable' : 'compact'
                  setPref({ density: value })
                  applyDensity(document, value)
                }}
                label="Compact density"
              />
            </div>
            <div className="pn-row" data-stg="appearance-motion">
              <div>
                <div className="pn-name">Reduce motion</div>
                <div className="pn-detail">Stops the running-dot breathe and picker transitions.</div>
              </div>
              <Toggle checked={prefs.reduce_motion} onChange={toggleReduce} label="Reduce motion" />
            </div>
            <div className="pn-row" data-stg="appearance-privacy">
              <div>
                <div className="pn-name">Privacy mode</div>
                <div className="pn-detail">
                  For recordings and streams: blurs chat titles, projects, paths, device names, your
                  email and the transcript. What you type stays readable.
                </div>
              </div>
              <Toggle checked={prefs.privacy_mode} onChange={togglePrivacy} label="Privacy mode" />
            </div>
          </div>
        </section>

        {!isMobile && (
          <section
            className="stg-section"
            id="stg-startup"
            role="tabpanel"
            aria-labelledby="stg-tab-startup"
            data-stg="startup"
            hidden={!!query || active !== 'startup'}
          >
            <header className="stg-head">
              <h2 className="stg-title">Startup</h2>
              <p className="stg-lead">What the app does when it opens.</p>
            </header>
            <div className="pn-list pn-list--tight">
              <div className="pn-row" data-stg="startup-reopen">
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
                <div className="pn-row" data-stg="startup-launch">
                  <div>
                    <div className="pn-name">Launch at login</div>
                    <div className="pn-detail">Starts OpenRemote when you sign in to this computer.</div>
                  </div>
                  <Toggle checked={autoStart} onChange={toggleAutoStart} label="Launch at login" />
                </div>
              )}
              {tray?.available && (
                <div className="pn-row" data-stg="startup-tray">
                  <div>
                    <div className="pn-name">Keep running in the tray</div>
                    <div className="pn-detail">
                      {tray.machine
                        ? 'Closing the window leaves OpenRemote running, so your other devices can still reach this one. Quit from the tray icon.'
                        : 'Closing the window leaves OpenRemote running, so chats here keep going. Quit from the tray icon.'}
                    </div>
                  </div>
                  <Toggle
                    checked={tray.keep_running}
                    onChange={toggleTray}
                    label="Keep running in the tray"
                  />
                </div>
              )}
            </div>
          </section>
        )}

        {!isMobile && kb && (
          <section
            className="stg-section"
            id="stg-keyboard"
            role="tabpanel"
            aria-labelledby="stg-tab-keyboard"
            data-stg="keyboard"
            hidden={!!query || active !== 'keyboard'}
          >
            <header className="stg-head">
              <h2 className="stg-title">Keyboard</h2>
              <p className="stg-lead">
                Click an action, then press its new keys. A key another action holds moves here.
                Backspace clears a key, Esc cancels.
              </p>
            </header>
            <div className="stg-kb-bar">
              <label className="stg-kb-filter">
                <MagnifyingGlass size={13} className="stg-search-icon" />
                <input
                  ref={shortcutSearchRef}
                  type="search"
                  value={shortcutQuery}
                  onChange={(e) => setShortcutQuery(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Escape') {
                      e.preventDefault()
                      e.stopPropagation()
                      if (shortcutQuery) setShortcutQuery('')
                      else e.currentTarget.blur()
                    }
                  }}
                  placeholder="Filter shortcuts"
                  aria-label="Filter keyboard shortcuts"
                  spellCheck={false}
                />
                {shortcutQuery && (
                  <button
                    type="button"
                    className="stg-kb-clear"
                    onClick={() => setShortcutQuery('')}
                    title="Clear the filter"
                    aria-label="Clear the filter"
                  >
                    <X size={11} weight="bold" />
                  </button>
                )}
              </label>
              {shortcutQuery && (
                <span className="stg-kb-count" aria-live="polite">
                  {shortcutCount} of {ACTIONS.length}
                </span>
              )}
              {Object.keys(kb.overrides).length > 0 && (
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
              )}
            </div>
            {keyboardGroups.length === 0 ? (
              <div className="stg-empty">
                <p className="stg-empty-name">Nothing matches "{shortcutQuery.trim()}".</p>
                <p className="stg-empty-detail">
                  Search an action, a group, or a key like "Ctrl+N".
                </p>
              </div>
            ) : (
              keyboardGroups.map((group) => (
                <div key={group.id} className="pn-list pn-list--tight kb-set">
                  <div className="kb-group-label">{group.label}</div>
                  {group.actions.map((a) => (
                    <div className="pn-row" key={a.id} data-stg={`keyboard-${a.id}`}>
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
              ))
            )}
          </section>
        )}

        <section
          className="stg-section"
          id="stg-cloud"
          role="tabpanel"
          aria-labelledby="stg-tab-cloud"
          data-stg="cloud"
          hidden={!!query || active !== 'cloud'}
        >
          <header className="stg-head">
            <h2 className="stg-title">Cloud</h2>
            <p className="stg-lead">Your moreweb account, and {isMobile ? "this phone's" : "this computer's"} place in it.</p>
          </header>
          <div className="pn-list pn-list--tight">
            <div className="pn-row" data-stg="cloud-account">
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
        </section>

        {!isMobile && (
          <>
          <section
            className="stg-section"
            id="stg-daemon"
            role="tabpanel"
            aria-labelledby="stg-tab-daemon"
            data-stg="daemon"
            hidden={!!query || active !== 'daemon'}
          >
            <header className="stg-head">
              <h2 className="stg-title">Daemon</h2>
              <p className="stg-lead">The local process the chats run through.</p>
            </header>
            <div className="pn-list pn-list--tight">
              <div className="pn-row" data-stg="daemon-connection">
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
              <div className="pn-row" data-stg="daemon-chats">
                <div>
                  <div className="pn-name">{(sessions ?? []).length} {(sessions ?? []).length === 1 ? 'chat' : 'chats'} on record</div>
                  <div className="pn-detail">Sessions survive daemon restarts; stopped ones can resume.</div>
                </div>
              </div>
              {daemonDetail?.url && (
                <div className="pn-row" data-stg="daemon-address">
                  <div>
                    <div className="pn-name">{daemonDetail.url.replace(/^https?:\/\//, '')}</div>
                    <div className="pn-detail">
                      {daemonDetail.data_dir ? <span className="pv">{daemonDetail.data_dir}</span> : 'The local address the console talks to.'}
                    </div>
                  </div>
                </div>
              )}
              {hasTauri && (
                <div className="pn-row" data-stg="daemon-restart">
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
          </section>
          <section
            className="stg-section"
            id="stg-harnesses"
            role="tabpanel"
            aria-labelledby="stg-tab-harnesses"
            data-stg="harnesses"
            hidden={!!query || active !== 'harnesses'}
          >
            <header className="stg-head">
              <h2 className="stg-title">Harnesses</h2>
              <p className="stg-lead">What the daemon can drive on this machine. Install a harness's own CLI and it appears here.</p>
            </header>
            <div className="pn-list pn-list--tight">
              {harnessList.map((h) => (
                <div className="pn-row" key={h.id} data-stg={`harness-${h.id}`}>
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
          </section>
          </>
        )}

        {!isMobile && (
          <section
            className="stg-section"
            id="stg-mcp-servers"
            role="tabpanel"
            aria-labelledby="stg-tab-mcp-servers"
            data-stg="mcp-servers"
            hidden={!!query || active !== 'mcp-servers'}
          >
            <header className="stg-head">
              <h2 className="stg-title">MCP servers</h2>
            </header>
            <McpServersSection />
          </section>
        )}

        <section
          className="stg-section"
          id="stg-archived"
          role="tabpanel"
          aria-labelledby="stg-tab-archived"
          data-stg="archived"
          hidden={!!query || active !== 'archived'}
        >
          <header className="stg-head">
            <h2 className="stg-title">Archived chats</h2>
            <p className="stg-lead">
              Hidden on this computer only. They keep running and syncing; Delete removes a synced
              chat from every device, and a private chat can't be deleted.
            </p>
          </header>
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
                <div className="pn-row" key={s.id} data-stg={`archived-${s.id}`}>
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
          </div>
        </section>

        <section
          className="stg-section"
          id="stg-this-install"
          role="tabpanel"
          aria-labelledby="stg-tab-this-install"
          data-stg="this-install"
          hidden={!!query || active !== 'this-install'}
        >
          <header className="stg-head">
            <h2 className="stg-title">This install</h2>
            <p className="stg-lead">The build you're running and the first-run steps.</p>
          </header>
          <div className="pn-list pn-list--tight">
            <div className="pn-row" data-stg="install-version">
              <div>
                <div className="pn-name">OpenRemote {version}</div>
                <div className="pn-detail">Daemon {capabilities?.daemon ?? '-'} · the parity build</div>
              </div>
              <button type="button" className="pn-btn" onClick={() => setAbout(true)}>About</button>
            </div>
            {!isMobile && (
              <div className="pn-row" data-stg="install-first-run">
                <div>
                  <div className="pn-name">First-run steps</div>
                  <div className="pn-detail">Shows them again. The chats stay.</div>
                </div>
                <button type="button" className="pn-btn" onClick={onReplay}>Show</button>
              </div>
            )}
          </div>
        </section>

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
