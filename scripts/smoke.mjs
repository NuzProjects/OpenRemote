// A smoke check of the running console's real DOM.
//
// Every other gate in this repo reads source text or builds it: both would
// pass on a window that renders nothing. This attaches to the dev app's
// WebView2 over the DevTools port (9333, debug builds only) and asserts the
// few things a person actually sees on first contact: the sidebar and its
// New chat tile, no crash panel, the command palette opening with its search
// field focused and its rows listed, Escape closing it and handing focus
// back, and a modal opened from the UI keeping its first field and its focus.
//
// Usage: node scripts/smoke.mjs
// Needs the dev app running in another terminal: npm run tauri:dev
// Exit 0 when every check passes, 1 when one fails (each line says which).
//
// It talks to the page the way a person does: real key and mouse events over
// the protocol, not synthetic DOM events, because the console's shortcuts and
// focus rules read trusted input. Nothing is installed; WebSocket and fetch
// come from Node itself, the same as cdp-eval.mjs.
//
// WHAT IT DOES NOT COVER: it never exercises the daemon's write path (no chat
// is created and no task is typed, so the stream and the transcript are never
// read), it opens no split pane, and it checks only first contact with the
// shell. A green run says the window, its chrome and its overlays are alive;
// it does not say the app works.

const port = process.env.OPENREMOTE_CDP_PORT ?? '9333'
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const results = []

function record(name, pass, detail) {
  results.push({ name, pass, detail })
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}`)
  if (detail) console.log(`      ${detail}`)
}

// The dev watcher restarts the app on every shell save, so the port can be
// down for a few seconds while this starts. Wait for it rather than failing
// on a rebuild that is not the console's problem.
async function targets() {
  const until = Date.now() + 60_000
  while (Date.now() < until) {
    try {
      const answer = await fetch(`http://127.0.0.1:${port}/json`).then((r) => r.json())
      if (Array.isArray(answer) && answer.length > 0) return answer
    } catch {
      /* the app is rebuilding: try again */
    }
    await sleep(1000)
  }
  return null
}

const pagesAll = await targets()
if (!pagesAll) {
  console.error(`no page on the DevTools port ${port} in 60 s - is the dev app running (npm run tauri:dev)?`)
  process.exit(1)
}
const pages = pagesAll.filter((t) => t.type === 'page' && !String(t.url).startsWith('devtools://'))
const page =
  pages.find((t) => /^(https?:\/\/127\.0\.0\.1:5175|tauri:\/\/localhost)/.test(String(t.url))) ??
  pages[0]
if (!page) {
  console.error(`no page on the DevTools port ${port} - is the dev app running?`)
  process.exit(1)
}

const ws = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((resolve, reject) => {
  ws.addEventListener('open', resolve, { once: true })
  ws.addEventListener('error', () => reject(new Error(`the DevTools connection to ${page.url} failed`)), {
    once: true,
  })
})

let nextId = 1
const waiting = new Map()
ws.addEventListener('message', (event) => {
  const message = JSON.parse(event.data)
  const settle = waiting.get(message.id)
  if (!settle) return
  waiting.delete(message.id)
  settle(message)
})

function send(method, params = {}) {
  const id = nextId++
  return new Promise((resolve) => {
    waiting.set(id, resolve)
    ws.send(JSON.stringify({ id, method, params }))
  })
}

// Evaluate in the page and answer the value. A thrown error or a rejected
// promise is a failed check, never a silent undefined.
async function evaluate(expression) {
  const message = await send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
  })
  const failure = message.result?.exceptionDetails
  if (failure) {
    throw new Error(failure.exception?.description ?? failure.text ?? 'the page threw')
  }
  return message.result?.result?.value
}

// How a person types: trusted key events, with the modifiers the page reads.
// `text` is what a printable key inserts - without it the page sees the
// keydown (enough for a shortcut) but no character reaches the field.
async function key({ key: name, code, vk, modifiers = 0, text }) {
  const base = { key: name, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers }
  await send('Input.dispatchKeyEvent', { ...base, type: 'keyDown', ...(text ? { text } : {}) })
  await send('Input.dispatchKeyEvent', { ...base, type: 'keyUp' })
}

async function click(x, y, button = 'left') {
  const base = { x, y, button, buttons: button === 'left' ? 1 : 2, clickCount: 1 }
  await send('Input.dispatchMouseEvent', { ...base, type: 'mousePressed' })
  await send('Input.dispatchMouseEvent', { ...base, type: 'mouseReleased' })
}

