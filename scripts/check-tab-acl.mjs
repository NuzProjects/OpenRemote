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
// The other direction, added after a command was written into two files by
// hand with nothing to fail when the next one lands in only one of them: a
// command declared in `build.rs` and granted by no capability is refused at
// runtime, which the user meets as a button that does nothing. So every
// command in the shell's list must be granted somewhere. "Somewhere" is the
// union of the capability files and the inline ones: `open_url` is granted by
// the phone's file and deliberately not by the console's, and a check that
// read a single file would call that correct tree a failure.
//
// What the two halves prove between them: every grant is scoped to the
// console's webview, and every declared command is granted by at least one
// capability. What neither proves: that a grant is not wider than the command
// needs, that the console only calls commands declared here (both halves read
// the shell's declaration, not the call sites), or that the Rust side of a
// command does what its name promises.
//
// Usage: node scripts/check-tab-acl.mjs [--root <dir>] [--self-test]
//
// `--root` exists so the check can be pointed at a copy of the tree and its
// exit code watched; the self-test below does that rather than trusting that
// a function returning failures would have printed them.
import { spawnSync } from 'node:child_process'
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

// Rooted at this file, not at the working directory: the self-test runs the
// same check against a copy of the tree, and a path it changes has to be the
// copy's path.
const repo = fileURLToPath(new URL('..', import.meta.url))
const CAPS = 'src-tauri/capabilities'
const CONF = 'src-tauri/tauri.conf.json'
const BUILD = 'src-tauri/build.rs'
const phone = new Set(['android', 'iOS'])
// The console's capability, by the name this project reviews it under. The
// loop below judges only the files that are there, so a directory that still
// holds the phone's file passes here while the console's own has gone: the
// invariant holds over nothing, every command the console invokes is refused
// at runtime, and this guard prints ok.
const console_capability = 'default.json'

