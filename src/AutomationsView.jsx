// Automations: rules that open a chat when their trigger fires. The
// clock and a webhook are the real sources today; Run now is the same
// path by hand. The pill at the bottom drafts rules from a sentence -
// a keyword brain behind the same action card.

import { useEffect, useMemo, useState } from 'react'
import {
  ArrowUpRight,
  Check,
  Lightning,
  MagnifyingGlass,
  PencilSimple,
  Play,
  TrashSimple,
  X,
} from '@phosphor-icons/react'
import AutomationForm from './AutomationForm.jsx'
import PillComposer from './PillComposer.jsx'
import { useConsole } from './state/console.jsx'
import { harnessName } from './harness-names.js'
import {
  CONNECTOR_KINDS,
  RULE_EMPTY_NONE,
  ruleCountLine,
  ruleEmptyLine,
  ruleSearchHint,
  searchRules,
  whenSentence,
} from './automation.js'
import { onJobRequest, takeJobRequest } from './chat-to-job.js'
import { parsePill } from './pill.js'
import { projectName } from './projects.js'
import { armRow, clearRow, rowIsArmed } from './row-confirm.js'
import { useArmedRow } from './use-armed-row.js'
import './devices.css'
import './automations.css'
import './pill.css'
import { pickable } from './harness-manager.js'

const RAN = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })

function ranLabel(rule) {
  if (!rule.last_run) return 'never ran'
  return `ran ${RAN.format(new Date(rule.last_run))}`
}

