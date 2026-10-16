# JavaScript plugins: the frame and `window.openremote`

A JavaScript plugin runs inside the OpenRemote console, in a frame of its
own. It can add a button to every composer, open views in a pane, keep
settings, and - with the powers the user approved when installing it -
read chats, start and steer them, reach the network and use the
microphone. This page is the plugin author's reference. The dictation
plugin in `examples/plugins/dictation` is a complete, small example.

## The folder

A plugin folder is Claude Code's plugin layout plus OpenRemote's own
`openremote.json` beside it, so one folder is a plugin to both:

```
my-plugin/
  .claude-plugin/plugin.json   Claude Code's manifest (name, version, ...)
  openremote.json              what OpenRemote runs, and what it may do
  main.js                      the page (or index.html)
```

`openremote.json`:

```json
{
  "api": 1,
  "name": "my-plugin",
  "displayName": "My plugin",
  "version": "0.1.0",
  "description": "One line the install review shows.",
  "runtime": "js",
  "entry": "main.js",
  "powers": ["network"],
  "background": false,
  "contributes": {
    "composer_inputs": [{ "id": "go", "label": "Do the thing", "icon": "sparkle" }],
    "views": [{ "id": "main", "title": "My plugin", "icon": "notebook", "place": "sidebar", "entry": "view.html" }],
    "settings": [
      { "key": "base_url", "type": "string", "label": "Address", "help": "Where it goes.", "default": "https://example.com/v1" },
      { "key": "api_key", "type": "secret", "label": "API key", "send_to": "base_url" }
    ]
  }
}
```

This is the same `openremote.json` every plugin runtime reads (see
`authoring.md`); a JavaScript plugin uses the `composer_inputs`, `views` and
`settings` parts of it.

| Field | Meaning |
|---|---|
| `entry` | The page, a path inside the folder: a `.js` (or `.mjs`) file, or an `.html` page. |
| `powers` | Any of `read_chats`, `agent_tools`, `network`, `microphone` (and `run_programs`, which a JavaScript plugin never gets to use). The user approves them at install; nothing else is ever answered. |
| `contributes.composer_inputs` | Up to 3 buttons for the composer's foot: `id` (lowercase letters, digits, dashes), `label`, `icon`. The plugin's own `entry` answers them unless a button names an `entry` of its own. |
| `contributes.views` | Up to 6 views, each a tile in the sidebar's Plugins group that opens in a pane: `id`, `title`, `icon`, `place` (`sidebar`), and the page's `entry`. |
| `background` | `true` loads the plugin's page as soon as the app is up. Otherwise a plugin with composer buttons is loaded on the first click of one, and costs nothing until then. |
| `contributes.settings` | The plugin's settings, in order; see below. |
| `displayName` | The name people read. Without it, the plugin's name with its first letter raised. |

Icons are a fixed set from the app's own icons: `microphone`, `waveform`,
`translate`, `sparkle`, `magic-wand`, `note-pencil`, `notebook`,
`book-open`, `list-checks`, `chat-circle`, `camera`, `image`,
`paperclip`, `globe`, `code`, `terminal`, `robot`, `lightning`, `clock`,
`calendar`, `chart-bar`, `puzzle-piece`. Any other name shows the puzzle
piece.

### Settings

Each setting is an object with:

| Field | Meaning |
|---|---|
| `key` | Lowercase letters, digits and underscores; unique. |
| `type` | `string`, `secret`, `boolean`, `number` or `enum`. |
| `label`, `help` | What the form shows. |
| `default` | The value until the user sets one. |
| `placeholder` | The field's hint (text and numbers). |
| `min`, `max` | A number's bounds. |
| `options` | An enum's choices: strings, or `{ "value": "...", "label": "..." }`. |
| `send_to` | A secret only: the `key` of a `string` setting holding an address. The secret is then written only into requests to that address (the same scheme, host and port, and a path at or under it). |

The form is Settings > Plugins > your plugin's name, and the Installed
tab's Settings button opens it. A secret is write-only: once saved, no
one reads it back - not the form, not the console, not your plugin. Your
plugin uses it by naming it in a request header (see `openremote.fetch`).

