// Builds the daemon and stages it as the Tauri sidecar, named with the
// host's target triple (Tauri's externalBin convention).
//   node scripts/sync-daemon.mjs            → debug daemon
//   OR_RELEASE=1 node scripts/sync-daemon.mjs → release daemon
//
// Also refreshes the dev sidecar copy under src-tauri/target when one is
// already there - `cargo tauri dev` only re-copies the sidecar when the
// app itself rebuilds, so a daemon-only change would otherwise leave the
// running dev app on the old binary until that happens.
import { execSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const release = !!process.env.OR_RELEASE
const profile = release ? 'release' : 'debug'

const triple =
  process.platform === 'win32'
    ? process.arch === 'arm64'
      ? 'aarch64-pc-windows-msvc'
      : 'x86_64-pc-windows-msvc'
    : process.platform === 'darwin'
      ? process.arch === 'arm64'
        ? 'aarch64-apple-darwin'
        : 'x86_64-apple-darwin'
      : process.arch === 'arm64'
        ? 'aarch64-unknown-linux-gnu'
        : 'x86_64-unknown-linux-gnu'

const ext = process.platform === 'win32' ? '.exe' : ''
const src = path.join(root, 'daemon', 'target', profile, `openremote-daemon${ext}`)
const dest = path.join(root, 'src-tauri', 'binaries', `openremote-daemon-${triple}${ext}`)

// Replace `to` with `from` without ever leaving a truncated file behind at
// `to`: copy to a temp name in the same directory (same filesystem, so the
// rename is a metadata change, not a byte copy), rename over the
// destination, then verify the sizes agree. An interrupted run leaves at
// most the temp file; the destination is either the old binary or the
// complete new one, never a half copy that `npx tauri dev` would happily
// spawn.
function replaceSync(from, to) {
  const tmp = `${to}.tmp`
  copyFileSync(from, tmp)
  try {
    try {
      renameSync(tmp, to)
    } catch {
      // Some Windows setups refuse to rename over an existing file even
      // though the copy is complete; removing the destination and
      // retrying is the workaround. If the destination is locked (EBUSY,
      // a running process holds it) or the retry still fails, the error
      // propagates.
      rmSync(to, { force: true })
      renameSync(tmp, to)
    }
    const copied = statSync(to).size
    const wanted = statSync(from).size
    if (copied !== wanted) {
      throw new Error(`incomplete copy: ${to} is ${copied} bytes, source is ${wanted}`)
    }
  } finally {
    // After a successful rename the temp name is gone, so this only
    // cleans up on a handled failure. Only a killed run can leave the
    // temp file behind; the next run overwrites it.
    rmSync(tmp, { force: true })
  }
}

console.log(`building daemon (${profile})…`)
execSync(`cargo build -p openremote-daemon --locked${release ? ' --release' : ''}`, {
  cwd: path.join(root, 'daemon'),
  stdio: 'inherit',
})
mkdirSync(path.dirname(dest), { recursive: true })
replaceSync(src, dest)
console.log(`staged ${dest}`)

// The dev build's own sidecar copy, if a dev build has been run before.
const devCopy = path.join(root, 'src-tauri', 'target', 'debug', `openremote-daemon${ext}`)
if (!release && existsSync(devCopy)) {
  try {
    replaceSync(src, devCopy)
    console.log(`refreshed ${devCopy} (dev sidecar)`)
  } catch (err) {
    // A running dev app locks the dev copy (the known EBUSY gotcha), or
    // the write failed some other way. The staged binaries/ copy above is
    // still the source of truth for the next app rebuild, but this
    // refresh did NOT happen: exit 1 so chained commands stop here
    // instead of proceeding on a stale dev sidecar.
    console.error(`dev sidecar ${devCopy} is locked - close the app and re-run`)
    console.error(
      'find the locking process: PowerShell Get-Process openremote-daemon, or pgrep -f openremote-daemon'
    )
    console.error(err)
    process.exitCode = 1
  }
}
