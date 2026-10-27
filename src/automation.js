// Automation vocabulary: the trigger kinds with real event sources, and
// their plain sentences. The connector-backed kinds (pipeline, errors,
// review, release) appear when their connectors do - until then the form
// offers only what can really fire.

export const KINDS = ['schedule', 'webhook']

// The kinds whose event sources still need connectors.
export const CONNECTOR_KINDS = ['pipeline', 'errors', 'review', 'release']

export function whenSentence(trigger) {
  if (trigger?.kind === 'webhook') return 'A webhook arrives'
  return `Every day at ${trigger?.time ?? '09:00'}`
}

/**
 * Whether a form's fields differ from what it opened with. The rule editor is
 * a dialog, and a dialog that closes on the same click or key as a viewer
 * throws away a half-written rule by accident; this is the test that lets the
 * backdrop and Esc stand down while there is something to lose. Compared key
 * by key over the initial snapshot so a field added later is caught by adding
 * it to the snapshot, not by remembering a second place.
 */
export function formDiffers(current, initial) {
  if (!initial || !current) return false
  return Object.keys(initial).some((key) => current[key] !== initial[key])
}