export default function AutomationsView({ onOpenChat }) {
  const {
    api,
    automations,
    automationsAnswered,
    capabilities,
    machines,
    projects,
    saveAutomation,
    removeAutomation,
    enableAutomation,
    runAutomation,
  } = useConsole()
  const [editing, setEditing] = useState(null) // null | {} (new) | rule
  const [busyId, setBusyId] = useState(null)
  const [error, setError] = useState(null)
  // The rule waiting on a "remove?" answer. A rule is user-written text with a
  // schedule behind it, and there is no undo for one this conversation did not
  // create, so the trash icon asks once in place before it acts: the same
  // two-step every destructive row uses, armed by row-confirm.js.
  const [armed, setArmed] = useState(null)
  const armWatch = useArmedRow(armed, setArmed)
  // The pill's conversation: {role: user|reply|card|done|note, text?, draft?}
  const [thread, setThread] = useState([])
  // The list's search. It narrows what the list draws; it never reorders it,
  // and it is the list's only way in (no sort, no filters), so it matches
  // exactly what a row prints - see searchRules.
  const [query, setQuery] = useState('')

  // A chat can ask for the rule editor to open already filled in. The
  // request travels through chat-to-job.js because the palette has no prop
  // for the chat on screen: it stages the draft and asks the shell for this
  // view, and the view collects it here (the stage is already waiting when
  // this view mounted for it, and a request that arrives while the view is
  // already open comes in on the subscription).
  useEffect(() => {
    const open = (draft) => setEditing(draft)
    const waiting = takeJobRequest()
    if (waiting) open(waiting)
    return onJobRequest(open)
  }, [])

  const rules = automations ?? []
  // What the list draws: every rule, or the ones the query matches. The
  // search narrows; it never sorts.
  const shown = useMemo(() => searchRules(rules, query), [rules, query])
  const filtering = query.trim().length > 0
  const availableIds = new Set(
    (capabilities?.harnesses ?? []).filter(pickable).map((h) => h.id),
  )
  const machineName = (id) => (machines ?? []).find((m) => m.machine.id === id)?.machine.name ?? id
  // One online machine is the honest local state - hostname chips and the
  // check-in note return when a second machine is actually online.
  const oneMachine = (machines ?? []).filter((m) => m.machine.status === 'online').length <= 1
  // Rules run where the agent is online - a waiting machine can host a
  // draft, but the draft has to say so instead of firing on this one.
  const machineOnline = (id) =>
    (machines ?? []).some((m) => m.machine.id === id && m.machine.status === 'online')

  // The pill's context: machines, the registered projects, and the
  // defaults a draft falls back to.
  const workspaces = useMemo(
    () => (projects ?? []).map((p) => [projectName(p), p.folders[0]]), // [name, path]
    [projects],
  )
  const thisMachine = (machines ?? []).find((m) => m.machine.this_machine)

  const run = async (action, id, ...args) => {
    if (busyId) return
    // Any action on the view is the user moving on: the armed row stands down
    // first, the way the endpoint and MCP panes do it.
    setArmed(clearRow())
    setBusyId(id ?? 'view')
    setError(null)
    try {
      return await action(...args)
    } catch (err) {
      setError(err.message ?? String(err))
      return null
    } finally {
      setBusyId(null)
    }
  }

  const runNow = async (rule) => {
    const session = await run(() => runAutomation(rule.id), rule.id)
    if (session) onOpenChat?.(session.id)
  }

  // ---- the pill ----

  const pillContext = {
    machines: (machines ?? []).map((m) => ({
      id: m.machine.id,
      name: m.machine.name,
      status: m.machine.status,
    })),
    projects: workspaces.map(([name]) => name),
    defaults: {
      harness: (capabilities?.harnesses ?? []).find(pickable)?.id ?? 'claude',
      machineId: thisMachine?.machine.id,
    },
  }

  const submitPill = async (text) => {
    setThread((t) => [...t, { role: 'user', text }])
    let out
    try {
      out = parsePill(text, pillContext)
    } catch {
      // The pill answers, always: a sentence that breaks the brain gets
      // plain words back, not silence (a throw here would swallow the
      // user's text with no reply, no draft, no error).
      out = {
        reply:
          'That one did not parse - try a simpler shape, e.g. "When the api pipeline on main fails, open a chat to bisect the flaky test."',
      }
    }
    if (out.reply) {
      setThread((t) => [...t, { role: 'reply', text: out.reply }])
      return
    }
    setThread((t) => [...t, { role: 'card', draft: out.draft, id: crypto.randomUUID() }])
  }

  const createFromDraft = async (draft, cardId) => {
    const path = workspaces.find(([name]) => name === draft.project)?.[1] ?? workspaces[0]?.[1]
    if (!path) {
      setThread((t) => [
        ...t,
        { role: 'note', text: 'No project yet - add one from the home screen first.' },
      ])
      return
    }
    const saved = await run(
      () =>
        saveAutomation({
          name: draft.name,
          trigger: { kind: draft.trigger.kind, time: draft.trigger.time },
          harness: draft.harness,
          workspace: path,
          machine: draft.machineId,
          task: draft.task,
        }),
      cardId,
    )
    if (saved) {
      setThread((t) => [
        ...t.map((item) => (item.id === cardId ? { ...item, consumed: true } : item)),
        { role: 'done', text: 'Rule created · enabled', ruleId: saved.id },
      ])
    }
  }

  const undoCreate = async (ruleId) => {
    await run(() => removeAutomation(ruleId), ruleId)
    setThread((t) => [...t, { role: 'note', text: 'Rule removed.' }])
  }

  const editFromDraft = (draft, cardId) => {
    const path = workspaces.find(([name]) => name === draft.project)?.[1] ?? workspaces[0]?.[1]
    setEditing({
      name: draft.name,
      trigger: { kind: draft.trigger.kind, time: draft.trigger.time },
      harness: draft.harness,
      machine: draft.machineId,
      workspace: path ?? '',
      task: draft.task,
    })
    setThread((t) => [
      ...t.map((item) => (item.id === cardId ? { ...item, consumed: true } : item)),
      { role: 'note', text: 'Opened in the form.' },
    ])
  }

  const enabledCount = rules.filter((r) => r.enabled).length

  return (
    <div className="automations">
      <header className="dv-head">
        <div>
          <h1 className="dv-title">Automations</h1>
          <p className="dv-meta">
            {automationsAnswered
              ? `${rules.length} ${rules.length === 1 ? 'rule' : 'rules'} · ${enabledCount} enabled`
              : 'Loading the rules…'}
          </p>
        </div>
        <button type="button" className="dv-act" onClick={() => setEditing({})}>
          New automation
        </button>
      </header>

      {/* The list's one way in. A field over an empty list would be a control
          with nothing to act on, so it appears with the first rule; its hint
          appears only once the list is long enough that a person scans it -
          searchHint owns the threshold. Escape clears it, then leaves it, the
          way the sidebar's own search does. */}
      {rules.length > 0 && (
        <div className="am-toolbar">
          <label className="am-search">
            <MagnifyingGlass size={14} className="am-search-icon" />
            <input
              className="am-search-input"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key !== 'Escape') return
                e.preventDefault()
                if (query) setQuery('')
                else e.currentTarget.blur()
              }}
              placeholder={ruleSearchHint(rules.length)}
              spellCheck={false}
              autoComplete="off"
              aria-label="Search rules"
            />
            {query && (
              <button
                type="button"
                className="am-search-clear"
                onClick={() => setQuery('')}
                aria-label="Clear search"
                title="Clear search"
              >
                <X size={12} weight="bold" />
              </button>
            )}
          </label>
          {/* The count only while a query is on: at rest the header already
              counts the list, and two counts would say it twice. */}
          {filtering && shown.length > 0 && (
            <p className="am-count">{ruleCountLine(shown.length, rules.length)}</p>
          )}
        </div>
      )}

      <div className="am-list">
        {/* An empty list and a list that has not answered look the same in
            state, so the sentence follows the flag: the invitation to write
            one is only said once the daemon has actually said so. */}
        {rules.length === 0 && (
          <p className="am-empty">{automationsAnswered ? RULE_EMPTY_NONE : 'Loading the rules…'}</p>
        )}
        {/* A query that found nothing is not an empty list: it says which
            query came up empty rather than inviting a new rule. */}
        {filtering && rules.length > 0 && shown.length === 0 && (
          <p className="am-empty">{ruleEmptyLine(query)}</p>
        )}
        {shown.map((rule) => {
          const missing = !availableIds.has(rule.harness)
          return (
            <div key={rule.id} className={`am-rule${rule.enabled ? '' : ' off'}`}>
              <div className="am-rule-main">
                <div className="am-rule-body">
                  <div className="am-name pv">{rule.name}</div>
                  <div className="am-line">
                    {whenSentence(rule.trigger)} · {harnessName(rule.harness)}
                    {oneMachine ? '' : <> on <span className="pv">{machineName(rule.machine)}</span></>} · {ranLabel(rule)}
                  </div>
                  {rule.trigger.kind === 'webhook' && api?.url && (
                    <code className="am-hook pv">
                      {api.url}/hooks/{rule.id}?key={rule.trigger.key}
                    </code>
                  )}
                </div>
                <div className="am-actions">
                  {rule.last_chat && (
                    <button
                      className="am-icon"
                      title="Open the last chat"
                      onClick={() => onOpenChat?.(rule.last_chat)}
                    >
                      <ArrowUpRight size={13} />
                    </button>
                  )}
                  <button
                    className="am-icon"
                    title={rule.enabled ? 'Run now' : 'Enable the rule to run it'}
                    disabled={!rule.enabled || busyId != null}
                    onClick={() => runNow(rule)}
                  >
                    <Play size={13} weight="fill" />
                  </button>
                  <button className="am-icon" title="Edit" onClick={() => { setArmed(clearRow()); setEditing(rule) }}>
                    <PencilSimple size={13} />
                  </button>
                  {rowIsArmed(armed, rule.id) ? (
                    /* The trash is replaced in place by the word that acts, the
                       way the endpoint and MCP rows ask: same danger button,
                       same "Remove it", same spot the first press landed on. */
                    <button
                      type="button"
                      className="pn-btn pn-btn--danger"
                      ref={armWatch.buttonRef}
                      onBlur={armWatch.onBlur}
                      onClick={() => {
                        setArmed(clearRow())
                        run(() => removeAutomation(rule.id), rule.id)
                      }}
                      title="The rule and its schedule go, and there is no undo"
                    >
                      Remove it
                    </button>
                  ) : (
                    <button
                      className="am-icon"
                      title="Remove"
                      aria-label={`Remove ${rule.name}`}
                      disabled={busyId != null}
                      onClick={() => setArmed((curr) => armRow(curr, rule.id))}
                    >
                      <TrashSimple size={13} />
                    </button>
                  )}
                  <button
                    className={`am-switch${rule.enabled ? ' on' : ''}`}
                    role="switch"
                    aria-checked={rule.enabled}
                    aria-label={`${rule.name} enabled`}
                    onClick={() => run(() => enableAutomation(rule.id, !rule.enabled), rule.id)}
                  />
                </div>
              </div>
              {rule.enabled && missing && (
                <p className="am-note">
                  {harnessName(rule.harness)} is not installed
                  {oneMachine ? '.' : <> on <span className="pv">{machineName(rule.machine)}</span>.</>}
                </p>
              )}
            </div>
          )
        })}
      </div>

      {error && <p className="am-error">{error}</p>}

      {editing != null && (
        <AutomationForm rule={editing} onClose={() => setEditing(null)} />
      )}

      <div className="pill-dock">
        <div className="pt-stack">
          {thread.map((item, index) => {
            if (item.role === 'user') {
              return (
                <div key={index} className="pt-user pv">
                  {item.text}
                </div>
              )
            }
            if (item.role === 'reply' || item.role === 'note') {
              return (
                <p key={index} className="pt-reply pv">
                  {item.text}
                </p>
              )
            }
            if (item.role === 'done') {
              return (
                <p key={index} className="pt-done">
                  <Check size={12} weight="bold" /> <span className="pv">{item.text}</span>{' '}
                  <button className="pt-undo" onClick={() => undoCreate(item.ruleId)}>
                    Undo
                  </button>
                </p>
              )
            }
            // the draft action card
            const draft = item.draft
            const connectorKind = CONNECTOR_KINDS.includes(draft.trigger.kind)
            const hookKind = draft.trigger.kind === 'webhook'
            const offlineMachine = draft.machineId && !machineOnline(draft.machineId)
            return (
              <div key={item.id} className="pt-card">
                <div className="pt-card-head">
                  <Lightning size={11} weight="fill" /> CREATE RULE
                </div>
                <div className="pt-card-name pv">{draft.name}</div>
                <div className="pt-card-chips">
                  <span className="pt-chip">{harnessName(draft.harness)}</span>
                  {!oneMachine && <span className="pt-chip"><span className="pv">{machineName(draft.machineId)}</span></span>}
                  <span className="pt-chip">
                    {hookKind ? 'webhook' : `every day at ${draft.trigger.time}`}
                  </span>
                </div>
                <div className="pt-card-task pv">“{draft.task}”</div>
                {connectorKind && (
                  <p className="pt-card-note">
                    That trigger needs a connector that isn’t built yet - a schedule or a webhook
                    fires today.
                  </p>
                )}
                {!oneMachine && offlineMachine && (
                  <p className="pt-card-note">
                    <span className="pv">{machineName(draft.machineId)}</span> hasn’t checked in - rules run where the agent
                    is online.
                  </p>
                )}
                {!item.consumed && (
                  <div className="pt-card-actions">
                    <button
                      className="pt-primary"
                      disabled={connectorKind || offlineMachine || busyId != null}
                      onClick={() => createFromDraft(draft, item.id)}
                    >
                      Create rule
                    </button>
                    <button
                      disabled={connectorKind || offlineMachine}
                      onClick={() => editFromDraft(draft, item.id)}
                    >
                      Edit in form
                    </button>
                    <button
                      className="pt-quiet"
                      onClick={() =>
                        setThread((t) =>
                          t.map((x) => (x.id === item.id ? { ...x, consumed: true } : x)),
                        )
                      }
                    >
                      Cancel
                    </button>
                  </div>
                )}
              </div>
            )
          })}
        </div>
        <PillComposer onSubmit={submitPill} />
      </div>
    </div>
  )
}