## The frame

Every page of your plugin runs in a frame sandboxed to scripts alone:

- It has no origin of its own (it is opaque), so it can read nothing of
  the app, and `localStorage`, cookies and IndexedDB are not there. Keep
  what must last in your settings.
- It reaches no address itself: `fetch`, `XMLHttpRequest`, `WebSocket`
  and remote scripts, styles and pictures are all refused. The network
  is `openremote.fetch`, for a plugin given it.
- No pop-ups, no new windows, no `alert` or `confirm`, no downloads, no
  forms that submit.
- The microphone works only for a plugin given that power.

The console builds your page from your folder:

- A `.js` entry runs as the page's one script, in an empty page.
- A page that can't be built says why: in its view, or - for the hidden
  page behind composer buttons - in a note in the app.
- An `.html` entry has its markup and inline styles kept; its linked
  stylesheets (`<link rel="stylesheet">`) read in; its pictures and media
  (`src`, `poster`) read in as `data:` URLs; then its scripts run in
  order, inline or from your folder. Remote files are left out, and so
  are the files a stylesheet's own `url()` names: put those in as
  `data:` URLs.
- Scripts run after the markup is in place; `DOMContentLoaded` and
  `load` are sent once they have run.
- Inline event handlers (`onclick="..."`), `eval` and `javascript:`
  links don't run: use `addEventListener`.
- A module script runs, but cannot `import` your other files: bundle
  modules into one file, or use classic scripts.

The page wears the app's look: its colors, type and spacing are CSS
variables of the app's own names (`--bg-app`, `--bg-side`, `--bg-hover`,
`--bg-active`, `--line`, `--text-1`, `--text-2`, `--text-3`, `--accent`,
`--green`, `--radius`, `--font-sans`), set on the page's root, and the
body already uses them. When the user turns on Reduce motion, the page's
`<html>` carries `data-reduce-motion`: turn your animations off under it
and under `@media (prefers-reduced-motion: reduce)`.

Keys pressed with Ctrl, Cmd or Alt while your view has focus go on to the
app's own shortcuts, unless your page handled them (`preventDefault`) or
the user is typing in one of its fields.

## `window.openremote`

Every call returns a promise. A refused call - a power not approved, a
composer the user didn't click in - rejects with an `Error` whose message
says why in plain words, ready to show.

### Where the page runs

| | |
|---|---|
| `openremote.plugin` | `{ id, name, version, powers }` |
| `openremote.place` | `'background'` (the hidden page behind composer buttons) or `'view'` |
| `openremote.view` | The view's `id`, in a view |

### The composer (a plugin with composer buttons)

| Call | Does |
|---|---|
| `composer.onClick(handler)` | `handler({ input, composer })` on each click of one of your buttons. `input` is the button's `id`; `composer` is a handle to the composer it was clicked in. Answers a function that stops listening. Clicks that came before your page was up are kept for your first handler. |
| `composer.insert(text, { composer })` | Writes `text` at that composer's cursor (or over its selection), with a space where words would touch. Without `composer`, the one clicked last. A plugin writes only in a composer the user clicked its button in; nothing is ever sent. |
| `composer.attach(file, { composer, name })` | Adds a picture (PNG, JPEG, GIF or WebP, up to 10 MB; a `Blob`, `File` or bytes) to that composer's next message. |
| `composer.setState(input, { state, label, title }, { composer })` | The button's look: `state` is `'idle'`, `'active'` (accent, breathing: listening, recording) or `'busy'` (quieter: working); `label` is a few words beside it (`'Listening 0:12'`); `title` its tooltip. With `composer`, in that composer only. |

### Chats

