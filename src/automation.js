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

// The dirty test lives in form-dirty.js now, because the endpoint editor asks
// the same question and a second copy would drift. Re-exported here so the
// rule editor's import keeps reading as automation's own.
export { formDiffers } from './form-dirty.js'
