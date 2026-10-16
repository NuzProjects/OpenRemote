// What the browser hands a composer (attachments.js): a picked element as
// a chip whose details ride the message as text, and pictures of the page.
// Pure: tested without a DOM.

import { hostOf } from './browser-chrome.js'

// The longest piece of an element's HTML sent along: enough to recognise
// it and its children, small enough not to crowd the message.
const HTML_LIMIT = 1500

function oneLine(text, max) {
  const flat = String(text ?? '').replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}

// An element the user picked on a page: `${role} "${name}"` on its chip;
// the details are what an agent needs to find it again.
export function elementAttachment(element = {}, image = null) {
  const role = element.role || element.tag || 'element'
  const name = oneLine(element.name || element.text, 60)
  const html = String(element.html ?? '')
  const shortHtml = html.length > HTML_LIMIT ? `${html.slice(0, HTML_LIMIT)}\n… (trimmed)` : html
  const page = [element.title, element.url && `(${element.url})`].filter(Boolean).join(' ')
  const details = [
    'An element picked in the browser:',
    `role: ${element.role || '(none)'}`,
    `name: ${oneLine(element.name, 200) || '(none)'}`,
    element.text ? `text: ${oneLine(element.text, 300)}` : null,
    element.selector ? `selector: ${element.selector}` : null,
    page ? `page: ${page}` : null,
    shortHtml ? `html:\n${shortHtml}` : null,
  ]
    .filter(Boolean)
    .join('\n')
  return {
    kind: 'element',
    label: name ? `${role} "${name}"` : role,
    details,
    url: element.url ?? '',
    title: element.title ?? '',
    ...(image ? { dataUrl: image } : {}),
  }
}

// A picture of the page (or a part of it) as an image attachment.
export function screenshotAttachment(dataUrl, url) {
  return {
    kind: 'image',
    name: `Screenshot of ${hostOf(url) || 'the page'}.jpg`,
    mime: 'image/jpeg',
    dataUrl,
  }
}
