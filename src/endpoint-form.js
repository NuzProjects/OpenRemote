// The endpoint form's own checks: the things that can be told wrong without a
// round trip. Everything else stays the daemon's call; these are the cases
// where the console already knows, and letting them through used to cost a
// request and come back as a sentence that named no field.

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
    return 'That is not a URL the daemon can read.'
  }
  return null
}
