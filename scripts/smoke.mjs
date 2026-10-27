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
// The checks past the view walk press things, and each says what it proves
// and what it does not:
// - a chat row's menu: proves right-click opens it and Escape closes it and
//   focus comes back to the row; not that any row in it acts.
// - the pane menu in a split: proves a split can be made from the menu and
//   that its rows and Escape behave; not that a split row's effect is what it
//   says (the Layouts menu is the palette's page, not a pane-header control).
// - the palette's Rules group: proves it is offered only while Automations is
//   mounted; not that any rule in it runs. It needs a profile with at least one
//   rule, which the dev profile does not have: make one in Automations (New
//   automation), or run against the fixture profile the daemon e2e suites seed
//   (cargo test -p openremote-daemon with OPENREMOTE_DATA_DIR pointing at the
//   e2e fixture, or the fake-cloud suite's seeded chats). With none it skips.
// - an armed plugin row: proves the first press arms, Escape disarms, and the
//   plugin is still installed; not that a second press would remove it. It
//   needs an installed plugin, which the dev profile does not have: install one
//   from a local folder (Plugins > Install > folder) or from the fixture the
//   plugins e2e uses. With none it skips.
//
// WHAT IT DOES NOT COVER: it never exercises the daemon's write path (no chat
// is created and no task is typed, so the stream and the transcript are never
// read), no settings are changed, no plugin is actually removed and no layout
// is saved or applied. A green run says every view opens, draws, keeps the
// boundary panel away and that the four interactions above behave; it does not
// say the app works.

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

// Start from a known place. The app remembers the last view and a previous run
// may have left a popup over it, so a click measured against whatever was on
// screen would be a check on a different window than the one it names.
await evaluate(`(() => {
  const b = [...document.querySelectorAll('.sidebar button')].find((x) => (x.textContent || '').trim() === 'New chat');
  b?.click();
  return 'reset';
})()`)
await waitFor("location.hash === '#new'", { timeout: 5000 })
await sleep(300)

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

// Every view, opened by the app's own route.
//
// A view that cannot render is invisible to every other gate: the tests pass
// because a call site with no import is still valid text, and the build is
// happy because the identifier is only unresolved at runtime. The boundary
// panel catches it in the window, and this walks into every view to make sure
// the panel never appears: no crash panel, a heading or a first control, and
// the pane's own words rather than the boundary's. The route is checked too,
// because a view that was never opened would otherwise pass on the previous
// view's pane - a green line over a visit that did not happen.
//
// Three kinds of destination: routed views (the shell writes the hash), popup
// views (settings, metrics and mobile open over the app, so the hash stays put
// and the check looks inside the popup), and machines, which is Cloud's and is
// visited from Cloud mode.
const paneState = (selector) =>
  evaluate(`(() => {
    const area = document.querySelector('${selector}');
    if (!area) return { why: 'no ${selector}' };
    const vb = area.querySelector('.vb');
    const boundary = vb ? (vb.querySelector('.vb-detail-msg')?.textContent ?? 'the crash panel, with no message') : null;
    const headings = [...area.querySelectorAll('h1, .dv-title, [role="heading"]')]
      .map((h) => (h.textContent || '').trim())
      .filter(Boolean);
    const controls = [...area.querySelectorAll('button, input, textarea, select, [tabindex]')]
      .filter((el) => !(vb && vb.contains(el)) && el.getClientRects().length > 0);
    const text = (area.innerText || '').replace(/\\s+/g, ' ').trim();
    return {
      hash: location.hash,
      boundary,
      heading: headings[0] ?? null,
      controls: controls.length,
      text: text.slice(0, 140),
      crash: text.includes('This view could not be drawn'),
    };
  })()`)

const drewOk = (state) =>
  !state?.why && !state.boundary && !state.crash && (Boolean(state.heading) || state.controls > 0)

const skips = []
const skip = (name, reason) => {
  skips.push({ name, reason })
  console.log(`SKIP  view "${name}" - ${reason}`)
}

const clickSidebar = (match) =>
  evaluate(`(() => {
    const b = [...document.querySelectorAll('.sidebar button')].find((x) => ${match});
    if (!b) return false;
    b.click();
    return true;
  })()`)

