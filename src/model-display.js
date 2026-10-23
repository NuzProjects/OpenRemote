// One name for a model, everywhere a model is named. The console is
// harness-agnostic: it never parses an id's dialect, never re-cases a
// name - it asks the harness's own catalog, whose rows carry the
// harness's own display names.
//
// The lookup matches a session's model against both spellings a harness
// reports: the pick word its picker takes (`opus`) and the resolved id
// a running session reports back (`claude-opus-5-5`) - the same row
// either way. Where the catalog has no answer, the raw id shows
// verbatim: never hidden, never re-cased.

/// The catalog row for a model id, matched by pick word or resolved id.
/// The pick word wins: `default` and `opus` can resolve to the same id,
/// and a session that says `default` means the marker row, not the named
/// one it happens to run. A bare resolved id can't distinguish the two -
/// the named row is the fact, "Default (recommended)" is a pick-time
/// recommendation that no longer describes a resolved session - so the
/// named row wins there too, and the marker row only when nothing else
/// resolves to that id.
export function findModel(models, id) {
  if (!id) return null
  const rows = models ?? []
  const byPickWord = rows.find((m) => m.model === id && !m.is_default)
    ?? rows.find((m) => m.model === id)
  if (byPickWord) return byPickWord
  return rows.find((m) => m.resolved_model === id && !m.is_default) ?? null
}

/// Grok's catalog often stores the raw id in `name` (`grok-4.7`,
/// `grok-imagine-video-1.5-lite`). A readable name is title case with
/// the version numbers left as written. A name that already has spaces
/// or capitals is the harness's own words and is left alone.
export function prettyModelName(name) {
  if (!name || /[\sA-Z]/.test(name) || !name.startsWith('grok-')) return name
  return name
    .split('-')
    .filter(Boolean)
    .map((part) => (/^\d/.test(part) ? part : part.charAt(0).toUpperCase() + part.slice(1)))
    .join(' ')
}

/// The name a surface shows for a model id: the matched row's display
/// name (the harness's own words, version included where its catalog
/// carries it), else the id. A raw grok slug is shown as a readable name.
export function modelDisplayName(models, id) {
  return prettyModelName(findModel(models, id)?.display_name ?? id)
}
