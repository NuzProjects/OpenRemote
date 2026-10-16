// The product's names for the harnesses the daemon can drive. Harness
// ids are stable; display names are the harnesses' own spellings. Each
// harness's real brand mark lives in brand-marks.jsx.

const NAMES = {
  claude: 'Claude Code',
  codex: 'Codex',
  grok: 'Grok Build',
  pi: 'Pi Agent',
  opencode: 'OpenCode',
  agy: 'Antigravity',
}

// A harness an installed plugin drives names itself: the daemon's
// capabilities carry each one's name, learned here as they load.
const LEARNED = new Map()

export function learnHarnessNames(harnesses) {
  for (const h of harnesses ?? []) {
    if (h?.plugin && h.id && h.name) LEARNED.set(h.id, h.name)
  }
}

export function harnessName(id) {
  return NAMES[id] ?? LEARNED.get(id) ?? id
}
