// The dev build must not carry the release build's bundle identifier.
//
// The shell's single-instance plugin names its Windows mutex after the
// identifier, so a dev build with the release identifier cannot start while
// the installed app is running: it hands its arguments to that window and
// exits, and `tauri dev` looks like it did nothing. The override the dev
// script passes is the only thing keeping the two apart, so it is pinned
// here: it may change the identifier and nothing else, it must differ from
// the release one, and it must not leak into a config Tauri loads by itself
// (a platform file would change packaged builds too).

import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync, readdirSync } from 'node:fs'

const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8')
const parsed = (rel) => JSON.parse(read(rel))

test('the dev override is an identifier and nothing else', () => {
  const dev = parsed('../src-tauri/tauri.dev.conf.json')
  // $schema is editor tooling; any other key would be a release change
  // hiding in a dev-only file.
  assert.deepEqual(Object.keys(dev).sort(), ['$schema', 'identifier'])
})

test('the dev identifier is the release one plus a dev suffix', () => {
  const dev = parsed('../src-tauri/tauri.dev.conf.json')
  const release = parsed('../src-tauri/tauri.conf.json')
  assert.equal(typeof release.identifier, 'string')
  assert.notEqual(dev.identifier, release.identifier, 'the two builds would share one instance lock')
  assert.equal(dev.identifier, `${release.identifier}.dev`)
})

test('no config Tauri loads by itself carries the dev identifier', () => {
  // tauri.<platform>.conf.json is merged into every build on that platform.
  // The dev identity may only arrive through --config, which the dev script
  // passes, or a packaged build would ship under the dev identifier.
  const dev = parsed('../src-tauri/tauri.dev.conf.json')
  const files = readdirSync(new URL('../src-tauri/', import.meta.url))
    .filter((name) => /^tauri\..+\.json$/.test(name) && name !== 'tauri.dev.conf.json')
  for (const name of files) {
    const config = JSON.parse(read(`../src-tauri/${name}`))
    assert.notEqual(config.identifier, dev.identifier, `${name} must not carry the dev identifier`)
  }
})

test('the dev script is what passes the override', () => {
  const script = read('../scripts/dev-app.mjs')
  assert.match(script, /tauri\.dev\.conf\.json/)
  assert.match(script, /--config/)
  // It runs the CLI that is installed here, not a global one: a differently
  // versioned CLI is the other way a dev run stops matching the tree.
  assert.match(script, /@tauri-apps/)
})

test('a dev npm script, when there is one, goes through the dev script', () => {
  const pkg = parsed('../package.json')
  const entry = Object.entries(pkg.scripts ?? {}).find(([name]) => name === 'tauri:dev')
  if (!entry) return
  assert.match(entry[1], /dev-app\.mjs/, 'point tauri:dev at node scripts/dev-app.mjs, not at tauri dev')
})
