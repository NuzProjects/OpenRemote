// The tool card's shapes: which tool inputs render as what. A file edit
// is a diff (diff.js); a command run is a terminal card - the command in
// mono with its description as the caption, never a JSON dump. Kept
// pure so it's tested without a harness.

/**
 * Whether a tool input is a command run the card can render as a
 * terminal tile: a shell command string, with an optional description
 * beside it. Recognized by shape, not by tool name - every harness's
 * own Bash/shell tool carries this form, whatever it calls itself.
 */
export function isCommandRun(input) {
  if (!input || typeof input !== 'object') return false
  return typeof input.command === 'string' && input.command.length > 0
}
