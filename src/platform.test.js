import assert from 'node:assert/strict'
import test from 'node:test'
import { openExternal, webLink } from './platform.js'

test('only a web address counts as a link', () => {
  assert.equal(webLink('https://github.com/owner/plugin'), 'https://github.com/owner/plugin')
  assert.equal(webLink('http://example.com'), 'http://example.com')
  assert.equal(webLink('HTTPS://EXAMPLE.COM/A'), 'HTTPS://EXAMPLE.COM/A')
  // Trimmed, since catalog text often carries a stray space.
  assert.equal(webLink('  https://example.com  '), 'https://example.com')
  // Not pages: a local file, a scheme some program on the machine claims,
  // script, a bare host, and nothing at all.
  for (const not of [
    'file:///C:/Windows/System32/calc.exe',
    'vscode://open?x',
    'ms-settings:',
    'javascript:alert(1)',
    'data:text/html,x',
    'github.com/owner',
    'https://',
    '',
    null,
    undefined,
  ]) {
    assert.equal(webLink(not), null, String(not))
  }
})

test('opening a page passes the address on, and anything else is refused', async () => {
  const opened = []
  globalThis.window = { open: (url) => opened.push(url) }
  try {
    // True is "a browser took it": the caller uses it to decide whether the
    // link still has to be offered by hand.
    assert.equal(await openExternal('https://example.com/plugin'), true)
    // A homepage a catalog could name: never handed to the OS handler,
    // and the caller is told rather than left believing it opened.
    for (const refused of ['file:///C:/Windows/System32/calc.exe', 'vscode://open?x']) {
      await assert.rejects(() => openExternal(refused), /is not a web address/)
    }
  } finally {
    delete globalThis.window
  }
  assert.deepEqual(opened, ['https://example.com/plugin'])
})

test('a blocked popup is reported, not assumed', async () => {
  globalThis.window = { open: () => null }
  try {
    assert.equal(await openExternal('https://example.com/plugin'), false)
  } finally {
    delete globalThis.window
  }
})
