// The endpoint form's pre-flight checks: the base URL cases the console can
// judge without asking the daemon. A typo here used to cost a request and come
// back as a sentence that named no field.

import assert from 'node:assert/strict'
import test from 'node:test'
import { checkBaseUrl } from './endpoint-form.js'

test('a well-formed address passes, with or without a path', () => {
  assert.equal(checkBaseUrl('http://localhost:4000'), null)
  assert.equal(checkBaseUrl('http://localhost:4000/v1'), null)
  assert.equal(checkBaseUrl(' https://gateway.example.com/openai/v1 '), null)
})

test('a missing scheme is named before the request', () => {
  // The one people type: host and port, no scheme.
  assert.match(checkBaseUrl('localhost:4000/v1'), /http:\/\/ or https:\/\//)
  assert.match(checkBaseUrl('gateway.example.com'), /http:\/\/ or https:\/\//)
})

test('an empty address asks for one', () => {
  assert.equal(checkBaseUrl(''), 'A base URL is required.')
  assert.equal(checkBaseUrl('   '), 'A base URL is required.')
  assert.equal(checkBaseUrl(null), 'A base URL is required.')
})

test('text that is not a URL at all is refused', () => {
  assert.match(checkBaseUrl('http://'), /no host|not a URL/)
  assert.match(checkBaseUrl('http:// /v1'), /no host|not a URL/)
})