const ROUTED = [
  { name: 'new chat', match: `(x.textContent || '').trim() === 'New chat'`, hash: '#new' },
  { name: 'plugins', match: `(x.textContent || '').trim() === 'Plugins'`, hash: '#plugins' },
  { name: 'automations', match: `(x.textContent || '').trim() === 'Automations'`, hash: '#automations' },
  { name: 'account', match: `(x.getAttribute('aria-label') || '').trim() === 'Account'`, hash: '#account' },
]
for (const view of ROUTED) {
  if (!(await clickSidebar(view.match))) {
    record(`view "${view.name}" draws with no boundary panel`, false, 'the sidebar has no control for it')
    continue
  }
  const reached = await waitFor(`location.hash === '${view.hash}'`, { timeout: 5000 })
  await sleep(300)
  const state = await paneState('.split-body')
  record(
    `view "${view.name}" draws with no boundary panel`,
    reached && drewOk(state),
    !reached
      ? `the route did not move: expected ${view.hash}, the window is on ${state?.hash}; pane said "${state?.text ?? ''}"`
      : drewOk(state)
        ? `${state.hash}, heading "${state.heading ?? '(none)'}", ${state.controls} control(s), pane said "${state.text.slice(0, 60)}"`
        : `boundary: "${state.boundary ?? '(none)'}", ${state.hash}; pane said "${state.text}"`,
  )
}

// Machines lives in Cloud mode: the sidebar tile only routes once the mode has
// switched, so the visit is the two clicks a person makes.
const switched = await clickSidebar(`(x.textContent || '').trim() === 'Cloud'`)
await sleep(500)
const machinesClicked = switched && (await clickSidebar(`(x.textContent || '').trim() === 'Machines'`))
if (!machinesClicked) {
  skip('machines', 'the sidebar has no Machines tile in this mode')
} else {
  const reached = await waitFor("location.hash === '#machines'", { timeout: 5000 })
  await sleep(300)
  const state = await paneState('.split-body')
  record(
    'view "machines" draws with no boundary panel',
    reached && drewOk(state),
    !reached
      ? `the route did not move: expected #machines, the window is on ${state?.hash}; pane said "${state?.text ?? ''}"`
      : drewOk(state)
        ? `${state.hash}, heading "${state.heading ?? '(none)'}", ${state.controls} control(s)`
        : `boundary: "${state.boundary ?? '(none)'}"; pane said "${state.text}"`,
  )
  await clickSidebar(`(x.textContent || '').trim() === 'Local'`)
  await sleep(400)
}

// The popup views: settings, metrics and mobile open over the app rather than
// becoming the route, so the panel itself is what has to draw.
const POPUPS = [
  { name: 'settings', label: 'Settings' },
  { name: 'metrics', label: 'Metrics' },
  { name: 'mobile', label: 'Mobile' },
]
for (const view of POPUPS) {
  const clicked = await clickSidebar(`(x.getAttribute('aria-label') || '').trim() === '${view.label}' || (x.title || '').trim() === '${view.label}'`)
  const opened = clicked && (await waitFor(`!!document.querySelector('.vp-window')`, { timeout: 4000 }))
  if (!opened) {
    record(`view "${view.name}" draws with no boundary panel`, false, clicked ? 'the popup never opened' : 'the sidebar has no control for it')
    continue
  }
  await sleep(300)
  const state = await paneState('.vp-body')
  const title = await evaluate(`document.querySelector('.vp-window')?.getAttribute('aria-label') ?? null`)
  record(
    `view "${view.name}" draws with no boundary panel`,
    drewOk(state),
    drewOk(state)
      ? `popup "${title}", heading "${state.heading ?? '(none)'}", ${state.controls} control(s)`
      : `popup "${title}": boundary "${state.boundary ?? '(none)'}", text "${state.text}"`,
  )
  // Escape closes one layer at a time, and the popup owns its own.
  await key({ key: 'Escape', code: 'Escape', vk: 27 })
  await waitFor("!document.querySelector('.vp-window')", { timeout: 4000 })
  await sleep(200)
}

