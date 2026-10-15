// New-task defaults: what the composer starts with. Console-side facts,
// persisted locally - they preselect, never constrain.

const KEY = 'openremote-defaults'

export function loadDefaults() {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? '{}')
    const harness = typeof raw.harness === 'string' ? raw.harness : null
    const wordMap = (value) =>
      value && typeof value === 'object' && !Array.isArray(value)
        ? Object.fromEntries(
            Object.entries(value).filter(
              ([id, word]) => typeof id === 'string' && typeof word === 'string',
            ),
          )
        : {}
    return {
      harness,
      model: typeof raw.model === 'string' ? raw.model : null,
      efforts: wordMap(raw.efforts),
      permissions: wordMap(raw.permissions),
    }
  } catch {
    return { harness: null, model: null, efforts: {}, permissions: {} }
  }
}

export function saveDefaults(partial) {
  try {
    localStorage.setItem(KEY, JSON.stringify({ ...loadDefaults(), ...partial }))
  } catch {
    /* storage unavailable */
  }
}
