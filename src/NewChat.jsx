import { useEffect, useRef, useState } from 'react'
import { ArrowUp, House, FolderOpen, Lightning, Plus } from '@phosphor-icons/react'
import PickerMenu from './PickerMenu.jsx'
import { usePrivacyMode } from './privacy.js'
import { useHint, useModelSwitches, usePaletteSource, useShortcut } from './keyboard.jsx'
import FolderPickerModal from './FolderPickerModal.jsx'
import { machinePickerItems, platformLabel, signedIn } from './cloud.js'
import { HarnessMark } from './brand-marks.jsx'
import SignInModal from './SignInModal.jsx'
import HarnessManagerModal from './HarnessManagerModal.jsx'
import { useConsole } from './state/console.jsx'
import { harnessName } from './harness-names.js'
import { findModel, modelDisplayName } from './model-display.js'
import { modelMaker } from './model-maker.js'
import { ModelMark } from './model-marks.jsx'
import { SIGNIN_HARNESSES, pickable } from './harness-manager.js'
import { loadDefaults } from './defaults.js'
import { projectName } from './projects.js'
import { clashes } from './plugins.js'
import { useComposerMenus } from './useComposerMenus.jsx'
import { mentionedChats, ownCommands, takeCommands } from './composer-menus.js'
import { isMobile } from './platform.js'
import './newchat.css'
import './composer.css'

// The harnesses whose own login command the daemon can relay - the
// sign-in prompt offers the relay only there; the others say their own
// honest words.