// ---- the interactions ------------------------------------------------------
//
// Everything above reads; these four press. Each one asserts what changes on
// screen, and the header says what it proves and what it leaves alone.
//
// (a) A chat row's menu: right-click opens it, Escape closes it, and the focus
// comes back to the row. Proves the menu's own open, close and focus rules on
// the sidebar's rows; not that any row inside it does its job.
const rowMenuTarget = await evaluate(`(() => {
  const r = document.querySelector('.chat-row');
  if (!r) return null;
  r.focus();
  const b = r.getBoundingClientRect();
  return { x: b.x + Math.min(40, b.width / 2), y: b.y + b.height / 2, label: (r.textContent || '').trim().slice(0, 40) };
})()`)
let rowMenu = null
if (rowMenuTarget) {
  await click(rowMenuTarget.x, rowMenuTarget.y, 'right')
  if (await waitFor("!!document.querySelector('.ctx-menu')")) {
    const shown = await evaluate(`(() => {
      const menu = document.querySelector('.ctx-menu');
      window.__smokeRow = document.querySelector('.chat-row');
      return {
        labels: [...menu.querySelectorAll('.nc-item')].map((i) => i.textContent.trim()),
        menuFocused: document.activeElement === menu,
      };
    })()`)
    await key({ key: 'Escape', code: 'Escape', vk: 27 })
    const closed = await waitFor("!document.querySelector('.ctx-menu')")
    const back = await evaluate(`(() => {
      const a = document.activeElement;
      return {
        onRow: Boolean(window.__smokeRow) && a === window.__smokeRow,
        on: a ? a.tagName + (a.className ? '.' + a.className : '') : '(none)',
      };
    })()`)
    rowMenu = { shown, closed, back }
  }
}
record(
  'a chat row menu opens on right-click, Escape closes it, and focus returns to the row',
  Boolean(rowMenu?.closed) && Boolean(rowMenu?.back.onRow),
  rowMenuTarget
    ? rowMenu
      ? `row "${rowMenuTarget.label}": ${rowMenu.shown.labels.length} row(s) "${rowMenu.shown.labels.slice(0, 4).join(' / ')}", Escape closed it: ${rowMenu.closed}, focus after: ${rowMenu.back.on} (on the row: ${rowMenu.back.onRow})`
      : 'the row menu never opened'
    : 'no .chat-row in the sidebar',
)

// (b) The pane menu in a split: makes the split from the menu, reads the rows
// the menu offers there, and closes it with Escape. Proves a split can be made
// from the same menu a person uses and that its rows and Escape behave; not
// that a split row's effect is what its words say, and not that a Layouts
// control exists in a pane header (the Layouts page is the palette's).
const clickMenuRow = async (source, timeout = 4000) => {
  if (!(await waitFor("!!document.querySelector('.ctx-menu')", { timeout }))) return false
  // Let the menu settle where it opened: it clamps itself inside the window in
  // the same frame, and the hand sequence that works (and does split the pane)
  // waits a beat before measuring the row.
  await sleep(250)
  const at = await evaluate(`(() => {
    const row = [...document.querySelectorAll('.ctx-menu .nc-item')].find((i) => new RegExp('${source}', 'i').test(i.textContent.trim()));
    if (!row) return null;
    const b = row.getBoundingClientRect();
    return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
  })()`)
  if (!at) return false
  await click(at.x, at.y)
  return true
}
const openPaneMenu = async () => {
  // A blank margin first: a card, a link or a text field under the cursor
  // hands the right-click to something else, and the pane menu is what this
  // check needs. The marked-up pane itself is the fallback.
  const points = await evaluate(`(() => {
    const pane = document.querySelector('[data-leaf-id]');
    if (!pane) return [];
    const b = pane.getBoundingClientRect();
    return [
      { x: b.x + 12, y: b.y + b.height / 2 },
      { x: b.x + b.width / 2, y: b.y + b.height / 2 },
      { x: b.x + b.width - 12, y: b.y + 40 },
    ];
  })()`)
  for (const p of points ?? []) {
    await click(p.x, p.y, 'right')
    if (await waitFor("!!document.querySelector('.ctx-menu')", { timeout: 1500 })) return true
  }
  return false
}
let splitMade = false
if (await openPaneMenu()) {
  splitMade = await clickMenuRow('split right')
  splitMade = splitMade && (await waitFor("document.querySelectorAll('[data-leaf-id]').length === 2", { timeout: 5000 }))
}
let paneMenu = null
if (splitMade) {
  if (await openPaneMenu()) {
    const labels = await evaluate(`[...document.querySelectorAll('.ctx-menu .nc-item')].map((i) => i.textContent.trim())`)
    await key({ key: 'Escape', code: 'Escape', vk: 27 })
    const closed = await waitFor("!document.querySelector('.ctx-menu')")
    paneMenu = { labels, closed }
  }
  // Put the window back to one pane, the way a person would.
  if (await openPaneMenu()) {
    await clickMenuRow('close pane')
    await waitFor("document.querySelectorAll('[data-leaf-id]').length === 1", { timeout: 5000 })
  }
}
record(
  'in a split, the pane menu lists its rows and Escape closes it',
  Boolean(splitMade) && Boolean(paneMenu?.closed) && (paneMenu?.labels.length ?? 0) >= 4,
  splitMade
    ? paneMenu
      ? `rows "${paneMenu.labels.slice(0, 6).join(' / ')}", Escape closed it: ${paneMenu.closed}`
      : 'the pane menu never opened in the split'
    : 'the split never happened (the pane menu did not act)',
)

