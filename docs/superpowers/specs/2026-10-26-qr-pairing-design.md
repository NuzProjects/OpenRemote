# Phone pairing by QR code (Local mode)

Status: design, 2026-10-26. Implementation: `daemon/crates/openremote-daemon/src/pairing.rs`,
`pairing_page.rs`, `tests/e2e_pairing.rs`, `src/pairing.js`, `src/qr.js`, `src/PairingSection.jsx`.

## The story

Someone has OpenRemote open on their computer. They open Mobile, click "Show a pairing code", and
a QR code appears. They point their phone's camera at it. The phone opens a page served by that
computer, the page says "Paired with <this computer>", and it lists that computer's chats. Two
seconds later the phone is showing live data from the desktop daemon. No account, no sign-up, no
typing, no file to move.

Anyone at that computer can then see the phone in the list and remove it with one click.

## Flow, in numbered steps

1. The console calls `POST /pairing/code` on its own daemon (loopback, owner token, as every
   console call). The daemon mints a one-time code, makes sure the LAN listener is up, and
   answers `{ code, url, expires_at, computer }` where `url` is
   `http://<lan-ip>:<port>/#<code>`.
2. The console renders that `url` as a QR code (`src/qr.js`, a small encoder in the console; the
   daemon never renders an image).
3. The phone scans it and fetches the page. The code rides in the URL *fragment*, so it is never
   sent to the server as part of a request and never lands in a server log; the page's own script
   reads `location.hash`.
4. The page calls `POST /pair` with `{ code, name }`. The name is the page's best guess at the
   device ("iPhone", "Android phone") so the desktop list is readable without typing.
5. The daemon checks the code: it is live, it has not been used, it has not expired, and this is
   not above the failed-attempt limit. On success it mints a 244-bit scoped token, stores only
   its SHA-256 digest, records the phone, invalidates the code, stops the LAN listener if that was
   the only reason it was up (a phone is paired now, so it stays up), and answers
   `{ token, phone: { id, name }, computer: { name } }`.
6. The page keeps the token in `localStorage` and polls `GET /api/home` every 4 seconds with
   `Authorization: Bearer <token>`. It shows the computer's name, its harnesses, and its chat
   list (titles, harness, last activity).
7. On the desktop, `GET /pairing/phones` lists paired phones; `POST /pairing/phones/{id}/revoke`
   drops one. The next poll from that phone gets 401 and the page says the computer removed it.

## Trust model

Two credentials exist and they never meet.

- **The owner token** is the daemon's existing bearer token. It stays on loopback. It is not in
  the QR payload, not in the page, not in any LAN response, and not in any log line. Only the
  loopback routes under `/pairing/` accept it (they are added to the loopback router, which is
  bound to 127.0.0.1 by the daemon).
- **The phone token** is minted per phone by the pairing exchange. It is accepted by exactly one
  route, `GET /api/home`, on the LAN listener. A phone token presented to the loopback API is a
  stranger there, and the loopback token is useless on the LAN listener because that listener has
  no route that reads it.

What the LAN listener serves, in total:

| Route | Credential | Answers |
| --- | --- | --- |
| `GET /` | none | the phone page (HTML, no data) |
| `POST /pair` | the pairing code | the exchange above |
| `GET /api/home` | the phone token | computer name, harness ids, chat list projection |
| anything else | - | 404 |

`/api/home` is not a proxy into the owner API. It is a small handler that reads the store and the
supervisor and projects four fields per chat. There is no route, no query parameter, and no header
that makes it reach `/sessions/{id}/prompts`, the harness control surface, the filesystem, plugins,
marketplaces, automations, MCP servers, or Cloud.

### What a hostile device on the same LAN can do

- It can fetch the pairing page while the listener is up. The page carries no data and no secret;
  it is the same bytes for everyone.
- It can try to redeem a code it did not see. Codes are 50 bits of randomness, live for 5 minutes,
  single use, and after 5 wrong attempts the live code is destroyed, so guessing is not a path.
- It can see that a host on this network answers at all, while pairing is on or a phone is paired.
  When neither is true nothing is listening on the LAN at all.

### What it cannot do

- Read the code out of thin air. The code exists in the daemon's memory, in the QR image on the
  user's own screen, and in the URL fragment on the phone. It is never written to disk, never
  logged, never in a response body to anyone but the console that asked for it.
- Redeem a code twice, redeem an expired code, or redeem a code after 5 failed attempts.
- Reach the owner API, the harness control surface, the chat transcripts, the store, the token
  file, `state.json`, or `cloud/` with a phone token. None of those routes exist on the listener.
- Use a revoked phone token. Revocation deletes the record; the next request is 401.
- Escalate a phone token to the owner token. The two are compared in different places, against
  different secrets, and the phone token is stored only as a digest.
- Get the desktop to trust it. Pairing is approved by the person at the machine holding the code
  on their screen; the code *is* the confirmation. There is no desktop-side "accept this device?"
  prompt to social-engineer, and no typing to hand over.

