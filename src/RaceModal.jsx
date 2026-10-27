// Race: one prompt into two to four harnesses, each chat in its own pane, so
// "which model does this better" is a look rather than six manual chats.
//
// The modal does the starting (it owns the prompt and the picks) and hands the
// chat ids up when the first ones exist; the window's layout is the shell's,
// so App opens the panes from race.js's plan. The rules - what is offered, what
// is refused, what the split will be - live in race.js, and this only renders
// them, so a refusal is decided before a single chat is created.

import { useRef, useState } from 'react'
import { X } from '@phosphor-icons/react'
import { useConsole } from './state/console.jsx'
import { workspaceName } from './state/reducer.js'
import { useBack } from './use-back.js'
import { useDialog } from './dialog-focus.js'
import { HarnessMark } from './brand-marks.jsx'
import Toggle from './Toggle.jsx'
import { RACE_MAX, racePlan, racePrompts } from './race.js'
import './devices.css'
import './panels.css'
import './contextmenu.css'
import './race.css'

// The sentence each refusal prints. race.js decides why; this says it in words
// the console already uses (numbers, plain sentences, no jargon).
function refusalText(refusal) {
  if (!refusal) return null
  // The list below already says this one, where the harnesses would be.
  if (refusal.code === 'no-harnesses') return null
  if (refusal.code === 'too-few' || refusal.code === 'too-many') return 'Pick two to four harnesses.'
  if (refusal.code === 'no-prompt') return 'Write the prompt every harness should answer.'
  if (refusal.code === 'no-panes') {
    return refusal.free === 1
      ? 'Only one pane is free, so a race cannot open a second chat. Close a pane first.'
      : `This window already holds ${RACE_MAX} panes. Close one to race.`
  }
  if (refusal.code === 'not-enough-panes') {
    const names = refusal.missing.join(' and ')
    return `Only ${refusal.free} pane${refusal.free === 1 ? '' : 's'} left, so ${names} cannot be added. Close a pane first.`
  }
  return null
}

export default function RaceModal({ free, onClose, onStarted }) {
  const { capabilities, createChat, sendPrompt, chats } = useConsole()
  const panelRef = useRef(null)
  const [prompt, setPrompt] = useState('')
  // The harnesses, in the order they were switched on: that order is the order
  // the panes open in, so the first one picked reads leftmost.
  const [chosen, setChosen] = useState([])
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState(null)

  // Nothing closes while the chats are being created: the work is out of the
  // user's hands by then, and a dialog that disappears mid-create reads as a
  // failure even when every chat came up.
  useBack(!busy, onClose)
  useDialog(panelRef, () => {
    if (!busy) onClose()
  })

  const plan = racePlan({
    offerable: capabilities?.harnesses ?? [],
    chosen,
    // The shell passes the window's free panes; with no number the roomiest
    // answer is assumed, and the plan still refuses on every other ground.
    free: free ?? RACE_MAX,
    prompt,
  })
  const refusal = refusalText(plan.refusal)

  // The folder every race chat starts in: the one the chat on screen runs in,
  // or the home folder, said out loud so the answer is never a surprise.
  const onScreen = typeof location === 'undefined' ? '' : location.hash.replace(/^#/, '')
  const workspace = chats?.[onScreen]?.workspace ?? null

  const toggle = (id) => {
    if (busy) return
    setFailure(null)
    setChosen((current) =>
      current.includes(id) ? current.filter((other) => other !== id) : [...current, id],
    )
  }

  const start = async () => {
    if (busy || !plan.canStart) return
    setBusy(true)
    setFailure(null)
    const calls = racePrompts(plan.chosen, prompt)
    const started = []
    let stoppedAt = null
    for (const call of calls) {
      let id = null
      try {
        // The chat first, its prompt second: a prompt that fails then leaves a
        // chat the user can see and retry in, rather than a session created off
        // screen with nothing in it.
        id = await createChat('', workspace, call.harness, null, false, null, null, {})
        started.push(id)
        await sendPrompt(id, call.text)
      } catch (err) {
        stoppedAt = { harness: call.harness, message: err?.message ?? String(err) }
        break
      }
    }
    if (started.length > 0) onStarted(started)
    if (stoppedAt) {
      // The chats that did start are on screen; this one never did. Saying so
      // here, with the count, is the only way the shortfall is not silent.
      setBusy(false)
      setFailure(
        `${plan.offerable.find((h) => h.id === stoppedAt.harness)?.name ?? stoppedAt.harness} could not start: ${stoppedAt.message} (${started.length} of ${calls.length} chats opened)`,
      )
      return
    }
    setBusy(false)
    onClose()
  }

  return (
    <div
      className="dv-modal-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !busy) onClose()
      }}
    >
      <div
        className="dv-modal race-modal"
        ref={panelRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label="Race a prompt across harnesses"
      >
        <div className="dv-modal-head">
          <h2 className="dv-modal-title">Race a prompt across harnesses</h2>
          <button className="dv-modal-close" onClick={onClose} disabled={busy} title="Close">
            <X size={14} weight="bold" />
          </button>
        </div>
        <p className="dv-modal-hint">
          One prompt, one chat per harness, side by side, so the answers compare at a glance.
          {workspace ? ` Each starts in ${workspaceName(workspace)}.` : ' Each starts in your home folder.'}
        </p>

        <label className="race-field">
          <span className="race-field-label">Prompt</span>
          <textarea
            className="race-prompt"
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder="What should every harness answer?"
            rows={3}
            autoFocus
            disabled={busy}
            spellCheck={false}
          />
        </label>

        <div className="race-label-row">
          <span>Harnesses</span>
          <span className="race-label-val">
            {plan.count} of {plan.offerable.length} chosen
          </span>
        </div>
        <div className="race-list">
          {plan.offerable.length === 0 && (
            <p className="race-empty">No harness is installed on this machine yet.</p>
          )}
          {plan.offerable.map((harness) => (
            <div key={harness.id} className="race-row">
              <HarnessMark harness={harness.id} size={15} />
              <span className="race-name pv">{harness.name}</span>
              <Toggle
                checked={chosen.includes(harness.id)}
                onChange={() => toggle(harness.id)}
                label={harness.name}
                disabled={busy}
              />
            </div>
          ))}
        </div>

        {busy && (
          <p className="race-note" role="status">
            Creating {plan.count} chats. Nothing else to press until they are up.
          </p>
        )}
        {!busy && failure && <p className="race-error">{failure}</p>}
        {!busy && !failure && refusal && <p className="race-note">{refusal}</p>}

        <div className="ctx-modal-actions">
          <button type="button" className="pn-btn" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button
            type="button"
            className="pn-btn race-start"
            onClick={start}
            disabled={busy || !plan.canStart}
            aria-busy={busy || undefined}
          >
            {busy ? `Starting ${plan.count} chats…` : plan.count >= 2 ? `Start ${plan.count} chats` : 'Start'}
          </button>
        </div>
      </div>
    </div>
  )
}