| Call | Power | Does |
|---|---|---|
| `chats.list()` | `read_chats` | `[{ id, title, harness, status, workspace, updatedAt, synced }]`, every chat on this computer. `status` is `starting`, `working`, `waiting`, `idle`, `stopped` or `failed`. |
| `chats.read(id)` | `read_chats` | `{ id, title, harness, model, status, workspace, updated_at, synced, cut, messages }`; `messages` are `{ role: 'user' \| 'assistant', text }` and `{ role: 'tool', name }`, in order, the last 2000 (`cut` says when there were more). |
| `chats.start({ text, harness, workspace, model })` | `agent_tools` | Starts a chat with `text` as its first message: on `harness` (the user's default otherwise), in `workspace` (a folder; none runs it in the home folder). Answers `{ id }`. The user is told a chat was started. |
| `chats.steer(id, text)` | `agent_tools` | Into a working turn now; on a chat at rest, its next turn. A stopped chat needs Resume first. |
| `chats.stop(id)` | `agent_tools` | Stops the chat. |

### The network

`openremote.fetch(url, init)` (power `network`) works like `fetch`: it
takes `method`, `headers`, `body` (text, bytes, a `Blob`,
`URLSearchParams` or `FormData` - not a stream), `signal`, and
`timeoutMs` (120 s by default, 300 s at most), and answers a `Response`.
The request is made by OpenRemote itself, so the page's own limits don't
apply - and nothing in it is cached, redirected for you, or given
cookies:

- Only `http` and `https`, any address (a server on this computer
  included).
- Redirects come back as they are; answers are up to 4 MB.
- A header value can name one of your secrets as `{{secret:key}}`:
  OpenRemote writes the secret in on the way out. A header whose secret
  is not set is left out. With `send_to`, a request to any other address
  is refused.

```js
const { values, secrets } = await openremote.settings.get()
const form = new FormData()
form.append('file', audio, 'speech.webm')
form.append('model', values.model)
const response = await openremote.fetch(`${values.base_url}/audio/transcriptions`, {
  method: 'POST',
  headers: secrets.api_key === 'set' ? { Authorization: 'Bearer {{secret:api_key}}' } : {},
  body: form,
})
```

### The microphone

`navigator.mediaDevices.getUserMedia({ audio: true })`, for a plugin given
the `microphone` power; refused otherwise. The system may ask the user
the first time. Let the microphone go (`track.stop()`) as soon as you are
done, so its indicator goes off.

### Settings, files, the app

| Call | Does |
|---|---|
| `settings.get()` | `{ values, secrets }`: every value (the default where none was saved), and for each secret `'set'` or `'unset'`. |
| `settings.onChange(handler)` | `handler({ values, secrets })` when the user saves your settings. |
| `files.read(path, { as })` | One of your own files: `as` is `'text'` (the default), `'arraybuffer'`, `'blob'` or `'dataurl'`. |
| `ui.toast(text)` | A short note at the corner of the app, under your plugin's name, for a few seconds. |
| `ui.openView(id)` | Opens one of your views (your first, without `id`) where the user is looking. |
| `ui.openSettings()` | Opens Settings at your plugin's part. |

## How it works

For people working on OpenRemote itself:

- The frame boots from a small `blob:` page (`frameDocument` in
  `src/plugin-runtime.js`) carrying the frame's own policy - no address
  of its own, scripts only from the bridge and `blob:` - and the bridge,
  `public/plugin-bridge.js`, served by the console.
- The bridge and the console talk by `postMessage`: `{ openremote: 1,
  kind }` with kinds `ready`, `boot`, `booted`, `failed`, `call`, `reply`,
  `event`, `log` and `key`; each call carries a number its reply answers. The
  console (`src/plugins-host.jsx`) answers only a frame it made: the
  message's source is that frame's window, and its origin is the
  sandbox's opaque `"null"`. Every call is checked against the powers the
  plugin was given (`refusal` in `src/plugin-runtime.js`).
- The console reads a plugin's files through the daemon with its own
  token (`GET /plugins/{id}/files/{*path}`); the frame never sees the
  token. Settings are `GET` and `POST /plugins/{id}/settings`, the
  network `POST /plugins/{id}/fetch`, and a chat read `GET
  /plugins/{id}/chats/{chat}`, each checking the plugin's powers again in
  the daemon (`daemon/crates/openremote-daemon/src/js_plugins.rs`). None
  of them answers the user's other devices.
