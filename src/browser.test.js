import assert from 'node:assert/strict'
import test from 'node:test'
import { omnibox, security } from './browser-omnibox.js'
import { closeTab, cycle, insertAfter, newTab, openBelongs, tabTitle } from './browser-tabs.js'
import { covered } from './browser-occlusion.js'
import { DEVICES, fileName, fitDevice, nextZoom, zoomLabel } from './browser-chrome.js'

test('a device size fits the page area without changing shape', () => {
  const phone = DEVICES[0]
  assert.deepEqual(fitDevice(phone, { width: 1000, height: 1000 }), { width: 393, height: 852, scale: 1 })
  const fit = fitDevice(phone, { width: 1000, height: 426 })
  assert.equal(fit.height, 426)
  assert.equal(fit.width, 197)
  assert.equal(fit.scale, 0.5)
})

test("zoom steps follow Chrome's, and reset to 100%", () => {
  assert.equal(nextZoom(1, 1), 1.1)
  assert.equal(nextZoom(1, -1), 0.9)
  assert.equal(nextZoom(5, 1), 5)
  assert.equal(nextZoom(0.25, -1), 0.25)
  assert.equal(nextZoom(1.5, 0), 1)
  assert.equal(zoomLabel(1.25), '125%')
})

test('a download is named after its file', () => {
  assert.equal(fileName('C:\\Users\\me\\Downloads\\report (1).pdf'), 'report (1).pdf')
  assert.equal(fileName('https://example.com/files/My%20Doc.zip?x=1'), 'My Doc.zip')
  assert.equal(fileName(''), 'Download')
})

test('the address bar opens addresses and searches the rest', () => {
  assert.equal(omnibox('example.com'), 'https://example.com')
  assert.equal(omnibox('github.com/morewebs/openremote'), 'https://github.com/morewebs/openremote')
  assert.equal(omnibox('https://a.dev/x?y=1'), 'https://a.dev/x?y=1')
  assert.equal(omnibox('http://example.com'), 'http://example.com')
  // the user's own dev servers: plain http
  assert.equal(omnibox('localhost:5173'), 'http://localhost:5173')
  assert.equal(omnibox('127.0.0.1:3000/api'), 'http://127.0.0.1:3000/api')
  assert.equal(omnibox('localhost'), 'http://localhost')
  // words are a search, Google by default
  assert.equal(omnibox('how to center a div'), 'https://www.google.com/search?q=how%20to%20center%20a%20div')
  assert.equal(omnibox('rust'), 'https://www.google.com/search?q=rust')
  assert.equal(omnibox('node.js streams', 'duckduckgo'), 'https://duckduckgo.com/?q=node.js%20streams')
  // nothing, or a script, opens nothing
  assert.equal(omnibox('   '), null)
  assert.equal(omnibox('javascript:alert(1)'), null)
  assert.equal(omnibox('about:blank'), 'about:blank')
})

test('the lock tells secure, local and insecure pages apart', () => {
  assert.equal(security('https://example.com'), 'secure')
  assert.equal(security('http://localhost:5173/'), 'local')
  assert.equal(security('http://example.com'), 'insecure')
  assert.equal(security(''), 'none')
})

test('closing a tab activates its right neighbour, and the last leaves a new tab', () => {
  const [a, b, c] = [newTab({ url: 'a' }), newTab({ url: 'b' }), newTab({ url: 'c' })]
  let next = closeTab([a, b, c], b.key, b.key)
  assert.deepEqual(next.tabs.map((t) => t.url), ['a', 'c'])
  assert.equal(next.active, c.key)
  assert.equal(next.closed.url, 'b')
  next = closeTab([a, b, c], c.key, c.key)
  assert.equal(next.active, b.key)
  // closing an inactive tab keeps the active one
  next = closeTab([a, b, c], a.key, c.key)
  assert.equal(next.active, c.key)
  next = closeTab([a], a.key, a.key)
  assert.equal(next.tabs.length, 1)
  assert.notEqual(next.tabs[0].key, a.key)
  assert.equal(next.active, next.tabs[0].key)
})

test('tabs cycle with wrap-around and popups land beside their opener', () => {
  const [a, b, c] = [newTab(), newTab(), newTab()]
  assert.equal(cycle([a, b, c], c.key, 1), a.key)
  assert.equal(cycle([a, b, c], a.key, -1), c.key)
  const p = newTab({ url: 'popup' })
  assert.deepEqual(insertAfter([a, b, c], p, a.key).map((t) => t.key), [a.key, p.key, b.key, c.key])
  assert.equal(tabTitle({ title: '', url: 'https://example.com/x' }), 'example.com/x')
  assert.equal(tabTitle({ title: '', url: '' }), 'New tab')
})

test('a menu overlapping the page swaps in its picture; one beside it does not', () => {
  const page = { left: 300, top: 100, right: 1200, bottom: 800, width: 900, height: 700 }
  assert.equal(covered(page, [{ left: 1100, top: 50, right: 1400, bottom: 300, width: 300, height: 250 }]), true)
  assert.equal(covered(page, [{ left: 0, top: 0, right: 280, bottom: 900, width: 280, height: 900 }]), false)
  assert.equal(covered(page, []), false)
})

test('a page that opens after its tab or its pane is gone is closed, not shown', () => {
  const [a, b] = [newTab(), newTab()]
  assert.equal(openBelongs([a, b], a.key, true), true)
  // The tab was closed while the shell was building the page.
  assert.equal(openBelongs([b], a.key, true), false)
  // The pane was closed while the shell was building the page.
  assert.equal(openBelongs([a, b], a.key, false), false)
})
