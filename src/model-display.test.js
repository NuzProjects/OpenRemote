import { test } from 'node:test'
import assert from 'node:assert/strict'
import { findModel, modelDisplayName, prettyModelName } from './model-display.js'

// The claude catalog shape the daemon serves (observed wire, folded):
// pick words, resolved ids, and display names that carry the version.
const CLAUDE = [
  { model: 'default', resolved_model: 'claude-opus-5-5', display_name: 'Default (recommended)', is_default: true },
  { model: 'opus', resolved_model: 'claude-opus-5-5', display_name: 'Opus 5.5', is_default: false },
  { model: 'claude-fable-5-1[1m]', resolved_model: 'claude-fable-5-1[1m]', display_name: 'Fable 5.1', is_default: false },
  { model: 'sonnet', resolved_model: 'claude-sonnet-5-5', display_name: 'Sonnet 5.5', is_default: false },
]

test('a pick word finds its row and its display name', () => {
  assert.equal(modelDisplayName(CLAUDE, 'opus'), 'Opus 5.5')
  assert.equal(modelDisplayName(CLAUDE, 'sonnet'), 'Sonnet 5.5')
})

test('the resolved id a running session reports finds the same row', () => {
  // The first turn's init frame replaces the pick word with the id the
  // harness actually runs - the chip must not change its name.
  assert.equal(modelDisplayName(CLAUDE, 'claude-opus-5-5'), 'Opus 5.5')
  assert.equal(findModel(CLAUDE, 'claude-opus-5-5')?.model, 'opus')
})

test('a full id that is its own pick word matches directly', () => {
  assert.equal(modelDisplayName(CLAUDE, 'claude-fable-5-1[1m]'), 'Fable 5.1')
})

test('the default alias shows the harness recommended marker', () => {
  assert.equal(modelDisplayName(CLAUDE, 'default'), 'Default (recommended)')
})

test('an unknown non-grok id shows verbatim', () => {
  assert.equal(modelDisplayName([], 'opus'), 'opus')
  assert.equal(modelDisplayName(null, 'opus'), 'opus')
})

test('a raw grok slug shows as a readable name', () => {
  assert.equal(prettyModelName('grok-4.7'), 'Grok 4.7')
  assert.equal(prettyModelName('grok-4.20-0309-non-reasoning'), 'Grok 4.20 0309 Non Reasoning')
  assert.equal(prettyModelName('grok-4.20-multi-agent-0309'), 'Grok 4.20 Multi Agent 0309')
  assert.equal(prettyModelName('grok-build-0.1'), 'Grok Build 0.1')
  assert.equal(prettyModelName('grok-imagine-image-2.0'), 'Grok Imagine Image 2.0')
  assert.equal(prettyModelName('grok-imagine-image-quality'), 'Grok Imagine Image Quality')
  assert.equal(prettyModelName('grok-imagine-video-1.5-lite'), 'Grok Imagine Video 1.5 Lite')
  assert.equal(
    modelDisplayName([{ model: 'grok-4.7', display_name: 'grok-4.7' }], 'grok-4.7'),
    'Grok 4.7',
  )
  assert.equal(prettyModelName('Grok 4.7'), 'Grok 4.7')
})

test('a catalog without resolved ids still matches by pick word', () => {
  // codex/grok/agy rows carry no resolved id - the pick word is the id.
  const codex = [{ model: 'g-6-codex', display_name: 'GPT-6-Codex' }]
  assert.equal(modelDisplayName(codex, 'g-6-codex'), 'GPT-6-Codex')
  assert.equal(findModel(codex, 'g-6-codex')?.display_name, 'GPT-6-Codex')
})

test('a grok row without a display name still shows a readable name', () => {
  const bare = [{ model: 'grok-4-fast' }]
  assert.equal(modelDisplayName(bare, 'grok-4-fast'), 'Grok 4 Fast')
})
