// What a harness switch keeps. A different harness is a different model
// catalog and often a different permission vocabulary, so some of what the
// person set cannot come with it. Clearing it silently is how a rule ends up
// saving on a model nobody chose; this module decides what carries, and the
// one line that says what did not.
//
// The words themselves come from the daemon's own capability rows (the
// registry's per-harness permission modes), never from a list kept here.

import { findModel } from './model-display.js'

/**
 * What survives a switch to `next`, and what does not.
 *
 * `current` is `{ model, permission }` - either may be null. `next` is
 * `{ models, permissionModes }`: the harness's own offer as the console knows
 * it at the moment of the switch. `models` may be null while the new catalog
 * is still being read; an unknown catalog carries no model, and
 * restoreFromCatalog puts one back if the answer turns up the same row.
 */
export function carrySetup(current, next) {
  const kept = { model: null, permission: null }
  const dropped = []
  if (current?.model) {
    if (findModel(next?.models, current.model)) kept.model = current.model
    else dropped.push('model')
  }
  if (current?.permission) {
    if ((next?.permissionModes ?? []).includes(current.permission)) {
      kept.permission = current.permission
    } else {
      dropped.push('permission')
    }
  }
  return { kept, dropped }
}

/**
 * A model a switch had to drop, if the new catalog turns out to carry the very
 * same row after all. The catalog arrives a beat after the switch, and a
 * person who picked "Opus" should not lose it just because the answer was
 * still in flight when they changed harness.
 */
export function restoreFromCatalog(model, models) {
  if (!model) return null
  return findModel(models, model) ? model : null
}

const NOUN = {
  model: 'model',
  permission: 'permission word',
  effort: 'effort',
  fast: 'fast mode',
  endpoint: 'custom endpoint',
}

/** One line naming what did not come across, or null when everything did. */
export function droppedLine(dropped, harnessName) {
  const keys = (dropped ?? []).filter((key) => key in NOUN)
  if (keys.length === 0) return null
  const words = keys.map((key) => NOUN[key])
  const joined =
    words.length === 1 ? words[0] : `${words.slice(0, -1).join(', ')} and ${words[words.length - 1]}`
  const who = harnessName ? `${harnessName} ` : 'This harness '
  return `${who}does not use that ${joined}: the switch cleared it, so pick again below.`
}