// One capability, from either place it can be declared.
function judge(cap, where, failures) {
  const platforms = Array.isArray(cap.platforms) ? cap.platforms : []
  const phoneOnly = platforms.length > 0 && platforms.every((platform) => phone.has(platform))
  if (phoneOnly) return

  if ('windows' in cap) {
    failures.push(
      `${where}: scoped by window (${JSON.stringify(cap.windows)}), and the browser's tabs share that window with the console; scope it with "webviews": ["main"]` +
        ' instead',
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

// The command-granting permissions one capability carries. Plugin permissions
// (`core:default`, `dialog:allow-open`) are not app commands and are left to
// the plugin that owns them.
function collect(cap, granted) {
  const permissions = Array.isArray(cap.permissions) ? cap.permissions : []
  for (const permission of permissions) {
    if (typeof permission === 'string' && permission.startsWith('allow-')) granted.add(permission)
  }
}

// Tauri turns a command name into its permission identifier this way:
// `browser_open_external` is granted by `allow-browser-open-external`.
function grantFor(command) {
  return `allow-${command.replace(/_/g, '-')}`
}

// The command names the shell declares in `build.rs`. Without the manifest
// Tauri does not check an app command against any capability at all, so this
// list is the complete set of commands that can be granted or refused.
function declared(root, failures) {
  const path = join(root, BUILD)
  let source
  try {
    source = readFileSync(path, 'utf8')
  } catch (err) {
    failures.push(`${path}: cannot be read: ${err.message}`)
    return []
  }
  const block = source.match(/const\s+COMMANDS\s*:\s*&\[&str\]\s*=\s*&\[([\s\S]*?)\]/, '')
  if (block === null) {
    failures.push(
      `${path}: no "const COMMANDS: &[&str] = &[...]" block, so the commands the app declares cannot be read and this check judges nothing`,
    )
    return []
  }
  const commands = [...block[1].matchAll(/"([^"]+)"/g)].map((match) => match[1])
  if (commands.length === 0) {
    failures.push(`${path}: declares no command, so there is nothing to grant and this check judges nothing`)
  }
  return commands
}

function checkAt(root) {
  const failures = []
  const dir = join(root, CAPS)
  const granted = new Set()

  let names = []
  try {
    names = readdirSync(dir)
      .filter((name) => name.endsWith('.json'))
      .sort()
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
    judge(cap, path, failures)
    collect(cap, granted)
  }

  // The same invariant for the ones the app config can declare inline. Their
  // grants count too: a command granted there is granted.
  const conf = join(root, CONF)
  let inline = []
  try {
    const parsed = JSON.parse(readFileSync(conf, 'utf8'))
    const list = parsed?.app?.security?.capabilities
    if (list === undefined) {
      inline = []
    } else if (!Array.isArray(list)) {
      failures.push(`${conf}: app.security.capabilities is not a list; it cannot be read as one`)
    } else {
      inline = list
    }
  } catch (err) {
    failures.push(`${conf}: cannot be read: ${err.message}`)
  }
  for (const [i, entry] of inline.entries()) {
    // A name points at a file in the directory above, which is judged there.
    if (typeof entry === 'string') continue
    if (!entry || typeof entry !== 'object') {
      failures.push(`${conf}: app.security.capabilities[${i}] is ${JSON.stringify(entry)}, not a name or a capability`)
      continue
    }
    const label = entry.identifier ? ` (${entry.identifier})` : ''
    judge(entry, `${conf}: inline capability ${i + 1}${label}`, failures)
    collect(entry, granted)
  }

  // Now the other direction: every declared command, against every grant.
  const commands = declared(root, failures)
  const missing = []
  for (const command of commands) {
    const wanted = grantFor(command)
    if (granted.has(wanted)) continue
    missing.push(command)
    failures.push(
      `${join(root, BUILD)}: declares command "${command}" and no capability grants "${wanted}"; the console's invoke of it is refused at runtime, so add that permission to ${join(dir, console_capability)} (or to the phone's file when the command is phone-only)`,
    )
  }

  return { failures, names, commands, granted, missing }
}

// Proof that the completeness check can fail, run against a copy of the tree
// so a mistake here cannot leave the real files changed: the copy passes as it
// stands, adding a declared command with no grant turns it red, and dropping a
// grant that every capability carried turns it red. The `open_url` assertion is
// the union rule made executable: that permission lives in the phone's file
// alone, and the copy still passes.
function selfTest() {
  const scratch = mkdtempSync(join(tmpdir(), 'openremote-acl-'))
  const files = [BUILD, CONF, join(CAPS, console_capability), join(CAPS, 'mobile.json')]
  const bodies = new Map()

  for (const file of files) {
    bodies.set(file, readFileSync(join(repo, file), 'utf8'))
    const path = join(scratch, file)
    mkdirSync(dirname(path), { recursive: true })
    copyFileSync(join(repo, file), path)
  }

  const reset = () => {
    for (const [file, body] of bodies) writeFileSync(join(scratch, file), body)
  }
  // The same script, as a process, against the copy: the exit code is the
  // thing every gate reads, so the exit code is the thing proved here.
  const runOn = (root) =>
    spawnSync(process.execPath, [fileURLToPath(import.meta.url), '--root', root], { stdio: 'ignore' })
  const results = []
  const expect = (what, condition, detail) => results.push({ what, ok: Boolean(condition), detail })

  const clean = checkAt(scratch)
  expect('the copy of the tree passes', clean.failures.length === 0, clean.failures.join('; '))
  const grantsOpenUrl = files
    .filter((file) => file.endsWith('.json'))
    .filter((file) => bodies.get(file).includes('"allow-open-url"'))
  expect(
    'the union, not one file: a command granted by the phone file alone still counts',
    grantsOpenUrl.length === 1 && clean.missing.length === 0,
    `granted by ${JSON.stringify(grantsOpenUrl)}`,
  )

  reset()
  writeFileSync(
    join(scratch, BUILD),
    bodies
      .get(BUILD)
      .replace('const COMMANDS: &[&str] = &[', 'const COMMANDS: &[&str] = &[\n    "ghost_command",'),
  )
  const declaredOnly = checkAt(scratch)
  expect(
    'a declared command granted nowhere turns it red',
    declaredOnly.missing.length === 1 &&
      declaredOnly.missing[0] === 'ghost_command' &&
      declaredOnly.failures.some((line) => line.includes('allow-ghost-command')),
    declaredOnly.failures.join('; '),
  )

  reset()
  for (const file of [join(CAPS, console_capability), join(CAPS, 'mobile.json')]) {
    const cap = JSON.parse(bodies.get(file))
    cap.permissions = cap.permissions.filter((permission) => permission !== 'allow-daemon-info')
    writeFileSync(join(scratch, file), `${JSON.stringify(cap, null, 2)}\n`)
  }
  const everyGrantGone = checkAt(scratch)
  expect(
    'a command whose grant is removed from every capability turns it red',
    everyGrantGone.missing.includes('daemon_info') &&
      everyGrantGone.failures.some((line) => line.includes('allow-daemon-info')),
    everyGrantGone.failures.join('; '),
  )

  reset()
  const cleanExit = runOn(scratch)
  expect('a clean copy exits 0', cleanExit.status === 0, `exit ${cleanExit.status}`)

  writeFileSync(
    join(scratch, BUILD),
    bodies
      .get(BUILD)
      .replace('const COMMANDS: &[&str] = &[', 'const COMMANDS: &[&str] = &[\n    "ghost_command",'),
  )
  const redExit = runOn(scratch)
  expect('a copy with an ungranted command exits non-zero', redExit.status !== 0, `exit ${redExit.status}`)

  reset()
  rmSync(scratch, { recursive: true, force: true })

  for (const { what, ok, detail } of results) {
    if (ok) console.log(`  ok   ${what}`)
    else console.error(`  FAIL ${what}${detail ? `: ${detail}` : ''}`)
  }
  const failed = results.filter((result) => !result.ok).length
  if (failed > 0) {
    console.error(`self-test: ${failed} of ${results.length} expectation(s) failed`)
    process.exit(1)
  }
  console.log(`self-test ok: ${results.length} expectations, the completeness check fails when it should`)
}

if (process.argv.includes('--self-test')) {
  selfTest()
} else {
  const at = process.argv.indexOf('--root')
  const root = at === -1 ? repo : process.argv[at + 1]
  if (root === undefined) {
    console.error('tab acl: --root needs a directory')
    process.exit(1)
  }
  const { failures, names, commands } = checkAt(root)
  if (failures.length > 0) {
    console.error('tab acl: the capability scope has widened, or a command has no grant:')
    for (const failure of failures) console.error(`  ${failure}`)
    process.exit(1)
  }
  console.log(
    `tab acl ok: ${names.length} capability file(s), every non-phone one scoped to the main webview, every declared command (${commands.length}) granted`,
  )
}
