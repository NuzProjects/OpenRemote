// Privacy mode's live flag, for the one thing the blur in privacy.css
// cannot reach: a native hover tooltip. A `title` carrying a name or a
// path would show it in plain text over a blurred row, so components
// drop such titles while the mode is on. The flag is read from the
// html attribute settings.js sets, so every path that flips the mode -
// the Settings switch, the boot restore - is seen without a second
// source of truth.

import { useSyncExternalStore } from 'react'

function subscribe(onChange) {
  const observer = new MutationObserver(onChange)
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-privacy'] })
  return () => observer.disconnect()
}

const snapshot = () => document.documentElement.hasAttribute('data-privacy')

export function usePrivacyMode() {
  return useSyncExternalStore(subscribe, snapshot, () => false)
}
