// `tauri dev` with the dev build's own identity.
//
// The desktop shell names its single-instance mutex after the bundle
// identifier (tauri-plugin-single-instance). A dev build that carries the
// release identifier therefore cannot start while the installed app is
// running: it finds that mutex, forwards its arguments to the running
// window and exits, so the terminal shows a clean exit and no dev window
// ever appears. The override below changes the identifier for this run
// only; the release value in tauri.conf.json is never touched, so a
// packaged build keeps the identity its installers and updates use.
//
// The dev app also gets its own local data dir from this, which is what a
// dev build wants anyway: its own browser profile and its own tray
// preference instead of the user's.
//
// Usage: node scripts/dev-app.mjs [tauri dev arguments...]
// The npm script that should call this is `"tauri:dev": "node
// scripts/dev-app.mjs"`; `npx tauri dev` on its own bypasses the override.
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const cli = path.join(root, 'node_modules', '@tauri-apps', 'cli', 'tauri.js')
const override = path.join(root, 'src-tauri', 'tauri.dev.conf.json')

if (!existsSync(cli)) {
  console.error(`tauri dev: the CLI is not installed (${cli}) - run npm install first`)
  process.exit(1)
}
if (!existsSync(override)) {
  // Without the override this would start the app with the release
  // identifier, which is the failure this script exists to prevent.
  console.error(`tauri dev: ${override} is missing - the dev identity has nowhere to come from`)
  process.exit(1)
}

const child = spawn(
  process.execPath,
  [cli, 'dev', '--config', override, ...process.argv.slice(2)],
  { cwd: root, stdio: 'inherit' },
)
child.on('close', (code, signal) => {
  process.exit(code ?? (signal ? 1 : 0))
})
