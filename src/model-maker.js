// Which maker's mark a model carries. The console never re-cases or
// guesses a model's identity; it asks the harness's own catalog - and
// this map answers which company's logo rides beside the name, the same
// way the harness marks do. The answer is a maker key (model-marks.jsx)
// or null: an unknown maker shows text alone, never a wrong mark.

// A single-maker harness's whole catalog is one company's: a bare pick
// word (`opus`, `default`) names no maker by itself, but the harness
// does. These harnesses answer for their entire list; the mixed ones
// (opencode, pi) carry many makers and resolve by id alone.
const HARNESS_MAKER = {
  claude: 'claude',
  codex: 'openai',
  grok: 'xai',
  agy: 'gemini',
}

// Id prefixes -> maker, in match order. Checked against both spellings
// a catalog row carries (the pick word and the resolved id),
// case-insensitive, as whole-word prefixes. The boundary rule is
// letters only: a digit may follow (qwen3, grok-4, gpt-5, o3-mini) -
// only a letter extends the word (o1 must not match one1, meta- must
// keep its hyphen against metabase).
const PREFIXES = [
  ['claude', 'claude'],
  ['anthropic', 'claude'],
  ['gpt', 'openai'],
  ['openai', 'openai'],
  ['o1', 'openai'],
  ['o3', 'openai'],
  ['o4', 'openai'],
  ['grok', 'xai'],
  ['xai', 'xai'],
  ['gemini', 'gemini'],
  ['deepseek', 'deepseek'],
  ['qwen', 'qwen'],
  ['kimi', 'kimi'],
  ['moonshot', 'kimi'],
  ['mistral', 'mistral'],
  ['codestral', 'mistral'],
  ['ministral', 'mistral'],
  ['magistral', 'mistral'],
  ['llama', 'meta'],
  ['meta-', 'meta'],
]

// A prefix that ends in its own separator (`meta-`) is its own
// boundary; a bare word prefix (`o1`, `qwen`) must not be extended by
// a letter (one1 is not o1) - a digit may follow (qwen3, grok-4).
const wordStart = (id, prefix) => {
  if (!id.startsWith(prefix)) return false
  if (id.length === prefix.length) return true
  if (!/[a-z]$/.test(prefix)) return true
  return !/[a-z]/.test(id[prefix.length])
}

function matchId(id) {
  if (!id) return null
  const lower = id.toLowerCase()
  for (const [prefix, maker] of PREFIXES) {
    if (wordStart(lower, prefix)) return maker
  }
  return null
}

/**
 * The maker of a model: the company whose logo rides beside its name.
 * The id spellings win over the harness (a grok row mounted in an
 * opencode catalog is still xAI's); the harness answers where the ids
 * are bare pick words.
 */
export function modelMaker(harness, model, resolvedModel) {
  const byId = matchId(model) ?? matchId(resolvedModel)
  if (byId) return byId
  return HARNESS_MAKER[harness] ?? null
}
