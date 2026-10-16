import assert from 'node:assert/strict'
import test from 'node:test'
import { completion, internalPage, omnibox, security } from './browser-omnibox.js'
import { closeTab, cycle, insertAfter, newTab, restoredTabs, sessionOf, tabTitle, toDiscard } from './browser-tabs.js'
import { covered } from './browser-occlusion.js'
import { DEVICES, fileName, fileUrl, fitDevice, nextZoom, permissionRows, zoomLabel } from './browser-chrome.js'
import { positionAt, stepPosition } from './browser-bookmarks.js'
import { keyEventInit } from './browser-keys.js'
import { comboFromEvent, rebind, scopedBindings } from './shortcuts.js'
import { findDevServers } from './devservers.js'

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

test("the browser's own pages are addresses of their own, and typing completes inline", () => {
  assert.equal(internalPage('openremote://history'), 'history')
  assert.equal(internalPage(' openremote://Bookmarks/ '), 'bookmarks')
  assert.equal(internalPage('openremote://nope'), null)
  assert.equal(omnibox('openremote://downloads'), 'openremote://downloads')
  assert.equal(completion('git', 'https://github.com/tauri-apps/tauri'), 'github.com')
  assert.equal(completion('github.com/t', 'https://www.github.com/tauri-apps/tauri'), 'github.com/tauri-apps/tauri')
  assert.equal(completion('www.gi', 'https://github.com/'), 'www.github.com')
  assert.equal(completion('how to', 'https://howto.example/'), null)
  assert.equal(completion('github.com', 'https://github.com/'), null)
})

test('a session saves every tab but private ones, and comes back as entries', () => {
  const [a, p, b, blank] = [newTab({ url: 'https://a.test/', title: 'A' }), newTab({ url: 'https://p.test/', private: true }), newTab({ url: 'openremote://history', title: 'History' }), newTab()]
  const saved = sessionOf([a, p, b, blank], b.key)
  assert.deepEqual(saved, { tabs: [{ url: 'https://a.test/', title: 'A' }, { url: 'openremote://history', title: 'History' }], active: 1 })
  const back = restoredTabs(saved)
  assert.deepEqual(back.tabs.map((t) => [t.url, t.native]), [['https://a.test/', null], ['openremote://history', null]])
  assert.equal(back.active, 1)
  assert.deepEqual(restoredTabs({ tabs: [{ url: 'javascript:alert(1)' }, 7], active: 9 }), { tabs: [], active: 0 })
})

test('past ten open pages the least recently shown go, never an agent tab, a private one or the one on screen', () => {
  const tabs = Array.from({ length: 12 }, (_, i) => newTab({ native: `tab-${i}`, seen: i }))
  tabs[0].controller = { kind: 'agent', chat: 'c', title: 'A chat' }
  tabs[1].private = true
  assert.deepEqual(toDiscard(tabs, tabs[2].key).map((t) => t.native), ['tab-3', 'tab-4'])
  assert.deepEqual(toDiscard(tabs.slice(0, 10), tabs[2].key), [])
})

test('bookmarks move between their neighbours', () => {
  const marks = [1, 2, 3].map((n) => ({ id: `m${n}`, url: `https://${n}.test/`, folder: 'bar', position: n }))
  assert.equal(positionAt(marks, 0), 0)
  assert.equal(positionAt(marks, 1), 1.5)
  assert.equal(positionAt(marks, 3), 4)
  assert.equal(positionAt([], 0), 1)
  assert.equal(stepPosition(marks, marks[1], -1), 0)
  assert.equal(stepPosition(marks, marks[1], 1), 4)
  assert.equal(stepPosition(marks, marks[0], -1), null)
})

test("a page's keys replay as the keypress they were", () => {
  for (const chord of ['Mod+T', 'Mod+Shift+T', 'Alt+Left', 'F5', 'Mod+/', 'Mod+,', 'Mod+=', 'Mod+-', 'Mod+0', 'Mod+Shift+Tab']) {
    assert.equal(comboFromEvent(keyEventInit(chord), false), chord)
  }
  assert.equal(comboFromEvent(keyEventInit('Mod+T', true), true), 'Mod+T')
})

test("the browser's keys share the app's but never take them", () => {
  const live = scopedBindings({})
  assert.equal(live.app['close-pane'], 'Mod+W')
  assert.equal(live.browser['browser-close-tab'], 'Mod+W')
  // A browser key taken by another browser action moves within the browser only.
  const { overrides, displaced } = rebind({}, 'browser-history', 'Mod+W')
  assert.deepEqual(displaced, ['browser-close-tab'])
  assert.equal(scopedBindings(overrides).app['close-pane'], 'Mod+W')
})

test('remembered permissions list by site; files and dev servers read plainly', () => {
  const rows = permissionRows({ 'https://b.test|camera': 'allow', 'https://a.test|geolocation': 'deny', 'https://a.test|midi': null })
  assert.deepEqual(rows.map((r) => `${r.origin} ${r.kind} ${r.state}`), ['https://a.test geolocation deny', 'https://b.test camera allow'])
  assert.equal(permissionRows({ 'https://b.test|camera': 'allow' }, 'https://a.test').length, 0)
  assert.equal(fileUrl('C:\\Users\\me\\a b.pdf'), 'file:///C:/Users/me/a%20b.pdf')
  assert.equal(fileUrl('/home/me/a.pdf'), 'file:///home/me/a.pdf')
  assert.deepEqual(
    findDevServers('Ready on http://0.0.0.0:3000. Also http://localhost:5173/app, and http://localhost:5173/app').map((d) => d.url),
    ['http://localhost:3000', 'http://localhost:5173/app'],
  )
})
