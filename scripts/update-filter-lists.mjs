// Refreshes the filter lists that ship with the app (src-tauri/filters/):
// EasyList and EasyPrivacy as their publisher serves them today, brotli-
// compressed. They are only the starting point for ad and tracker
// blocking, which stays off until the user turns it on: once it is on,
// the daemon fetches fresh copies itself and refreshes them weekly.
//   node scripts/update-filter-lists.mjs
// Run it when making a release. EasyList and EasyPrivacy are dual-licensed
// (GPL-3.0-or-later or CC BY-SA 3.0 or later); THIRD-PARTY_NOTICES.md says
// how they are used.
import { mkdirSync, writeFileSync } from 'node:fs'
import { get } from 'node:https'
import { brotliCompressSync, constants } from 'node:zlib'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const out = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'src-tauri', 'filters')

const LISTS = [
  { id: 'easylist', url: 'https://easylist.to/easylist/easylist.txt' },
  { id: 'easyprivacy', url: 'https://easylist.to/easylist/easyprivacy.txt' },
]

// node:https rather than fetch: the publisher's chunked answers trip an
// assertion in the bundled fetch client.
function download(url) {
  return new Promise((resolve, reject) => {
    get(url, (response) => {
      if (response.statusCode !== 200) {
        response.resume()
        reject(new Error(`${url} answered ${response.statusCode}`))
        return
      }
      const parts = []
      response.on('data', (part) => parts.push(part))
      response.on('end', () => resolve(Buffer.concat(parts).toString('utf8')))
      response.on('error', reject)
    }).on('error', reject)
  })
}

mkdirSync(out, { recursive: true })
for (const { id, url } of LISTS) {
  const text = await download(url)
  // A filter list opens with its format line; anything else is an error
  // or a sign-in page, which must never end up in an installer.
  if (!text.trimStart().startsWith('[Adblock') || text.length < 100_000) {
    throw new Error(`${url} did not come back as a filter list`)
  }
  const packed = brotliCompressSync(Buffer.from(text), {
    params: {
      [constants.BROTLI_PARAM_QUALITY]: 11,
      [constants.BROTLI_PARAM_LGWIN]: 24,
      [constants.BROTLI_PARAM_SIZE_HINT]: text.length,
    },
  })
  writeFileSync(path.join(out, `${id}.txt.br`), packed)
  const version = /^! Version: (\S+)/m.exec(text)?.[1] ?? 'unknown'
  console.log(`${id}: version ${version}, ${text.length} bytes -> ${packed.length} bytes`)
}
