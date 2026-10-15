import assert from 'node:assert/strict'
import test from 'node:test'
import { modelMaker } from './model-maker.js'

test('a single-maker harness answers for its bare pick words', () => {
  assert.equal(modelMaker('claude', 'opus'), 'claude')
  assert.equal(modelMaker('claude', 'sonnet'), 'claude')
  assert.equal(modelMaker('claude', 'default'), 'claude')
  assert.equal(modelMaker('codex', 'gpt-5.2-codex'), 'openai')
  assert.equal(modelMaker('grok', 'grok-4.7'), 'xai')
  assert.equal(modelMaker('grok', 'default'), 'xai')
  assert.equal(modelMaker('agy', 'default'), 'gemini')
  assert.equal(modelMaker('agy', 'gemini-3-pro'), 'gemini')
})

test('the id spelling wins over the harness - a mixed catalog resolves per row', () => {
  // opencode mounts any maker's models; each row answers by its own id.
  assert.equal(modelMaker('opencode', 'claude-opus-4-5'), 'claude')
  assert.equal(modelMaker('opencode', 'gpt-5.2'), 'openai')
  assert.equal(modelMaker('opencode', 'grok-4'), 'xai')
  assert.equal(modelMaker('opencode', 'deepseek-v3'), 'deepseek')
  assert.equal(modelMaker('opencode', 'qwen3-coder'), 'qwen')
  assert.equal(modelMaker('opencode', 'kimi-k2'), 'kimi')
  assert.equal(modelMaker('opencode', 'moonshot-v1-128k'), 'kimi')
  assert.equal(modelMaker('opencode', 'codestral-latest'), 'mistral')
  assert.equal(modelMaker('opencode', 'mistral-large-latest'), 'mistral')
  assert.equal(modelMaker('opencode', 'llama-3.3-70b'), 'meta')
  assert.equal(modelMaker('opencode', 'meta-llama-4'), 'meta')
  // The resolved id counts too - claude reports both spellings.
  assert.equal(modelMaker('claude', 'opus', 'claude-opus-5-5'), 'claude')
  assert.equal(modelMaker('opencode', 'opus', 'claude-opus-5-5'), 'claude')
})

test('letter prefixes match whole words only - one maker never eats another', () => {
  assert.equal(modelMaker('opencode', 'o3-mini'), 'openai')
  assert.equal(modelMaker('opencode', 'o4-mini'), 'openai')
  // `qwen` starts with no o-prefix; a made-up id answers null.
  assert.equal(modelMaker('opencode', 'qwen-2.5'), 'qwen')
  assert.equal(modelMaker('opencode', 'qwen3-coder'), 'qwen')
  assert.equal(modelMaker('opencode', 'zarness-7'), null)
  // A letter extends the word: `one1` is not o1, `metabase-…` is not Meta's.
  assert.equal(modelMaker('opencode', 'one1'), null)
  assert.equal(modelMaker('opencode', 'metabase-embedding'), null)
})

test('an unknown harness with bare words answers null - text alone, never a wrong mark', () => {
  assert.equal(modelMaker('opencode', 'default'), null)
  assert.equal(modelMaker('pi', 'default'), null)
  assert.equal(modelMaker(null, null), null)
  assert.equal(modelMaker('claude', null), 'claude')
})
