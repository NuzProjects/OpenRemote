// Presets for New chat: a named setup - harness, model, effort, permission
// word, project, fast - that the person saves once and picks again from a
// row of chips. Console-side and local: a preset is a preference, so it
// lives in this computer's storage rather than in the daemon, and it can
// never constrain a chat, only preselect it.
//
// A preset is a record of what was true when it was saved, and models and
// effort tiers churn with harness updates. So every read repairs what it
// can (settings.js holds the tolerant storage, this file holds the rules),
// and settling a preset against the lists a harness offers today returns
// the slots that are still true plus one calm sentence per slot that is
// not - a preset that cannot be honoured in full still applies what it can.

import { loadStoredPresets, saveStoredPresets } from './settings.js'

// Enough chips for a person to keep their few ways of working, few enough
// that the row stays a row.
export const PRESET_LIMIT = 12
// A chip has to stay one line: past this a name is a paragraph.
export const NAME_LIMIT = 60

let idCounter = 0

/** A stable id for a new preset (not a storage key: only React and deletes use it). */
export function newPresetId() {
  idCounter += 1
  const rand = globalThis.crypto?.randomUUID?.()
  return rand ? `p-${rand.slice(0, 8)}` : `p-${Date.now().toString(36)}-${idCounter}`
}

function text(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function bool(value) {
  return value === true
}

/**
 * One stored row, repaired. Returns null for a row that cannot be a preset
 * at all (no object, no harness): a preset without a harness names nothing
 * a chat could start on, so it is dropped rather than shown broken.
 */
export function normalizePreset(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const harness = text(raw.harness)
  if (!harness) return null
  const name = text(raw.name)
  return {
    id: text(raw.id) ?? newPresetId(),
    // A missing name is not damage: it is named after what it is when the
    // row is first shown, which is the same words saving would have used.
    name: name ? name.slice(0, NAME_LIMIT) : null,
    harness,
    model: text(raw.model),
    effort: text(raw.effort),
    permission: text(raw.permission),
    projectId: text(raw.projectId),
    fast: bool(raw.fast),
    default: bool(raw.default),
  }
}

/**
 * A stored list, repaired: junk dropped, ids made unique, the cap applied,
 * and at most one row still marked as the default (the first one, since a
 * second default is a damaged write rather than a second opinion).
 */
export function normalizePresets(rows) {
  const list = Array.isArray(rows) ? rows : []
  const out = []
  const seen = new Set()
  let defaulted = false
  for (const raw of list) {
    if (out.length >= PRESET_LIMIT) break
    const preset = normalizePreset(raw)
    if (!preset) continue
    if (seen.has(preset.id)) preset.id = newPresetId()
    seen.add(preset.id)
    if (preset.default && !defaulted) defaulted = true
    else preset.default = false
    out.push(preset)
  }
  return out
}

/** The presets this computer has, repaired. */
export function loadPresets() {
  return normalizePresets(loadStoredPresets())
}

/** Store the list as repaired, and answer the list that was stored. */
export function storePresets(presets) {
  const clean = normalizePresets(presets)
  saveStoredPresets(clean)
  return clean
}

/** The default preset, if one is marked: what New chat opens on. */
export function defaultPreset(presets) {
  return (presets ?? []).find((p) => p.default) ?? null
}

/**
 * What the current setup is, as a preset row. `state` carries the settled
 * values New chat already holds; an empty name is filled in by
 * suggestedPresetName at the moment of saving, so the stored row is never
 * nameless.
 */
export function presetFromState(state) {
  return normalizePreset({
    id: newPresetId(),
    name: state.name ?? null,
    harness: state.harness,
    model: state.model ?? null,
    effort: state.effort ?? null,
    permission: state.permission ?? null,
    projectId: state.projectId ?? null,
    fast: state.fast ?? false,
    default: false,
  })
}

/** Replace one preset by id, leaving the rest (and the default flag) alone. */
export function replacePreset(presets, preset) {
  const clean = normalizePreset(preset)
  if (!clean) return normalizePresets(presets)
  return normalizePresets((presets ?? []).map((p) => (p.id === clean.id ? { ...clean, default: p.default } : p)))
}

/** Drop one preset by id. Marking a default is the caller's job. */
export function removePreset(presets, id) {
  return normalizePresets((presets ?? []).filter((p) => p.id !== id))
}

/** Mark `id` as the only default, or clear the mark when id is null. */
export function markDefault(presets, id) {
  return normalizePresets((presets ?? []).map((p) => ({ ...p, default: p.id === id })))
}

/**
 * A name after what the preset is, in the words the console already shows:
 * "Opus high, this repo". Labels come from the caller so this stays pure;
 * a missing model falls back to the harness's name.
 */
export function suggestedPresetName({ modelLabel = null, harnessLabel = null, effort = null, projectLabel = null } = {}) {
  const what = modelLabel ?? harnessLabel ?? 'Chat'
  const how = effort ? ` ${effort}` : ''
  const where = projectLabel ? `, ${projectLabel}` : ''
  return `${what}${how}${where}`.slice(0, NAME_LIMIT)
}

/** One line for a chip's title: everything the preset asks for. */
export function presetSummary(preset, labels = {}) {
  if (!preset) return ''
  const parts = [labels.harnessLabel ?? preset.harness]
  if (preset.model) parts.push(labels.modelLabel ?? preset.model)
  if (preset.effort) parts.push(`${preset.effort} effort`)
  if (preset.permission) parts.push(labels.permissionLabel ?? preset.permission)
  if (preset.fast) parts.push('fast')
  if (preset.projectId) parts.push(labels.projectLabel ?? 'a project')
  return parts.join(' · ')
}

/**
 * Settle a preset against what the chosen harness offers today.
 *
 * `world` is plain data:
 *   harnesses   the harness ids installed on this computer
 *   models      the chosen harness's model rows ({ model, reasoning_efforts })
 *   permissions the chosen harness's permission words ([{ w, l }])
 *   projects    the project ids on the machine this chat will run on
 *   labels      what to call the harness, the model and the project in a sentence
 *
 * Returns the slots to apply and one sentence per slot that could not be
 * honoured. The caller applies the slots; nothing here touches storage or
 * React, so the rules are testable on their own.
 */
export function settlePreset(preset, world = {}) {
  const notes = []
  const harnessOk = preset?.harness && (world.harnesses ?? []).includes(preset.harness)
  const labels = world.labels ?? {}
  const harnessWord = labels.harnessLabel ?? preset?.harness ?? 'that harness'
  if (!preset) return { slots: null, notes: [] }
  if (!harnessOk) {
    notes.push(`Its harness is not installed on this computer any more, so this chat stays on ${labels.currentHarnessLabel ?? 'the one selected'}.`)
  }

  const models = harnessOk ? (world.models ?? []) : []
  let model = null
  if (preset.model) {
    const row = models.find((m) => m.model === preset.model)
    if (row) model = row.model
    else if (harnessOk) {
      notes.push(`${labels.modelLabel ?? preset.model} is not one ${harnessWord} lists any more, so the chat starts on its default model.`)
    }
  }

  // An effort tier belongs to the model it was picked on: with the model
  // gone, the tier has nothing to sit on, and one note is enough.
  let effort = null
  if (preset.effort) {
    const tiers = model ? (models.find((m) => m.model === model)?.reasoning_efforts ?? []) : []
    if (model && tiers.includes(preset.effort)) effort = preset.effort
    else if (model && harnessOk) {
      notes.push(`${labels.effortLabel ?? preset.effort} effort is not one that model offers any more, so the chat runs at the harness's own effort.`)
    }
  }

  let permission = null
  if (preset.permission) {
    const words = harnessOk ? (world.permissions ?? []) : []
    if (words.some((w) => w.w === preset.permission)) permission = preset.permission
    else if (harnessOk) {
      notes.push(`The approval word ${labels.permissionLabel ?? preset.permission} is not one ${harnessWord} offers any more, so the harness's own default holds.`)
    }
  }

  let projectId = null
  if (preset.projectId) {
    if ((world.projects ?? []).includes(preset.projectId)) projectId = preset.projectId
    else notes.push('Its project is not on this machine any more, so the chat starts without a workspace.')
  }

  return {
    slots: {
      harness: harnessOk ? preset.harness : null,
      model,
      effort,
      permission,
      projectId,
      fast: preset.fast === true,
    },
    notes,
  }
}
