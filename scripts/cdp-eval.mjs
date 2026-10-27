// Evaluate JavaScript in the console's own webview over the DevTools
// protocol and print the answer.
//
// Usage: node scripts/cdp-eval.mjs '<js expression>'
//
// Only a dev build opens this port (`src-tauri/src/main.rs`, 9333 because
// another process here claims 9222), and only while the app is running.
// WebSocket and fetch come from Node itself, so this needs no install and
// reaches into no package cache.
const port = process.env.OPENREMOTE_CDP_PORT ?? '9333'
const expr = process.argv[2]
if (!expr) {
  console.error("usage: node scripts/cdp-eval.mjs '<js expression>'")
  process.exit(2)
}

const targets = await fetch(`http://127.0.0.1:${port}/json`).then((r) => r.json())
// The built-in browser's tabs are webviews in the same window, so the port
// lists their pages too. The console is the one the app itself serves.
const pages = targets.filter((t) => t.type === 'page' && !String(t.url).startsWith('devtools://'))
const consolePage =
  pages.find((t) => /^(https?:\/\/127\.0\.0\.1:5175|tauri:\/\/localhost)/.test(String(t.url))) ??
  pages[0]
if (!consolePage) {
  console.error(`no page on the DevTools port ${port} - is the app running, and is this a dev build?`)
  process.exit(1)
}

const ws = new WebSocket(consolePage.webSocketDebuggerUrl)
const stop = setTimeout(() => {
  console.error('the page did not answer in 10 seconds')
  process.exit(1)
}, 10_000)
ws.addEventListener('error', () => {
  console.error('the DevTools connection failed')
  process.exit(1)
})
ws.addEventListener('open', () => {
  ws.send(
    JSON.stringify({
      id: 1,
      method: 'Runtime.evaluate',
      params: { expression: expr, awaitPromise: true, returnByValue: true },
    }),
  )
})
ws.addEventListener('message', (event) => {
  const message = JSON.parse(event.data)
  if (message.id !== 1) return
  clearTimeout(stop)
  console.log(JSON.stringify(message.result?.result ?? message.result, null, 2))
  ws.close()
  process.exit(0)
})