async function waitFor(expression, { timeout = 8000, step = 120 } = {}) {
  const until = Date.now() + timeout
  while (Date.now() < until) {
    if (await evaluate(expression)) return true
    await sleep(step)
  }
  return false
}

// The dev app starts on the wizard when its own profile has never been set
// up. The smoke needs the shell, not the tour: seed the one key the shell
// reads (App.jsx, OB_KEY) and reload. This is a dev profile only.
await evaluate(`(() => {
  if (document.querySelector('.sidebar')) return 'shell';
  if (localStorage.getItem('openremote-onboarded') === '1') return 'reload';
  localStorage.setItem('openremote-onboarded', '1');
  location.reload();
  return 'seeded';
})()`)
await sleep(500)
let shellUp = await waitFor("!!document.querySelector('.sidebar')", { timeout: 20000 })
if (!shellUp) {
  await evaluate('location.reload()')
  shellUp = await waitFor("!!document.querySelector('.sidebar')", { timeout: 20000 })
}
record(
  'the dev window reaches the shell',
  shellUp,
  shellUp
    ? `hash ${await evaluate('location.hash') || '(none)'}, ${await evaluate('document.querySelectorAll(".chat-row").length')} chat rows in the sidebar`
    : `body said: ${String(await evaluate('document.body.innerText')).slice(0, 160)}`,
)
if (!shellUp) {
  console.log('\n0 of 5 checks ran: the shell never came up')
  ws.close()
  process.exit(1)
}

// 1. The sidebar, and the New chat tile on it.
const newChat = await evaluate(`(() => {
  const sb = document.querySelector('.sidebar');
  if (!sb) return null;
  const tile = [...sb.querySelectorAll('button')].find((b) => b.textContent.trim() === 'New chat');
  if (!tile) return null;
  const r = tile.getBoundingClientRect();
  return { x: r.x + r.width / 2, y: r.y + r.height / 2, text: tile.textContent.trim(), sbClass: sb.className };
})()`)
record(
  'the sidebar exists and lists the New chat tile',
  Boolean(newChat),
  newChat ? `sidebar "className=${newChat.sbClass}", tile reads "${newChat.text}"` : 'no button reading New chat under .sidebar',
)

// Focus the tile the way a person would, so the palette has somewhere to
// return to after Escape (check 4).
if (newChat) await click(newChat.x, newChat.y)
const opener = await evaluate(`(() => {
  const a = document.activeElement;
  if (!a || a === document.body) return null;
  window.__smokeOpener = a;
  return a.textContent ? a.textContent.trim().slice(0, 40) : a.getAttribute('aria-label') || a.tagName;
})()`)

// 2. No crash panel over the window.
const boundary = await evaluate(`(() => {
  const panel = document.querySelector('.vb');
  return {
    panel: Boolean(panel),
    text: String(document.body.innerText).includes('This view could not be drawn'),
    panels: document.querySelectorAll('.vb').length,
  };
})()`)
record(
  'the view boundary panel is not on screen',
  !boundary.panel && !boundary.text,
  `${boundary.panels} .vb panel(s), the crash sentence ${boundary.text ? 'IS' : 'is not'} in the window text`,
)

// 3. The command palette: Ctrl+K, its search field focused, its rows listed.
// At rest the palette offers its suggestions (four rows on this tree) plus
// whatever Recent holds; the populated list is the searched one, so the row
// count is read after a letter, the way a person finds a chat.
await key({ key: 'k', code: 'KeyK', vk: 75, modifiers: 2 })
const paletteOpen = await waitFor("!!document.querySelector('.kb-palette')")
const atRest = paletteOpen
  ? await evaluate(`(() => {
      const input = document.querySelector('.kb-search input');
      const rows = document.querySelectorAll('.kb-item');
      return {
        rows: rows.length,
        searchFocused: document.activeElement === input,
        activeTag: document.activeElement ? document.activeElement.tagName : '(none)',
        firstRow: rows[0] ? rows[0].textContent.trim().slice(0, 60) : null,
      };
    })()`)
  : null
