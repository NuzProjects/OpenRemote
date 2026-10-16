#!/usr/bin/env node
// The toy CLI: a stand-in for a real command-line agent. It runs once per
// prompt, prints what it does as JSON lines, and exits - the shape many
// agent CLIs have in their print mode. plugin.js wraps it as a harness.
//
//   node toy-cli.js --model toy-echo [--loud] [--greeting Hello] -- <prompt>
//
// Each line it prints is one of:
//   {"kind": "thinking", "text": ...}
//   {"kind": "tool", "name": ..., "input": {...}, "output": ...}
//   {"kind": "reply", "text": ...}

const args = process.argv.slice(2)
const split = args.indexOf('--')
const flags = split === -1 ? args : args.slice(0, split)
const prompt = split === -1 ? '' : args.slice(split + 1).join(' ')
const flag = (name, fallback) => {
  const at = flags.indexOf(name)
  return at === -1 ? fallback : flags[at + 1]
}
const model = flag('--model', 'toy-echo')
const greeting = flag('--greeting', 'Hello')
const loud = flags.includes('--loud')

const say = (line) => process.stdout.write(JSON.stringify(line) + '\n')
const words = prompt.trim() ? prompt.trim().split(/\s+/).length : 0

say({ kind: 'thinking', text: `Reading the prompt: ${words} word${words === 1 ? '' : 's'}.` })
say({
  kind: 'tool',
  name: 'count_words',
  input: { text: prompt },
  output: `${words} words`,
})
// The toy "thinks" for a moment, so an interrupt has something to stop.
setTimeout(() => {
  let reply = model === 'toy-mirror' ? [...prompt].reverse().join('') : prompt
  if (loud) reply = reply.toUpperCase()
  say({ kind: 'reply', text: `${greeting}! ${reply}` })
}, 400)