// (c) The palette's Rules group: typing "rul" offers it only while Automations
// is mounted. Proves the group is mounted with the view rather than always on;
// not that a rule in it runs.
const goView = async (label, hash) => {
  const clicked = await clickSidebar(`(x.textContent || '').trim() === '${label}'`)
  if (!clicked) return false
  const reached = await waitFor(`location.hash === '${hash}'`, { timeout: 5000 })
  await sleep(300)
  return reached
}
const rulesIn = async (label, hash) => {
  if (!(await goView(label, hash))) return null
  // The view's own words say whether it holds any rules; a profile with none
  // cannot show the group on any view, so the gating is not exercised there.
  const empty = await evaluate(`(document.querySelector('.split-body')?.innerText ?? '').includes('No rules yet.')`)
  await key({ key: 'k', code: 'KeyK', vk: 75, modifiers: 2 })
  if (!(await waitFor("!!document.querySelector('.kb-palette')"))) return null
  for (const [ch, code, vk] of [
    ['r', 'KeyR', 82],
    ['u', 'KeyU', 85],
    ['l', 'KeyL', 76],
  ]) {
    await key({ key: ch, code, vk, text: ch })
  }
  await sleep(250)
  const labels = await evaluate(`[...document.querySelectorAll('.kb-group-label')].map((l) => l.textContent.trim())`)
  await key({ key: 'Escape', code: 'Escape', vk: 27 })
  await waitFor("!document.querySelector('.kb-palette')", { timeout: 4000 })
  return { empty, labels, hasRules: labels.includes('Rules') }
}
const onAutomations = await rulesIn('Automations', '#automations')
const onPlugins = await rulesIn('Plugins', '#plugins')
if (onAutomations?.empty) {
  skip('the palette rules group', 'this dev profile has no rules, so the group is empty on every view')
} else {
  record(
    "the palette's Rules group appears only while Automations is mounted",
    Boolean(onAutomations?.hasRules) && Boolean(onPlugins) && !onPlugins.hasRules,
    `Automations: "${onAutomations?.labels.join(', ') ?? '(none)'}"; Plugins: "${onPlugins?.labels.join(', ') ?? '(none)'}"`,
  )
}

// (d) An armed plugin row: the first press on Remove arms it, Escape cancels
// the arm, and the plugin is still in the list. Proves the arm is reversible
// and removes nothing; not that a second press would remove the plugin.
const armTarget = await evaluate(`(() => {
  const buttons = [...document.querySelectorAll('.split-body button')];
  const remove = buttons.find((b) => (b.textContent || '').trim() === 'Remove');
  if (!remove) return null;
  const b = remove.getBoundingClientRect();
  return { x: b.x + b.width / 2, y: b.y + b.height / 2, before: buttons.filter((x) => (x.textContent || '').trim() === 'Remove').length };
})()`)
let pluginArm = null
if (armTarget) {
  await click(armTarget.x, armTarget.y)
  const armsUp = await waitFor(`[...document.querySelectorAll('.split-body button')].some((b) => (b.textContent || '').trim() === 'Remove it')`, {
    timeout: 3000,
  })
  await key({ key: 'Escape', code: 'Escape', vk: 27 })
  await sleep(300)
  pluginArm = await evaluate(`(() => {
    const buttons = [...document.querySelectorAll('.split-body button')];
    return {
      armed: buttons.some((b) => (b.textContent || '').trim() === 'Remove it'),
      count: buttons.filter((b) => (b.textContent || '').trim() === 'Remove').length,
    };
  })()`)
  pluginArm.armsUp = armsUp
  pluginArm.before = armTarget.before
}
if (!armTarget) {
  skip('the armed plugin row', 'no installed plugin in this dev profile')
} else {
  record(
    'arming a plugin row and pressing Escape cancels the arm and removes nothing',
    Boolean(pluginArm?.armsUp) && !pluginArm.armed && pluginArm.count === pluginArm.before,
    `armed on the first press: ${pluginArm?.armsUp}, still armed after Escape: ${pluginArm?.armed}, Remove buttons ${pluginArm?.before} -> ${pluginArm?.count}`,
  )
}

const passed = results.filter((r) => r.pass).length
console.log(
  `\n${passed} of ${results.length} checks passed${skips.length ? `, ${skips.length} skipped (${skips.map((s) => s.name).join(', ')})` : ''}`,
)
ws.close()
process.exit(passed === results.length ? 0 : 1)