## Wire shapes

`POST /pairing/code` (loopback, owner token), body `{}`:

```json
{ "code": "K7QM2XTB9R", "url": "http://192.168.1.42:51234/#K7QM2XTB9R",
  "expires_at": 1761516723000, "computer": { "name": "studio" },
  "phones": [ { "id": "…", "name": "iPhone", "paired_at": 1761516000000 } ] }
```

Only one code is live at a time: asking again replaces it, which is also the "cancel" (an old QR
stops working the moment a new one is minted). `POST /pairing/cancel` stops the listener when no
phone is paired.

`POST /pair` (LAN, no credential), body `{ "code": "...", "name": "iPhone" }`:

- 200 `{ "token": "...", "phone": {"id","name"}, "computer": {"name"} }`
- 404 `{ "error": "That pairing code is not valid." }` (unknown, used, destroyed by failed
  attempts)
- 410 `{ "error": "That pairing code expired." }`

`GET /api/home` (LAN, phone token):

```json
{ "computer": { "name": "studio", "harnesses": ["claude", "codex"] },
  "phone": { "name": "iPhone" },
  "chats": [ { "id": "…", "title": "Fix the flaky e2e", "harness": "claude",
               "status": "idle", "updated_at": 1761516000000 } ] }
```

Titles and harness ids only. A chat's workspace path is host filesystem detail and stays home.

`GET /pairing/phones` (loopback, owner token): `{ "phones": [ … ] }`, the same records the mint
response carries.

`POST /pairing/phones/{id}/revoke` (loopback, owner token): `{ "phones": [ … ] }`.

## Token lifecycle

| Moment | What happens |
| --- | --- |
| mint | a code is created, in memory only, 5 minute TTL |
| exchange | the code dies, a phone token is minted, its SHA-256 digest is written |
| restart | codes are gone (in memory); paired phones survive |
| revoke | the phone record is deleted, so the next request is 401 |
| idle | the listener stops when no code is live and no phone is paired |

Paired phones survive a daemon restart on purpose. The founder's ask is "no friction"; making a
phone re-pair after every daemon restart or reboot would be friction, and the credential it holds
is read-only, owner-only on disk (a digest, not the token), and revoked in one click from the
desktop. The listener does not idle on the LAN forever: with no live code and no paired phone,
nothing is bound.

## Failure modes and their copy

| What happened | What the phone shows |
| --- | --- |
| code unknown, used, or attempts burnt | "That pairing code is not valid. Show a new one on the computer." |
| code older than 5 minutes | "That pairing code expired. Show a new one on the computer." |
| token rejected by `/api/home` | "This computer removed this phone. Scan a new code to pair again." |
| the page cannot reach the host at all | the browser's own "site can't be reached". The desktop copy says: keep both on the same network, and allow OpenRemote through the firewall. |
| no daemon / pairing off | the desktop's Mobile view says so, with the button that turns it on |

## Rulings made where the brief was silent

1. **The scoped surface is a small handler set, not an HTTP proxy.** "Proxy" in the brief allows
   either; a set of three explicit read-only handlers is the smallest thing that can exist, and it
   makes "the phone cannot reach the owner API" structural rather than a filter someone can get
   wrong later.
2. **The control routes live on the existing loopback router.** The console already has exactly
   one address and one token for its daemon; adding a second port would mean teaching the console,
   the shell, and the Android app about a third address. `/pairing/*` is merged into the loopback
   router only (in `main.rs`), so its reachability is decided by the socket, not by a header check.
3. **Paired phones persist; codes do not.** See the lifecycle section.
4. **One live code at a time.** A second button press replaces the first code. This gives cancel
   for free and stops a stale QR from staying valid.
5. **The code rides in the URL fragment.** It never travels to the server in a request line,
   where a log or a proxy would capture it.
6. **The phone's name comes from the page's own user agent string.** The founder asked for no
   typing; "iPhone" or "Android phone" is honest enough to identify a row in a list, and renaming
   is a follow-up, not tonight.
7. **The QR encoder is hand-written in the console.** Neither lockfile has a QR dependency, and
   adding one is not allowed. `src/qr.js` is a small, tested, byte-mode encoder (versions 1 to 10,
   error correction level M), enough for a LAN URL of about 60 characters.
8. **`cargo fmt` already fails at this branch's base** in `openremote-core/src/{model,store}.rs`
   (another session's in-flight work, blacklisted here). Those two files are untouched by this
   work, and the report names them as the only diffs the formatter finds.

## Explicitly out of scope tonight

- Driving harnesses from the phone: sending prompts, answering approvals, creating chats.
- TLS, any public exposure, any tunnel or relay, any Cloud involvement, mDNS discovery.
- One phone managing several desktops, or one desktop pairing with several phones at once (the
  list holds many phones; only one code is live at a time).
- Renaming a paired phone, per-phone permissions, or a phone session log.
- Installer firewall rules for the LAN port. Until those exist, Windows will ask the user, and a
  deny is a silent "site can't be reached" on the phone.
