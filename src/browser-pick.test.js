import test from 'node:test'
import assert from 'node:assert/strict'
import { PICKER_CANCEL, PICKER_SOURCE, formatPicked } from './browser-pick.js'

test('the picker stands down on Esc or a cancel flag', () => {
  assert.match(PICKER_SOURCE, /Escape/)
  assert.match(PICKER_SOURCE, /__orPickCancel/)
  assert.match(PICKER_SOURCE, /__orPicking/)
})

test('the cancel line sets the cancel flag', () => {
  assert.match(PICKER_CANCEL, /__orPickCancel = true/)
})

test('a pick formats to the page and the element with its words', () => {
  const out = formatPicked({
    url: 'https://example.com/pricing',
    title: 'Example Pricing',
    selector: 'main > div.plan.pro',
    tag: 'div',
    text: '$20 per seat per month',
    href: null,
  })
  assert.equal(out, 'On “Example Pricing” (https://example.com/pricing):\ndiv main > div.plan.pro — “$20 per seat per month”')
})

test('a link pick carries where it goes', () => {
  const out = formatPicked({
    url: 'https://example.com/',
    title: 'Example',
    selector: 'a.cta',
    tag: 'a',
    text: 'Get started',
    href: 'https://example.com/signup',
  })
  assert.ok(out.includes('→ https://example.com/signup'))
})

test('a wordless element formats to its address alone', () => {
  const out = formatPicked({ url: 'https://x.test/', title: '', selector: 'canvas', tag: 'canvas', text: '   ' })
  assert.equal(out, 'On “a page” (https://x.test/):\ncanvas canvas')
})

test('long words are clipped', () => {
  const out = formatPicked({ url: 'https://x.test/', title: 'T', selector: 'p', tag: 'p', text: 'w'.repeat(400) })
  assert.ok(out.length < 'w'.repeat(400).length + 100)
  assert.match(out, /…/)
})
