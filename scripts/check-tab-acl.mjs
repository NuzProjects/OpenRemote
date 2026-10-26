// Guards the one capability line that keeps the app's own commands out of
// the pages the built-in browser loads. A capability scoped by window
// instead of by webview hands every tab in that window the whole command
// list, and `daemon_info` carries the daemon's bearer token.
//
// The invariant: a capability that is not phone-only is scoped to the
// console's own webview by name ("webviews": ["main"]), never by window.
// The phone app has one window and no tabs, so a window scope there is
// not a widening and its capability is exempt.
//
// If a tab ever genuinely needs its own capability, add it here on
// purpose, with the permissions that tab needs and no app command among
// them - do not widen this one.
//
// A capability can also be declared inline in the app config, in
// `app.security.capabilities`: it is not a file anyone reads as a
// capability, and nothing stops that one carrying "windows" either. The
// same rules judge it here.
//
// Usage: node scripts/check-tab-acl.mjs
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const dir = 'src-tauri/capabilities'
const conf = 'src-tauri/tauri.conf.json'
const phone = new Set(['android', 'iOS'])
// The console's capability, by the name this project reviews it under. The
// loop below judges only the files that are there, so a directory that still
// holds the phone's file passes here while the console's own has gone: the
// invariant holds over nothing, every command the console invokes is refused
// at runtime, and this guard prints ok.
const console_capability = 'default.json'
const failures = []

// One capability, from either place it can be declared.
function judge(cap, where) {
  const platforms = Array.isArray(cap.platforms) ? cap.platforms : []
  const phoneOnly = platforms.length > 0 && platforms.every((platform) => phone.has(platform))
  if (phoneOnly) return

  if ('windows' in cap) {
    failures.push(
      `${where}: scoped by window (${JSON.stringify(cap.windows)}), and the browser's tabs share that window with the console; scope it with "webviews": ["main"] instead`,
    )
  }

  const webviews = cap.webviews
  const ok = Array.isArray(webviews) && webviews.length === 1 && webviews[0] === 'main'
  if (!ok) {
    failures.push(
      `${where}: webviews is ${JSON.stringify(webviews)}, not ["main"]; only the console's own webview may hold these permissions`,
    )
  }
}

let names = []
try {
  names = readdirSync(dir).filter((name) => name.endsWith('.json')).sort()
} catch (err) {
  failures.push(`${dir}: cannot be read: ${err.message}`)
}
if (names.length === 0 && failures.length === 0) {
  failures.push(`${dir}: holds no capability file, so the console's commands have no ACL at all`)
}
if (names.length > 0 && !names.includes(console_capability)) {
  failures.push(
    `${join(dir, console_capability)}: missing; the console's commands are granted by that file alone, so deleting, moving or renaming it leaves every invoke refused with this guard still green`,
  )
}

for (const name of names) {
  const path = join(dir, name)
  let cap
  try {
    cap = JSON.parse(readFileSync(path, 'utf8'))
  } catch (err) {
    failures.push(`${path}: does not parse: ${err.message}`)
    continue
  }
  judge(cap, path)
}

// The same invariant for the ones the app config can declare inline.
let declared = []
try {
  const parsed = JSON.parse(readFileSync(conf, 'utf8'))
  const list = parsed?.app?.security?.capabilities
  if (list === undefined) {
    declared = []
  } else if (!Array.isArray(list)) {
    failures.push(`${conf}: app.security.capabilities is not a list; it cannot be read as one`)
  } else {
    declared = list
  }
} catch (err) {
  failures.push(`${conf}: cannot be read: ${err.message}`)
}
for (const [i, entry] of declared.entries()) {
  // A name points at a file in the directory above, which is judged there.
  if (typeof entry === 'string') continue
  if (!entry || typeof entry !== 'object') {
    failures.push(`${conf}: app.security.capabilities[${i}] is ${JSON.stringify(entry)}, not a name or a capability`)
    continue
  }
  const label = entry.identifier ? ` (${entry.identifier})` : ''
  judge(entry, `${conf}: inline capability ${i + 1}${label}`)
}

if (failures.length > 0) {
  console.error('tab acl: the capability scope has widened:')
  for (const failure of failures) console.error(`  ${failure}`)
  process.exit(1)
}
console.log(`tab acl ok: ${names.length} capability file(s), every non-phone one scoped to the main webview`)
