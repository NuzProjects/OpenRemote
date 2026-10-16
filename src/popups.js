// The views that open over the app instead of in a pane: Settings,
// Metrics and Mobile. Anything can ask for one (the sidebar, a shortcut,
// the palette, the browser's openremote://settings); the app shows it.

export const POPUP_VIEWS = ['settings', 'metrics', 'mobile']

const listeners = new Set()

export function openPopup(name, options = {}) {
  for (const fn of listeners) fn(name, options)
}

export function onPopup(fn) {
  listeners.add(fn)
  return () => listeners.delete(fn)
}
