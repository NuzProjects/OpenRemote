// A credential pasted into an address field must not be printed by the row that lists it.
import test from 'node:test'
import assert from 'node:assert/strict'

import { checkBaseUrl, redactedUrl } from './form-checks.js'

test('a base URL with credentials in it is printed without them', () => {
  // The address field validates the host, not the userinfo, so this is a URL the form
  // accepts; the endpoint row used to render it in the clear beside a masked key field.
  assert.equal(redactedUrl('https://user:secret@gateway/v1'), 'https://…@gateway/v1')
  // A username on its own is a secret too (some gateways key on it).
  assert.equal(redactedUrl('https://user@gateway/v1'), 'https://…@gateway/v1')
  // Ordinary addresses are untouched, byte for byte.
  for (const plain of [
    'http://localhost:4000',
    'https://gateway.example/v1',
    'http://127.0.0.1:8080/openai',
  ]) {
    assert.equal(redactedUrl(plain), plain)
  }
  // Nothing to redact is not an error.
  assert.equal(redactedUrl(''), '')
  assert.equal(redactedUrl(null), '')
  // And the check itself still accepts such a URL, which is why the display had to hide
  // it rather than the form refusing it.
  assert.equal(checkBaseUrl('https://user:secret@gateway/v1'), null)
})
