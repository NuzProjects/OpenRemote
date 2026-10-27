// The shell's view state - where the user is in the back stack, and where in
// it. A daemon beat rewrites navigation every 2.5 s (the sessions list is the
// route list), and a fresh object handed to React re-renders the whole shell
// mid-stream even when nothing about the view changed. This comparison is the
// gate that keeps an unchanged navigation keeping its identity. Pure, so the
// rule is tested without a render.

/// Two view states are the same when they hold the same history and stand at
/// the same place in it. History is compared by value, because it is rebuilt
/// from storage on every beat and a new array of the same ids is not a change.
export function sameNav(a, b) {
  if (a === b) return true
  if (!a || !b) return false
  if (a.hIndex !== b.hIndex) return false
  const left = a.history ?? []
  const right = b.history ?? []
  if (left.length !== right.length) return false
  for (let i = 0; i < left.length; i += 1) {
    if (left[i] !== right[i]) return false
  }
  return true
}

/// What a `setNav` call should store: the object it already has when the
/// state is unchanged, so React can bail out of the re-render, and the new
/// one when it is not.
export function keepNav(previous, next) {
  return sameNav(previous, next) ? previous : next
}

/// Take the steps whose chat is known gone out of the history. A chat the
/// console has not heard of yet is not gone - the first beat after a
/// reconnect is empty, and treating that as a deletion would wipe the back
/// stack on every reconnect - so the caller names the gone ones and nothing
/// else is touched. The user keeps standing on the same view when it
/// survived, and on the nearest remaining step before it when it did not.
/// Returns the object it was given when there was nothing to prune, so a
/// beat cannot re-render the shell by rebuilding the same history.
export function pruneNav(nav, gone) {
  if (!gone || gone.size === 0) return nav
  const history = nav?.history ?? []
  if (!history.some((view) => gone.has(view))) return nav
  let hIndex = 0
  const kept = []
  for (let i = 0; i < history.length; i += 1) {
    if (gone.has(history[i])) continue
    if (i <= (nav.hIndex ?? 0)) hIndex = kept.length
    kept.push(history[i])
  }
  return { history: kept, hIndex: Math.min(hIndex, Math.max(kept.length - 1, 0)) }
}
