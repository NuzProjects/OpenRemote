// The checks a form can make without asking the daemon. Each one judges a
// shape the console knows on its own - a URL with a scheme and a host, a repo
// that is a link or an owner/name, an archive that ends in an archive
// extension - and says the reason under the field that is wrong. Anything
// about what the daemon will actually accept stays the daemon's word: these
// only refuse what certainly cannot work, so none of them can block a value
// the daemon would have taken.

/**
 * A base URL as a list row may print it. A person can paste
 * `https://user:secret@gateway/v1` into the address field, which validates fine (the
 * check below judges the host, not the userinfo), and the endpoint row then rendered it
 * in the clear beside a key field that is carefully never echoed. This keeps the shape of
 * the address and drops the credential to `@`, so a screenshot or a screen share shows
 * where the endpoint is without showing what opens it.
 */
export function redactedUrl(value) {
  const url = String(value ?? '')
  return url.replace(/^([a-z][a-z0-9+.-]*:\/\/)[^/@\s]+@/i, '$1…@')
}

/**
 * What is wrong with a base URL, or null when nothing is. The daemon needs a
 * scheme to know a transport, and a bare `localhost:4000` reads as a protocol
 * name to everything downstream - so it is refused here, before the request.
 */
export function checkBaseUrl(value) {
  const url = String(value ?? '').trim()
  if (!url) return 'A base URL is required.'
  if (!/^https?:\/\//i.test(url)) return 'Start it with http:// or https:// - the daemon needs a scheme.'
  try {
    const parsed = new URL(url)
    if (!parsed.hostname) return 'That URL names no host.'
  } catch {
    return 'That address has no host: add one after http://, for example http://localhost:4000.'
  }
  return null
}

/** What is wrong with an MCP server's command, or null. */
export function checkMcpCommand(value) {
  const command = String(value ?? '').trim()
  if (!command) return 'The command is required: the machine starts it exactly as written.'
  return null
}

const LINK = /^[a-z][a-z0-9+.-]*:\/\//i

/**
 * What is wrong with the plugin install source, given the kind it is filed
 * under. A link is not a folder, a bare word is neither a repo nor an archive,
 * and saying so here saves a round trip that comes back naming no field.
 */
export function checkSource(kind, value) {
  const source = String(value ?? '').trim()
  if (!source) return 'Say where the plugin is.'
  if (kind === 'git') {
    // A repo is a link or an owner/name on its host. A bare word is neither.
    if (LINK.test(source) || /^git@[^\s:]+:/.test(source) || /^[^\s/]+\/[^\s/]+$/.test(source)) return null
    return 'That does not name a marketplace. Paste a link to it, or its owner and name as its host writes them.'
  }
  if (kind === 'archive') {
    if (LINK.test(source) || /\.(zip|tar\.gz|tgz)$/i.test(source)) return null
    return 'That does not name an archive: a .zip or .tar.gz file, or a link to one.'
  }
  // A folder is a path on the machine. A link is certainly not one, and a
  // folder picker always produces the full path - a relative one may still be
  // right, so it is not refused.
  if (LINK.test(source)) return 'That is a link: a folder is a path on that machine - use the folder picker.'
  return null
}
