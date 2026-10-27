//! The phone page the pairing listener serves: one HTML document, no
//! external assets, no framework, no build step.
//!
//! It exists to prove the pairing works: it exchanges the code in the URL
//! fragment for a scoped token, keeps that token in this origin's
//! `localStorage`, and shows what this computer is doing. It is not a second
//! console, and it deliberately has no route to make one: everything it can
//! ask for is the one read-only `GET /api/home`.
//!
//! Served with a CSP that allows no request off this origin, so a hostile
//! network cannot inject anything into a page a phone trusts.

/// The page. `PAGE` is interpolated nowhere: the code and the token never
/// reach this string, so what a phone downloads is the same bytes for every
/// phone and every desktop.
pub const PAGE: &str = r##"<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="dark">
<title>OpenRemote</title>
<style>
  :root {
    --bg: #0a0c0f;
    --panel: rgba(255, 255, 255, 0.04);
    --line: rgba(255, 255, 255, 0.07);
    --text-1: #e8ebef;
    --text-2: #9aa3ae;
    --text-3: #5f6873;
    --accent: #dca24b;
    --green: #4cb487;
    --mono: ui-monospace, 'SF Mono', 'Cascadia Mono', Menlo, monospace;
  }
  * { box-sizing: border-box; }
  html, body {
    margin: 0;
    background: var(--bg);
    color: var(--text-1);
    font: 14px/1.5 -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif;
    -webkit-text-size-adjust: 100%;
  }
  main {
    max-width: 560px;
    margin: 0 auto;
    padding: 28px 20px 56px;
  }
  header {
    display: flex;
    align-items: center;
    gap: 10px;
    padding-bottom: 18px;
    border-bottom: 1px solid var(--line);
  }
  .mark {
    width: 26px;
    height: 26px;
    border-radius: 7px;
    background: var(--accent);
    flex: none;
  }
  h1 {
    margin: 0;
    font-size: 16px;
    font-weight: 600;
    letter-spacing: 0.01em;
  }
  .sub {
    margin-left: auto;
    font-size: 12.5px;
    color: var(--text-3);
  }
  .state {
    margin: 26px 0 0;
    padding: 18px;
    border: 1px solid var(--line);
    border-radius: 7px;
    background: var(--panel);
  }
  .state h2 {
    margin: 0 0 6px;
    font-size: 16px;
    font-weight: 600;
  }
  .state p {
    margin: 0;
    color: var(--text-2);
    font-size: 14px;
  }
  .state[hidden] { display: none; }
  .state--bad { border-color: rgba(248, 113, 113, 0.35); }
  .dot {
    display: inline-block;
    width: 7px;
    height: 7px;
    margin-right: 7px;
    border-radius: 50%;
    background: var(--text-3);
    vertical-align: middle;
  }
  .dot--live { background: var(--green); }
  #live[hidden], #dead[hidden] { display: none; }
  .computer {
    margin: 26px 0 0;
  }
  .computer .name {
    font-size: 16px;
    font-weight: 600;
    letter-spacing: -0.01em;
  }
  .computer .meta {
    margin: 4px 0 0;
    font-size: 12.5px;
    color: var(--text-3);
  }
  .chips {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    margin: 14px 0 0;
    padding: 0;
    list-style: none;
  }
  .chips li {
    padding: 3px 9px;
    border: 1px solid var(--line);
    border-radius: 9999px;
    font: 12px/1.4 var(--mono);
    color: var(--text-2);
  }
  h3 {
    margin: 32px 0 10px;
    font-size: 12px;
    font-weight: 600;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--text-3);
  }
  .chats {
    margin: 0;
    padding: 0;
    list-style: none;
    border: 1px solid var(--line);
    border-radius: 7px;
    overflow: hidden;
  }
  .chats li {
    display: flex;
    align-items: baseline;
    gap: 10px;
    padding: 12px 14px;
    border-top: 1px solid var(--line);
  }
  .chats li:first-child { border-top: 0; }
  .chats .title {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .chats .harness {
    font: 12px/1.4 var(--mono);
    color: var(--text-3);
    flex: none;
  }
  .chats .when {
    font: 12px/1.4 var(--mono);
    color: var(--text-3);
    flex: none;
    min-width: 54px;
    text-align: right;
  }
  .empty {
    margin: 0;
    padding: 16px 14px;
    color: var(--text-3);
    font-size: 13px;
  }
  footer {
    margin: 34px 0 0;
    padding-top: 16px;
    border-top: 1px solid var(--line);
    font-size: 12px;
    color: var(--text-3);
  }
  @media (prefers-reduced-motion: reduce) {
    * { transition: none !important; animation: none !important; }
  }
</style>
</head>
<body>
<main>
  <header>
    <span class="mark"></span>
    <h1>OpenRemote</h1>
    <span class="sub" id="sub">Local pairing</span>
  </header>

  <section class="state" id="waiting">
    <h2>Pairing with your computer</h2>
    <p>Trading the code on this page for this phone's own key.</p>
  </section>

  <section class="state state--bad" id="bad" hidden>
    <h2 id="bad-title">That pairing code is not valid</h2>
    <p id="bad-body">Show a new pairing code in OpenRemote on the computer, then scan it again.</p>
  </section>

  <section id="live" hidden>
    <div class="computer">
      <div class="name" id="computer">&nbsp;</div>
      <p class="meta"><span class="dot dot--live"></span><span id="phone">This phone</span> is paired. Live from the computer.</p>
    </div>
    <h3>Harnesses on this computer</h3>
    <ul class="chips" id="harnesses"></ul>
    <h3>Chats</h3>
    <ul class="chats" id="chats"></ul>
    <p class="empty" id="no-chats" hidden>No chats on this computer yet.</p>
    <p class="empty" id="warn" hidden></p>
    <footer>
      To undo this, open OpenRemote on the computer and remove this phone from Mobile.
      Nothing here is stored anywhere else: there is no account and no server.
      This page talks to the computer over the local network in the clear, so a device that can
      watch this network's traffic can see the pairing and what is shown here. Pair on a network
      you trust.
    </footer>
  </section>
</main>
<script>
(function () {
  'use strict'
  var KEY = 'openremote-pairing'
  var POLL_MS = 4000
  var waiting = document.getElementById('waiting')
  var bad = document.getElementById('bad')
  var badTitle = document.getElementById('bad-title')
  var badBody = document.getElementById('bad-body')
  var live = document.getElementById('live')
  var computerEl = document.getElementById('computer')
  var phoneEl = document.getElementById('phone')
  var harnessEl = document.getElementById('harnesses')
  var chatsEl = document.getElementById('chats')
  var noChats = document.getElementById('no-chats')
  var warn = document.getElementById('warn')
  var sub = document.getElementById('sub')

  function store(token, name) {
    try { localStorage.setItem(KEY, JSON.stringify({ token: token, name: name })) } catch (e) {}
  }
  function load() {
    try {
      var raw = localStorage.getItem(KEY)
      if (!raw) return null
      var parsed = JSON.parse(raw)
      return parsed && typeof parsed.token === 'string' ? parsed : null
    } catch (e) { return null }
  }
  function forget() {
    try { localStorage.removeItem(KEY) } catch (e) {}
  }

  // The phone's own best guess at its name: no typing.
  function phoneName() {
    var ua = navigator.userAgent || ''
    if (/iPhone/.test(ua)) return 'iPhone'
    if (/iPad/.test(ua)) return 'iPad'
    if (/Android/.test(ua)) return 'Android phone'
    return 'Phone'
  }

  function showBad(title, body) {
    waiting.hidden = true
    live.hidden = true
    badTitle.textContent = title
    badBody.textContent = body
    bad.hidden = false
  }

  function when(ms) {
    var secs = Math.max(0, Math.round((Date.now() - ms) / 1000))
    if (secs < 60) return 'now'
    if (secs < 3600) return Math.round(secs / 60) + 'm'
    if (secs < 86400) return Math.round(secs / 3600) + 'h'
    return Math.round(secs / 86400) + 'd'
  }

  function render(home) {
    waiting.hidden = true
    bad.hidden = true
    live.hidden = false
    computerEl.textContent = (home.computer && home.computer.name) || 'This computer'
    phoneEl.textContent = (home.phone && home.phone.name) || 'This phone'
    sub.textContent = 'Paired'
    harnessEl.textContent = ''
    var harnesses = (home.computer && home.computer.harnesses) || []
    harnesses.forEach(function (id) {
      var li = document.createElement('li')
      li.textContent = id
      harnessEl.appendChild(li)
    })
    harnessEl.hidden = harnesses.length === 0
    chatsEl.textContent = ''
    var chats = home.chats || []
    chats.forEach(function (chat) {
      var li = document.createElement('li')
      var title = document.createElement('span')
      title.className = 'title'
      title.textContent = chat.title || 'New chat'
      var harness = document.createElement('span')
      harness.className = 'harness'
      harness.textContent = chat.harness || ''
      var ago = document.createElement('span')
      ago.className = 'when'
      ago.textContent = chat.status === 'working' ? 'running' : when(chat.updated_at || 0)
      li.appendChild(title)
      li.appendChild(harness)
      li.appendChild(ago)
      chatsEl.appendChild(li)
    })
    noChats.hidden = chats.length > 0
  }

  function poll(saved) {
    var timer = null
    function once() {
      fetch('/api/home', { headers: { Authorization: 'Bearer ' + saved.token }, cache: 'no-store' })
        .then(function (res) {
          if (res.status === 401) {
            forget()
            clearInterval(timer)
            showBad('This computer removed this phone',
              'Scan a new pairing code from OpenRemote on the computer to pair again.')
            return null
          }
          if (!res.ok) throw new Error('HTTP ' + res.status)
          return res.json()
        })
        .then(function (body) { if (body) render(body) })
        .catch(function () {
          // The computer is asleep, or the phone left the network. Say so
          // once and keep trying: the link comes back on its own.
          sub.textContent = 'Not answering'
        })
    }
    once()
    timer = setInterval(once, POLL_MS)
    document.addEventListener('visibilitychange', function () {
      if (!document.hidden) once()
    })
  }

  function claim(code) {
    fetch('/pair', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: code, name: phoneName() }),
    })
      .then(function (res) {
        return res.json().catch(function () { return {} }).then(function (body) {
          return { status: res.status, body: body }
        })
      })
      .then(function (answer) {
        if (answer.status === 200 && answer.body && answer.body.token) {
          // The code is spent; keep it out of the address bar.
          history.replaceState(null, '', location.pathname)
          store(answer.body.token, (answer.body.phone && answer.body.phone.name) || phoneName())
          // A browser that refused the key (private mode, a full quota) has
          // nowhere to put the token, so this page uses it from memory and
          // says what a reload will cost instead of dying on a null.
          var kept = load()
          if (!kept) {
            kept = { token: answer.body.token, name: phoneName() }
            warn.hidden = false
            warn.textContent =
              'This browser will not keep the pairing, so scanning again after a reload needs a new code.'
          }
          poll(kept)
          return
        }
        if (answer.status === 410) {
          showBad('That pairing code expired',
            'Codes last five minutes. Show a new one in OpenRemote on the computer.')
          return
        }
        if (answer.status === 500) {
          showBad('The computer could not save the pairing',
            'Nothing was paired. Show a new code in OpenRemote on the computer and scan again.')
          return
        }
        showBad('That pairing code is not valid',
          'Show a new pairing code in OpenRemote on the computer, then scan it again.')
      })
      .catch(function () {
        showBad('This phone could not reach the computer',
          'Check that the phone is on the same Wi-Fi as the computer, then open the code again.')
      })
  }

  var code = (location.hash || '').replace(/^#/, '')
  var saved = load()
  if (code) claim(code)
  else if (saved) poll(saved)
  else showBad('No pairing code on this page',
    'Open OpenRemote on the computer, choose Mobile, and scan the code it shows.')
})()
</script>
</body>
</html>
"##;