export default function NewChat({
  onOpen,
  mode = 'local',
  addProjectOpen = false,
  onAddProjectDone,
  presetProject = null,
  focused = true,
  onOpenPlugins = null,
}) {
  const privacy = usePrivacyMode()
  const {
    connection, capabilities, sessions, chats, createChat, modelsFor, devices, thisDevice,
    capabilitiesFor, apiFor, projects, addProject, plugins, cloud, renameChat,
  } = useConsole()
  // Plugins of one name both on: said here too, where chats start.
  const clashing = mode === 'local' ? clashes(plugins?.installed) : []
  // In Cloud a chat can run on this computer or one of the account's
  // machines; in Local it always runs here.
  const [target, setTarget] = useState(null)
  const [targetCaps, setTargetCaps] = useState(null)
  const [picking, setPicking] = useState(false)
  const [addProjectError, setAddProjectError] = useState(null)
  const cloudMode = mode === 'cloud'
  // A phone runs no chats: its list is the machines alone.
  const machines = cloudMode ? machinePickerItems(devices, thisDevice, { phone: isMobile }) : []
  const targetItem = machines.find((m) => m.id === target) ?? null
  const targetOffline = Boolean(target && targetItem && !targetItem.online)
  const [defaults] = useState(() => loadDefaults())
  const [text, setText] = useState('')
  // The project the chat runs in: one of the registered projects, or
  // null - a chat that belongs to no project and runs in the home folder.
  const [projectId, setProjectId] = useState(null)
  const [picker, setPicker] = useState(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const [harness, setHarness] = useState(() => loadDefaults().harness)
  const [model, setModel] = useState(null)
  const [models, setModels] = useState([])
  const [modelsPending, setModelsPending] = useState(true)
  const [fast, setFast] = useState(false)
  const [signInFor, setSignInFor] = useState(null)
  const [managingHarnesses, setManagingHarnesses] = useState(false)

  // On a phone a chat always runs on a machine: the first online one until
  // the user picks another.
  const firstMachine = machines.find((m) => m.online)?.id ?? machines[0]?.id ?? null
  useEffect(() => {
    if (isMobile && cloudMode && !machines.some((m) => m.id === target) && firstMachine) {
      setTarget(firstMachine)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [firstMachine])

  // The sidebar's + opens the same Add project flow the home screen's
  // button opens - one way in, whichever surface asked.
  useEffect(() => {
    if (addProjectOpen) setPicking(true)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [addProjectOpen])

  // The command palette's project row: New chat, already in that project.
  // The palette lists this computer's projects, so the chat runs here.
  useEffect(() => {
    if (!presetProject) return
    setTarget(null)
    setProjectId(presetProject.id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [presetProject?.nonce])

  // The registered projects on the machine the chat will run on. A
  // project belongs to the machine that owns its folder, so the list
  // follows the target.
  const [targetProjects, setTargetProjects] = useState([])
  useEffect(() => {
    let cancelled = false
    // Not while the daemon is down: the fetch would only fail and blank
    // the picker for the whole reconnect window.
    if (connection.state !== 'connected') return
    apiFor(target)
      .projects()
      .then((list) => {
        if (!cancelled) setTargetProjects(list ?? [])
      })
      .catch(() => {
        if (!cancelled) setTargetProjects([])
      })
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target, connection.state, projects])

  // The mode switch starts the machine choice over. A chat in Local runs
  // on this computer even when Cloud had the New chat aimed at a machine,
  // and the harness list follows the machine - so the target, and the
  // project that belongs to it, come back to here.
  useEffect(() => {
    setTarget(null)
    setProjectId(null)
  }, [mode])

  // A machine's own harnesses, fetched when a chat aims at it. The first
  // answer can be empty or fail - the relay link is still coming up, or
  // the machine is still scanning for its harnesses - so the fetch keeps
  // trying (backing off to every 15s) until the machine reports some, and
  // starts over whenever the machine comes back online.
  const targetOnline = Boolean(targetItem?.online)
  useEffect(() => {
    let cancelled = false
    let timer = null
    let wait = 1500
    setTargetCaps(null)
    if (!target || connection.state !== 'connected' || !targetOnline) return
    const attempt = async () => {
      let caps = null
      try {
        caps = await capabilitiesFor(target)
      } catch {
        caps = null
      }
      if (cancelled) return
      if (caps) setTargetCaps(caps)
      if (!(caps?.harnesses ?? []).some((h) => h.available)) {
        timer = setTimeout(attempt, wait)
        wait = Math.min(wait * 2, 15000)
      }
    }
    attempt()
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target, targetOnline, connection.state])

  // Only what the machine reports installed - no dead UI.
  const available = ((target ? targetCaps : capabilities)?.harnesses ?? []).filter(pickable)
  const currentHarness = available.find((h) => h.id === harness) ?? available[0] ?? null
  // The picked harness's own sign-in fact: a harness that isn't signed in
  // says so right here - the task is about to run on it.
  const needsSignIn = currentHarness && currentHarness.signed_in === false

  // The model slot: filled where the harness advertises, reserved
  // (not rendered) where it doesn't. Fast mode follows the same rule -
  // and both choices are per-harness, so switching resets them. The
  // saved defaults preselect their own harness's slots.
  useEffect(() => {
    let cancelled = false
    const defaults = loadDefaults()
    setModel(currentHarness?.id === defaults.harness ? defaults.model : null)
    setFast(false)
    // Permission words belong to the harness (claude and grok share
    // spelling, codex has its own) - a switch resets the choice, the
    // saved default re-applies only where the new harness offers it.
    setPermission(null)
    if (!currentHarness) {
      setModels([])
      setModelsPending(false)
      return
    }
    setModelsPending(true)
    modelsFor(currentHarness.id, target).then((list) => {
      if (!cancelled) {
        setModels(list ?? [])
        setModelsPending(false)
      }
    })
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentHarness?.id, connection.state, target])

  const chosenProject = targetProjects.find((p) => p.id === projectId) ?? null
  // The chat's workspace is the project's folder; no project, no
  // workspace - the chat runs in the home folder on its machine.
  const workspace = chosenProject?.folders[0] ?? null

  const canSend =
    text.trim().length > 0 && !busy && currentHarness && connection.state === 'connected'
    && !needsSignIn && !targetOffline
  // The harness's own pre-send facts, each in its own words: what its
  // config says a fresh chat runs (grok's config.toml, agy's settings,
  // claude's priority chain), then its catalog's default marker (codex's
  // isDefault, claude's `default` alias - the row its own picker marks
  // recommended). Neither, and the slot stays reserved.
  const configDefault = currentHarness?.default_model ?? null
  const catalogDefault = models.find((m) => m.is_default)?.model ?? null
  const resolvedDefault = configDefault ?? catalogDefault
  // The pre-send fact's label, in the harness's own words: the config's
  // model name where the catalog knows it, the id where it doesn't.
  const resolvedDefaultName = resolvedDefault ? modelDisplayName(models, resolvedDefault) : null
  const defaultLabel =
    resolvedDefaultName && currentHarness?.default_effort
      ? `${resolvedDefaultName} · ${currentHarness.default_effort}`
      : resolvedDefaultName
  const inProgress = (sessions ?? []).filter((s) => ['starting', 'working', 'waiting'].includes(s.status))
  // The effort slot follows the model slot's rule: only where the active
  // model advertises tiers. A saved default that the active model doesn't
  // offer is dropped, not rendered - never a dead selection.
  const activeModel = model ? models.find((m) => m.model === model) : null
  const effortTiers = activeModel?.reasoning_efforts ?? []
  const [effort, setEffort] = useState(null)
  const savedEffort = effort ?? defaults.efforts?.[currentHarness?.id] ?? null
  const chosenEffort = effortTiers.includes(savedEffort) ? savedEffort : null
  // The permission slot: only where the harness has its own words (claude,
  // codex, grok). The picker offers the harness's vocabulary; the
  // harness's own default row is marked. Unset sends nothing - the
  // harness's default holds. A saved default that the harness no longer
  // offers is dropped, like the effort slot's.
  const permissionWords = currentHarness?.permission_modes ?? []
  const [permission, setPermission] = useState(null)
  const savedPermission =
    permission ?? defaults.permissions?.[currentHarness?.id] ?? null
  const chosenPermission = permissionWords.includes(savedPermission)
    ? savedPermission
    : null
  // The model the chat runs from its first breath: the user's pick, else
  // the catalog's default where the harness's config names none. The
  // daemon resolves the config case itself at create (pairing grok's
  // default effort with it); a catalog-only default - claude's `default`
  // alias - would otherwise stay unnamed until the first turn's init
  // frame reports it.
  const startModel = model ?? (configDefault ? null : catalogDefault)

  const openPicker = (kind) => (e) => setPicker({ kind, x: e.clientX, y: e.clientY })

  // The keyboard acts on the focused pane's composer (keyboard.jsx); a
  // picker that isn't on screen (no catalog, no permission words) lets
  // its key fall through.
  const boxRef = useRef(null)
  const inputRef = useRef(null)
  // The / and @ menus for the chat this screen will start: its harness,
  // its folder, the machine it will run on.
  const cloudReady = signedIn(cloud)
  const menus = useComposerMenus({
    text,
    setText,
    inputRef,
    harness: currentHarness?.id,
    workspace,
    deviceId: target,
    inChat: false,
    cloudReady,
    choicesFor: (arg) => {
      if (arg === 'model') return models.map((m) => ({ id: m.model, name: m.display_name ?? m.model }))
      if (arg === 'effort') return effortTiers.map((e) => ({ id: e }))
      if (arg === 'fast') return [{ id: 'on' }, { id: 'off' }]
      if (arg === 'permission') return permissionWords.map((w) => ({ id: w }))
      return []
    },
  })
  const openPickerAt = (kind) => {
    const el = boxRef.current?.querySelector(`[data-picker="${kind}"]`)
    if (!el) return false
    const r = el.getBoundingClientRect()
    setPicker({ kind, x: r.left + r.width / 2, y: r.top + r.height / 2 })
  }
  const chooseModel = (id) => {
    setModel(id)
    setEffort(null)
  }
  useShortcut(
    'focus-composer',
    () => {
      if (!inputRef.current) return false
      inputRef.current.focus()
    },
    focused,
  )
  // Steer with nothing running is an ordinary send: Ctrl+Enter starts the chat.
  useShortcut(
    'steer',
    () => {
      if (!canSend) return false
      start()
    },
    focused,
  )
  useShortcut('pick-model', () => openPickerAt('model'), focused)
  useShortcut('pick-effort', () => openPickerAt('effort'), focused)
  useShortcut('pick-permission', () => openPickerAt('permission'), focused)
  useShortcut('pick-harness', () => openPickerAt('harness'), focused)
  useShortcut(
    'toggle-fast',
    () => {
      if (!currentHarness?.fast_supported) return false
      setFast((v) => !v)
    },
    focused,
  )
  useModelSwitches((i) => {
    if (!models[i]) return false
    chooseModel(models[i].model)
  }, focused)
  usePaletteSource(
    'model',
    () =>
      models.length
        ? {
            title: 'Switch model',
            items: models.map((m) => ({
              id: m.model,
              name: m.display_name ?? m.model,
              icon: <ModelMark maker={modelMaker(currentHarness?.id, m.model, m.resolved_model)} size={14} />,
            })),
            selectedId: model,
            choose: chooseModel,
          }
        : null,
    focused,
  )
  usePaletteSource(
    'effort',
    () =>
      effortTiers.length
        ? {
            title: 'Set effort',
            items: effortTiers.map((t) => ({ id: t, name: t })),
            selectedId: chosenEffort,
            choose: setEffort,
          }
        : null,
    focused,
  )
  usePaletteSource(
    'permission',
    () =>
      permissionWords.length
        ? {
            title: 'Set permission',
            items: permissionWords.map((w) => ({ id: w, name: w })),
            selectedId: chosenPermission,
            choose: setPermission,
          }
        : null,
    focused,
  )
  const hintModel = useHint('pick-model')
  const hintEffort = useHint('pick-effort')
  const hintHarness = useHint('pick-harness')
  const hintPermission = useHint('pick-permission')
  const hintFast = useHint('toggle-fast')

  const start = async () => {
    if (!canSend) return
    setBusy(true)
    setError(null)
    try {
      // OpenRemote's commands set this chat's start (model, effort, fast,
      // permissions), its name, and whether it goes on Cloud; the rest is
      // the first message.
      const { run, text: message } = takeCommands(text.trim(), ownCommands({ inChat: false, cloud: cloudReady }))
      const picked = Object.fromEntries(run.map((c) => [c.name, c.arg]))
      const fastPicked = 'fast' in picked ? (picked.fast ? picked.fast.toLowerCase() === 'on' : !fast) : fast
      if (!message) {
        // Only commands: they set this screen's pickers.
        if (picked.model) setModel(picked.model)
        if (picked.effort) setEffort(picked.effort)
        if ('fast' in picked) setFast(fastPicked)
        if (picked.permissions) setPermission(picked.permissions)
        setText('')
        return
      }
      const id = await createChat(
        message,
        workspace,
        currentHarness.id,
        picked.model ?? startModel ?? undefined,
        fastPicked || undefined,
        picked.effort ?? chosenEffort ?? undefined,
        picked.permissions ?? chosenPermission ?? undefined,
        {
          deviceId: target,
          synced: cloudMode || 'sync' in picked || 'cloud' in picked,
          mentionedChats: mentionedChats(message, chats),
        },
      )
      if (picked.rename) await renameChat(id, picked.rename)
      setText('')
      onOpen(id)
    } catch (err) {
      setError(err.message ?? String(err))
    } finally {
      setBusy(false)
    }
  }

  // The one way a folder becomes a project: pick it on the machine that
  // will own it, and it registers there. The same dialog serves both
  // surfaces - a chat's project pick and the Add project button.
  const chooseProjectFolder = async (folder) => {
    setPicking(false)
    setAddProjectError(null)
    try {
      const project = await addProject([folder], { deviceId: target })
      setProjectId(project.id)
    } catch (err) {
      // The daemon's own words - a folder that is already a project, a
      // path that is not a folder - surface right beside the flow.
      setAddProjectError(err.message ?? String(err))
    }
  }

  // Switching machines: a project belongs to one machine, so the choice
  // starts over.
  const chooseTarget = (id) => {
    setTarget(id)
    setProjectId(null)
    setPicker(null)
  }

  return (
    <div className="newchat">
      <h1 className="nc-greeting">What are we working on?</h1>
      {clashing.map((c) => (
        <div className="nc-signin" key={c.name}>
          <div className="nc-signin-note">
            Two plugins named {c.name} are on ({c.ids.join(' and ')}). A Claude chat may mix up their
            commands.
          </div>
          {onOpenPlugins && (
            <button className="nc-signin-btn" onClick={onOpenPlugins}>
              Plugins
            </button>
          )}
        </div>
      ))}
      {needsSignIn && (
        <div className="nc-signin">
          <div className="nc-signin-note">
            {SIGNIN_HARNESSES.has(currentHarness.id) ? (
              <>
                {harnessName(currentHarness.id)} isn’t signed in on {targetItem?.name ?? 'this computer'}.
                Sign in to start tasks with it.
              </>
            ) : (
              <>
                {harnessName(currentHarness.id)} isn’t signed in - it signs in through its own
                setup.
              </>
            )}
          </div>
          {SIGNIN_HARNESSES.has(currentHarness.id) && (
            <button className="nc-signin-btn" onClick={() => setSignInFor(currentHarness.id)}>
              Sign in
            </button>
          )}
        </div>
      )}
      <div className="nc-box" ref={boxRef}>
        {menus.element}
        <textarea
          value={text}
          onChange={(e) => {
            setText(e.target.value)
            menus.track(e)
          }}
          onKeyUp={menus.track}
          onClick={menus.track}
          onKeyDown={(e) => {
            // The / and @ menus take their keys first.
            if (menus.onKeyDown(e)) return
            // A phone's keyboard Enter is a new line; the send button sends.
            if (e.key === 'Enter' && !e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey && !isMobile) {
              e.preventDefault()
              start()
            }
          }}
          ref={inputRef}
          placeholder="Describe the task"
          autoFocus={!isMobile}
          spellCheck={false}
        />
        <div className="nc-foot">
          <div className="nc-pickers">
            {modelsPending ? (
              <span className="nc-skeleton" aria-hidden="true" />
            ) : (models.length > 0 || resolvedDefault) && (
              <>
                {models.length > 0 ? (
                  <button
                    className="nc-meta"
                    onClick={openPicker('model')}
                    aria-haspopup="listbox"
                    aria-expanded={picker?.kind === 'model'}
                    data-picker="model"
                    title={hintModel('Model')}
                  >
                    {(() => {
                      // The shown model's own maker mark - the chosen
                      // one, else the harness's default row.
                      const row =
                        (model && findModel(models, model)) ?? models.find((m) => m.is_default) ?? null
                      const maker = modelMaker(currentHarness?.id, row?.model, row?.resolved_model)
                      return maker ? <ModelMark maker={maker} size={14} /> : null
                    })()}
                    {model ? modelDisplayName(models, model) : defaultLabel}
                  </button>
                ) : (
                  // No catalog to pick from, but the harness's own config
                  // says what a fresh chat runs - its words, shown as the
                  // fact it is. The wire's first-turn truth replaces it.
                  <span className="nc-meta nc-static" title="The model this harness runs, from its own config">
                    {defaultLabel}
                  </span>
                )}
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
                    selectedId={model ?? ''}
                    onChoose={(id) => {
                      setModel(id)
                      setEffort(null)
                      setPicker(null)
                    }}
                    onClose={() => setPicker(null)}
                    anchor={{ left: picker.x, top: picker.y }}
                    renderIcon={(m) => (
                      <ModelMark maker={modelMaker(currentHarness?.id, m.id, m.resolved_model)} size={14} />
                    )}
                  />
                )}
                {effortTiers.length > 0 && (
                  <button
                    type="button"
                    className="nc-meta"
                    onClick={openPicker('effort')}
                    aria-haspopup="listbox"
                    aria-expanded={picker?.kind === 'effort'}
                    data-picker="effort"
                    title={hintEffort("The harness's own effort tier")}
                  >
                    {chosenEffort ?? 'Effort'}
                  </button>
                )}
                {picker?.kind === 'effort' && (
                  <PickerMenu
                    label="Effort"
                    searchPlaceholder="Search efforts"
                    items={effortTiers.map((t) => ({ id: t, name: t }))}
                    groups={null}
                    selectedId={chosenEffort ?? ''}
                    onChoose={(id) => {
                      setEffort(id)
                      setPicker(null)
                    }}
                    onClose={() => setPicker(null)}
                    anchor={{ left: picker.x, top: picker.y }}
                  />
                )}
                <span className="nc-via">via</span>
              </>
            )}
            <button
              className="nc-meta"
              data-unset={!currentHarness || undefined}
              onClick={openPicker('harness')}
              aria-haspopup="listbox"
              aria-expanded={picker?.kind === 'harness'}
              data-picker="harness"
              title={hintHarness('Harness')}
            >
              <HarnessMark harness={currentHarness?.id} size={16} />
              {currentHarness?.name ?? 'No harness installed'}
            </button>
            {picker?.kind === 'harness' && (
              <PickerMenu
                label="Harness"
                searchPlaceholder="Search harnesses"
                items={available.map((h) => ({ id: h.id, name: h.name }))}
                renderIcon={(h) => <HarnessMark harness={h.id} size={16} />}
                groups={null}
                selectedId={currentHarness?.id ?? ''}
                onChoose={(id) => {
                  setHarness(id)
                  // Effort words belong to the harness's own catalog - a
                  // switch resets the choice to the new harness's default.
                  setEffort(null)
                  setPermission(null)
                  setPicker(null)
                }}
                onClose={() => setPicker(null)}
                anchor={{ left: picker.x, top: picker.y }}
                footer={
                  // The way in to the harness manager - the only row in
                  // the empty state, and the honest answer when the list
                  // is missing something. It manages this computer's
                  // harnesses; a phone has none (a machine's are in
                  // Machines).
                  isMobile ? null : <button
                    type="button"
                    onClick={() => {
                      setPicker(null)
                      setManagingHarnesses(true)
                    }}
                  >
                    Manage harnesses…
                  </button>
                }
              />
            )}
            {permissionWords.length > 0 && (
              <button
                type="button"
                className="nc-meta"
                data-unset={!chosenPermission || undefined}
                onClick={openPicker('permission')}
                aria-haspopup="listbox"
                aria-expanded={picker?.kind === 'permission'}
                data-picker="permission"
                title={hintPermission('What the harness may do without asking')}
              >
                {chosenPermission ?? 'Permission'}
              </button>
            )}
            {picker?.kind === 'permission' && (
              <PickerMenu
                label="Permission"
                searchPlaceholder="Search permission words"
                items={permissionWords.map((word) => ({ id: word, name: word }))}
                groups={null}
                selectedId={chosenPermission ?? ''}
                onChoose={(id) => {
                  setPermission(id)
                  setPicker(null)
                }}
                onClose={() => setPicker(null)}
                anchor={{ left: picker.x, top: picker.y }}
                renderSubline={(item) =>
                  item.id === currentHarness?.default_permission ? (
                    <span className="nc-item-sub">
                      {harnessName(currentHarness?.id)} runs this by default
                    </span>
                  ) : null
                }
              />
            )}
            {currentHarness?.fast_supported && (
              <button
                className={`nc-meta nc-fast${fast ? ' on' : ''}`}
                onClick={() => setFast((v) => !v)}
                aria-pressed={fast}
                title={hintFast("The harness's own fast mode - its speed tier, never a model switch")}
              >
                <Lightning size={13} weight={fast ? 'fill' : 'light'} />
                Fast
              </button>
            )}
          </div>
          <div className="nc-send-group">
            <button className="nc-send" onClick={start} disabled={!canSend} title="Start task">
              <ArrowUp size={15} weight="bold" />
            </button>
          </div>
        </div>
      </div>
      <div className="nc-under">
        <div className="nc-below">
          {/* The project is picked, never typed: the registered projects
              on the machine the chat runs on, "No project" for a chat
              that belongs to none, and the one way to add - the picker's
              own Add project row opens the folder picker. */}
          <div className="nc-device">
            <button
              className="nc-meta"
              onClick={openPicker('project')}
              aria-haspopup="listbox"
              aria-expanded={picker?.kind === 'project'}
              title={chosenProject ? (privacy ? 'The project this chat runs in' : workspace) : 'A chat can run in a project, or in no folder at all'}
            >
              <FolderOpen size={13} weight="light" />
              {chosenProject ? <span className="pv">{projectName(chosenProject)}</span> : 'No project'}
            </button>
            {picker?.kind === 'project' && (
              <PickerMenu
                label="Project"
                searchPlaceholder="Search projects"
                wide
                items={[
                  { id: '__none__', name: 'No project' },
                  ...targetProjects.map((p) => ({ id: p.id, name: projectName(p), veiled: true })),
                ]}
                groups={null}
                selectedId={chosenProject?.id ?? '__none__'}
                onChoose={(id) => {
                  setProjectId(id === '__none__' ? null : id)
                  setPicker(null)
                }}
                onClose={() => setPicker(null)}
                anchor={{ left: picker.x, top: picker.y }}
                renderSubline={(item) =>
                  item.id === '__none__' ? null : (
                    <span className="nc-item-sub pv">
                      {targetProjects.find((p) => p.id === item.id)?.folders[0]}
                    </span>
                  )
                }
                footer={
                  <button
                    type="button"
                    onClick={() => {
                      setPicker(null)
                      setPicking(true)
                    }}
                  >
                    <Plus size={12} weight="bold" /> Add project…
                  </button>
                }
              />
            )}
          </div>
          {cloudMode ? (
            <div className="nc-device">
              <button
                className="nc-meta"
                data-unset={!targetItem || undefined}
                onClick={openPicker('machine')}
                aria-haspopup="listbox"
                aria-expanded={picker?.kind === 'machine'}
                title="Where the chat runs"
              >
                <span className={`nc-dev-dot nc-dev-dot--${targetOffline ? 'offline' : 'online'}`} />
                {targetItem ? <span className={targetItem.here ? undefined : 'pv'}>{targetItem.name}</span> : isMobile ? 'Pick a machine' : 'This computer'}
              </button>
              {picker?.kind === 'machine' && (
                <PickerMenu
                  label="Run on"
                  searchPlaceholder="Search machines"
                  items={machines.map((m) => ({ ...m, id: m.id ?? 'here', veiled: !m.here }))}
                  groups={null}
                  selectedId={target ?? 'here'}
                  onChoose={(id) => chooseTarget(id === 'here' ? null : id)}
                  onClose={() => setPicker(null)}
                  anchor={{ left: picker.x, top: picker.y }}
                  renderIcon={(m) =>
                    m.here ? (
                      <House size={13} weight="light" />
                    ) : (
                      <span className={`nc-dev-dot nc-dev-dot--${m.online ? 'online' : 'offline'}`} />
                    )
                  }
                  renderSubline={(m) =>
                    m.here ? null : (
                      <span className="nc-item-sub">{m.online ? platformLabel(m.platform) : 'Offline'}</span>
                    )
                  }
                />
              )}
            </div>
          ) : (
            <span className="nc-meta nc-static">
              <House size={13} weight="light" />
              This computer
            </span>
          )}
        </div>
        {addProjectError && <p className="nc-error">{addProjectError}</p>}
        {targetOffline && <p className="nc-error"><span className="pv">{targetItem.name}</span> is offline.</p>}
        {isMobile && cloudMode && machines.length === 0 && (
          <div className="nc-signin">
            <div className="nc-signin-note">
              Chats run on your machines. Add one - a server, a home computer, or a desktop made a
              machine - and start chats on it from here.
            </div>
            <button className="nc-signin-btn" onClick={() => onOpen('machines')}>
              Machines
            </button>
          </div>
        )}
        {picking && (
          <FolderPickerModal
            api={apiFor(target)}
            where={targetItem?.name ?? 'this computer'}
            start={workspace}
            onChoose={chooseProjectFolder}
            onClose={() => {
              setPicking(false)
              onAddProjectDone?.()
            }}
          />
        )}
        {connection.state === 'error' && <p className="nc-error">{connection.error}</p>}
        {error && <p className="nc-error">{error}</p>}
        {signInFor && (
          <SignInModal
            harnessId={signInFor}
            onDone={() => setSignInFor(null)}
          />
        )}
        {managingHarnesses && (
          <HarnessManagerModal
            onClose={() => setManagingHarnesses(false)}
            onSignIn={(id) => {
              setManagingHarnesses(false)
              setSignInFor(id)
            }}
          />
        )}
        {inProgress.length > 0 && (
          <div className="nc-resume">
            <div className="nc-resume-label">In progress</div>
            {inProgress.map((session) => {
              const chat = chats[session.id]
              const title = chat?.title ?? 'A new task'
              return (
                <button key={session.id} type="button" onClick={() => onOpen(session.id)}>
                  <span className={`dot dot--${chat?.status ?? session.status}`} />
                  <span className="nc-resume-title">{title}</span>
                  <span className="nc-resume-meta">
                    {session.status === 'waiting'
                      ? 'Needs a decision'
                      : harnessName(session.harness)}
                  </span>
                </button>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}
