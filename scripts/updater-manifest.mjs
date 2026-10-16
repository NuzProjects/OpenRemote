// Writes the in-app updater's latest.json for a release: each platform's
// signed update and its signature, from the .sig files the release's
// desktop builds uploaded (only builds made with the signing key have
// them). Usage: node scripts/updater-manifest.mjs <tag> <owner/repo> <sig-dir>
import { readdirSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const [tag, repo, dir] = process.argv.slice(2)
if (!tag || !repo || !dir) {
  console.error('usage: node scripts/updater-manifest.mjs <tag> <owner/repo> <sig-dir>')
  process.exit(2)
}
const version = tag.replace(/^v/, '')
const asset = (name) => `https://github.com/${repo}/releases/download/${tag}/${encodeURIComponent(name)}`
const platforms = {}
for (const sig of readdirSync(dir).filter((f) => f.endsWith('.sig'))) {
  const signature = readFileSync(join(dir, sig), 'utf8').trim()
  const file = sig.slice(0, -'.sig'.length)
  const entry = { signature, url: asset(file) }
  if (/_x64-setup\.exe$/.test(file)) platforms['windows-x86_64'] = entry
  else if (/\.app\.tar\.gz$/.test(file)) {
    // One universal app serves both Mac architectures.
    platforms['darwin-x86_64'] = entry
    platforms['darwin-aarch64'] = entry
  } else if (/\.AppImage$/.test(file)) platforms['linux-x86_64'] = entry
}
const notesFile = join('release-notes', `${tag}.md`)
const notes = existsSync(notesFile) ? readFileSync(notesFile, 'utf8').slice(0, 4000) : ''
process.stdout.write(
  `${JSON.stringify({ version, notes, pub_date: new Date().toISOString(), platforms }, null, 2)}\n`,
)