let searched = null
if (atRest?.searchFocused) {
  await key({ key: 'e', code: 'KeyE', vk: 69, text: 'e' })
  await sleep(250)
  searched = await evaluate(`(() => {
    const rows = document.querySelectorAll('.kb-item');
    const labels = [...document.querySelectorAll('.kb-section-label, .kb-list label, .nc-group-label')].map((l) => l.textContent.trim());
    return {
      rows: rows.length,
      query: document.querySelector('.kb-search input')?.value ?? '',
      first: rows[0] ? rows[0].textContent.trim().slice(0, 60) : null,
      labels: labels.slice(0, 6),
    };
  })()`)
}
record(
  'Ctrl+K opens the palette with its search field focused and its rows listed',
  Boolean(atRest?.searchFocused) && (searched?.rows ?? 0) >= 6,
  atRest
    ? `${atRest.rows} row(s) at rest (first "${atRest.firstRow}"), focus on ${atRest.activeTag}; ` +
      `after typing "${searched?.query ?? ''}": ${searched?.rows ?? 0} row(s), first "${searched?.first ?? ''}"`
    : 'the palette never appeared',
)

// 4. Escape closes it, and focus is back on what opened it.
await key({ key: 'Escape', code: 'Escape', vk: 27 })
const paletteClosed = await waitFor("!document.querySelector('.kb-palette')")
const focusBack = paletteClosed
  ? await evaluate(`(() => {
      const a = document.activeElement;
      return {
        same: Boolean(window.__smokeOpener) && a === window.__smokeOpener,
        on: a ? (a.textContent || '').trim().slice(0, 40) || a.tagName : '(body)',
        body: a === document.body,
      };
    })()`)
  : null
record(
  'Escape closes the palette and focus returns to where it was',
  Boolean(paletteClosed) && Boolean(focusBack?.same),
  paletteClosed
    ? `focus is on "${focusBack.on}"${focusBack.body ? ' (the body)' : ''}, opener was ${opener ? `"${opener}"` : '(none recorded)'}`
    : 'the palette stayed open',
)

// 5. A modal opened from the UI: right-click a chat row, choose Rename, and
// check its first field has focus and Tab stays inside it.
const row = await evaluate(`(() => {
  const r = document.querySelector('.chat-row');
  if (!r) return null;
  const b = r.getBoundingClientRect();
  return { x: b.x + Math.min(40, b.width / 2), y: b.y + b.height / 2, text: r.textContent.trim().slice(0, 40) };
})()`)
let renameModal = null
let tabStayed = null
if (row) {
  await click(row.x, row.y, 'right')
  const menuOpen = await waitFor("!!document.querySelector('.ctx-menu')")
  if (menuOpen) {
    const item = await evaluate(`(() => {
      const items = [...document.querySelectorAll('.ctx-menu .nc-item')];
      const rename = items.find((i) => /rename/i.test(i.textContent));
      if (!rename) return { found: false, labels: items.map((i) => i.textContent.trim()).slice(0, 8) };
      const b = rename.getBoundingClientRect();
      return { found: true, x: b.x + b.width / 2, y: b.y + b.height / 2, label: rename.textContent.trim() };
    })()`)
    if (item.found) {
      await click(item.x, item.y)
      const modalOpen = await waitFor("!!document.querySelector('.dv-modal')")
      if (modalOpen) {
        renameModal = await evaluate(`(() => {
          const modal = document.querySelector('.dv-modal');
          const input = modal.querySelector('.rn-input');
          const focused = document.activeElement;
          return {
            title: (modal.querySelector('.dv-modal-title')?.textContent ?? '').trim(),
            inputFocused: Boolean(input) && focused === input,
            activeTag: focused ? focused.tagName : '(none)',
            activeClass: focused ? focused.className : '',
          };
        })()`)
        // Tab four times: focus must not leave the panel.
        const inside = []
        for (let i = 0; i < 4; i += 1) {
          await key({ key: 'Tab', code: 'Tab', vk: 9 })
          inside.push(
            await evaluate(`(() => {
              const modal = document.querySelector('.dv-modal');
              return Boolean(modal) && modal.contains(document.activeElement);
            })()`),
          )
        }
        tabStayed = inside.every(Boolean)
        await key({ key: 'Escape', code: 'Escape', vk: 27 })
        await waitFor("!document.querySelector('.dv-modal')")
      }
    }
  }
}
record(
  'a modal opened from the UI keeps its first field and its focus',
  Boolean(renameModal?.inputFocused) && tabStayed === true,
  renameModal
    ? `"${renameModal.title}" focused ${renameModal.activeTag}.${renameModal.activeClass}; Tab stayed inside: ${tabStayed}`
    : row
      ? 'the chat row menu or the Rename dialog did not open'
      : 'no .chat-row in the sidebar to rename',
)

const passed = results.filter((r) => r.pass).length
console.log(`\n${passed} of ${results.length} checks passed`)
ws.close()
process.exit(passed === results.length ? 0 : 1)
