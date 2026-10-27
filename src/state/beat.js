// The sidebar poll's policy, kept pure so the rule is tested instead of the
// hook. Three questions live here: which lists a beat must hear from before
// it can call the daemon alive, when three beats with no answer mean the
// daemon is gone, and how the beats are spaced so a slow daemon is never
// asked again before it has answered the last ask.
//
// `createBeatLoop` is a plain state machine over an injected timer, which is
// what makes the cadence and the one-beat-at-a-time rule testable with the
// runner's mocked timers (see beat.test.js) rather than with sleeps.

// The lists that decide whether a beat heard from the daemon at all. One of
// them answering is enough to keep the banner off: a daemon whose machines
// route throws while its sessions answer is a busy daemon, not a gone one,
// and the next beat reads whichever route was unhappy. The other calls a beat
// makes ride along and never decide this - it is the rule the bare interval
// kept inline, moved here so it can be tested.
export const BEAT_LISTS = ['sessions', 'machines', 'mcpServers', 'automations']

// The beat interval, in ms. Measured from the previous beat settling, not
// from its start: a slow daemon then gets its answer read before the next
// ask, where a fixed interval stacked a second and third beat on top of the
// first and made the slowness worse. A healthy daemon answers in
// milliseconds, so the spacing a user feels is the same.
export const BEAT_INTERVAL_MS = 2500

// Consecutive beats with no answer before the connection is called dead.
// Three beats is about 7.5 s: long enough that one wedged request is not an
// incident, short enough that the banner is on screen while the user is
// still looking at it. One of the four lists answering is enough to keep the
// banner off, so only a beat where all four were silent counts as a miss -
// that is why a partly failing daemon heals rather than flashing an error.
export const MISSES_TO_BANNER = 3

/// What one settled beat heard, from the shape `Promise.allSettled` returns.
/// `answered` is the only field the banner rule reads; `failed` is the list
/// the caller can log or surface, so a single route that throws every beat
/// is not invisible.
export function classifyBeat(results) {
  const seen = results ?? {}
  const answered = BEAT_LISTS.some((name) => seen[name]?.status === 'fulfilled')
  const failed = Object.keys(seen).filter((name) => seen[name]?.status !== 'fulfilled')
  return { answered, failed }
}

/// The connection after a beat, given the connection before it. Returns the
/// miss count to carry and the state to set (`null` leaves it alone), which
/// is exactly the rule the bare interval used to keep inline: an answered
/// beat clears the count and revives an error connection; the third beat
/// with no answer at all is the one that reports the daemon gone, and only
/// from `connected` (a first-run `connecting` state is not an incident).
export function nextConnection(connection, { answered, misses }, threshold = MISSES_TO_BANNER) {
  if (answered) {
    return { misses: 0, state: connection === 'error' ? 'connected' : null }
  }
  const carried = misses + 1
  const gone = carried >= threshold && connection === 'connected'
  return { misses: carried, state: gone ? 'error' : null }
}

/// One poll loop: run a beat, report what it heard, schedule the next one
/// after it settles. `run` returns the allSettled shape; `onBeat` receives
/// `{ answered, failed, misses, connection }` where `connection` is the
/// state to set or null; `currentConnection` is read at settle time so the
/// loop never disagrees with the hook's own state.
///
/// `kick` is the waiting screen's retry: it runs a beat now, but it takes
/// the pending timer's place instead of adding a second loop, and it does
/// nothing while a beat is in flight.
export function createBeatLoop({
  run,
  onBeat,
  currentConnection = () => 'connected',
  intervalMs = BEAT_INTERVAL_MS,
  threshold = MISSES_TO_BANNER,
  setTimer = (fn, ms) => setTimeout(fn, ms),
  clearTimer = (id) => clearTimeout(id),
} = {}) {
  let timer = null
  let stopped = false
  let inFlight = false
  let misses = 0

  const state = () => ({ misses, inFlight, stopped, scheduled: timer != null })

  async function beat() {
    // The guard is what keeps a slow daemon from being asked again before
    // it answered: a beat only ever starts from a settled predecessor.
    if (stopped || inFlight) return
    inFlight = true
    let results = null
    try {
      results = await run()
    } catch {
      // A poll that throws is a poll that heard nothing; the banner rule
      // handles it the way it handles a daemon that answered nothing.
      results = null
    } finally {
      inFlight = false
    }
    if (stopped) return
    const health = classifyBeat(results)
    const verdict = nextConnection(currentConnection(), { answered: health.answered, misses }, threshold)
    misses = verdict.misses
    onBeat?.({ ...health, misses, connection: verdict.state })
    schedule()
  }

  function schedule() {
    if (stopped || timer != null) return
    timer = setTimer(() => {
      timer = null
      beat()
    }, intervalMs)
  }

  return {
    start() {
      schedule()
    },
    kick() {
      if (stopped) return
      if (timer != null) {
        clearTimer(timer)
        timer = null
      }
      beat()
    },
    stop() {
      stopped = true
      if (timer != null) clearTimer(timer)
      timer = null
    },
    state,
  }
}
