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
| `GET /favicon.ico` | none | 204, so a browser stops asking |
| anything else | - | 404 |

`/api/home` is not a proxy into the owner API. It is a small handler that reads the store and the
supervisor and projects four fields per chat. There is no route, no query parameter, and no header
that makes it reach `/sessions/{id}/prompts`, the harness control surface, the filesystem, plugins,
marketplaces, automations, MCP servers, or Cloud.

### What a hostile device on the same LAN can do

- It can fetch the pairing page while the listener is up. The page carries no data and no secret;
  it is the same bytes for everyone.
- It can try to redeem a code it did not see. Codes are 40 bits of randomness (eight characters of a
  32 character alphabet, drawn so that no position is weaker than the rest), live for 5 minutes,
  single use, and after 5 wrong attempts the live code is destroyed, so guessing is not a path.
- It can see that a host on this network answers at all, while pairing is on or a phone is paired.
  When neither is true nothing is listening on the LAN at all.
- It can read anything the network carries, because the connection is plain HTTP. That is its own
  section below, because it is the one real cost of this design.

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

### The trade plain HTTP makes, said out loud

The connection between the phone and the computer is plain HTTP on the local network. Nothing goes
to the internet, there is no account, and no server sits in the middle, and all of that is true. The
cost is that anything that can watch this network's traffic can read what crosses it:

- **The code, during the exchange.** `POST /pair` carries it in a body. It is worthless a moment
  later (it is used up by that request and dies at 5 minutes), so what a sniffer gains is a code it
  did not need to guess.
- **Every phone token, on every poll.** `/api/home` carries the token in an `Authorization` header.
  A token is read-only, but it is durable until the phone is removed from the desktop, and it
  exposes up to 25 chat titles, which is the user's own content.

There is a second edge to this. Plain HTTP gives the phone no way to verify who answers at
`http://<ip>:<port>`, and the page keeps its token in `localStorage` keyed to exactly that origin. A
device that later answers on the same address and port is, to the browser, the same origin, and a
page served from it can read the key. That key is still read-only and still revocable, and revoking
from the desktop is one click, but it is the reason the sentences on both surfaces were rewritten
for this round.

What that means in the product: the desktop says, where the code is shown, that the two devices talk
straight to each other over the local network and that the connection is not encrypted, so anyone who
can watch this network's traffic can see the pairing go by; the phone page says the same in one
sentence. Both say "pair on a network you trust" and neither promises a TLS handshake it does not
perform.

The next step, recorded here rather than done tonight: pair over TLS with a certificate the daemon
generates at pairing time and the phone pins when it accepts the code, which turns "somebody could
be in the middle" into "this page cannot be read by anybody who was not at the first scan". Doing
that badly tonight (a self-signed certificate accepted blindly) would be worse than plain HTTP with
an honest sentence.

## Wire shapes

`POST /pairing/code` (loopback, owner token), body `{}`:

```json
{ "code": "K7QM2XTB9R", "url": "http://192.168.1.42:47823/#K7QM2XTB9R",
  "expires_at": 1761516723000, "computer": { "name": "studio" },
  "phones": [ { "id": "…", "name": "iPhone", "paired_at": 1761516000000 } ] }
```

The port is the first free one of a fixed list (47823 through 47828), not a random ephemeral one:
the phone stores its token against this origin, and a port that changed on every restart would
strand every paired phone.

Only one code is live at a time: asking again replaces it, which is also the "cancel" (an old QR
stops working the moment a new one is minted). A mint that fails (no network, or every candidate port
taken) takes the old code down with it before it reports the error: a code nobody can see is a code
nobody is watching. `POST /pairing/cancel` stops the listener when no phone is paired.

`POST /pair` (LAN, no credential), body `{ "code": "...", "name": "iPhone" }`:

- 200 `{ "token": "...", "phone": {"id","name"}, "computer": {"name"} }`
- 404 `{ "error": "That pairing code is not valid." }` (unknown, used, destroyed by failed
  attempts)
- 410 `{ "error": "That pairing code expired." }`
- 500 `{ "error": "This computer could not save the pairing, so nothing was paired. Try again." }`
  (the phones file could not be written; the code is spent and no token is handed out, because a
  pairing this computer would forget on its next start is worse than none)

`GET /api/home` (LAN, phone token):

```json
{ "computer": { "name": "studio", "harnesses": ["claude", "codex"] },
  "phone": { "name": "iPhone" },
  "chats": [ { "id": "…", "title": "Fix the flaky e2e", "harness": "claude",
               "status": "idle", "updated_at": 1761516000000 } ] }
```

Titles and harness ids only. A chat's workspace path is host filesystem detail and stays home.

`GET /pairing/phones` (loopback, owner token): `{ "phones": [ … ], "notice": null }`, the same
records the mint response carries, plus the daemon's own sentence when it could not open the pairing
port at start with a phone already paired. The console shows that sentence instead of a panel that
looks fine while the phone cannot reach anything.

`POST /pairing/phones/{id}/revoke` (loopback, owner token): `{ "phones": [ … ], "notice": null }`, or
404 for an id this computer does not have, or 500 `{ "error": "This computer could not remove that
phone. It is still paired, so try again." }` when the phones file could not be written. Revocation
fails closed: the record stays, in memory and on disk, until the write succeeds.

## Token lifecycle

| Moment | What happens |
| --- | --- |
| mint | a code is created, in memory only, 5 minute TTL |
| exchange | the code dies, a phone token is minted, its SHA-256 digest is written |
| restart | codes are gone (in memory); paired phones survive |
| revoke | the phone record is deleted. While another phone is still paired its next request is 401; removing the last one closes the socket, so its next poll simply fails and the page says the computer is not answering |
| code expires unscanned | the code is dropped and, with no phone paired, the socket closes without anybody clicking anything |
| idle | the listener stops when no code is live and no phone is paired |

Paired phones survive a daemon restart on purpose. The founder's ask is "no friction"; making a
phone re-pair after every daemon restart or reboot would be friction, and the credential it holds
is read-only, owner-only on disk (a digest, not the token), and revoked in one click from the
desktop. The listener does not idle on the LAN forever: with no live code and no paired phone,
nothing is bound - at first boot, after a cancel, after revoking the last phone, and after a code
sits unscanned past its five minutes (a timer minted with the code closes it).

## Failure modes and their copy

| What happened | What the phone shows |
| --- | --- |
| code unknown, used, or attempts burnt | "That pairing code is not valid. Show a new one on the computer." |
| code older than 5 minutes | "That pairing code expired. Show a new one on the computer." |
| token rejected by `/api/home` | "This computer removed this phone. Scan a new code to pair again." |
| the pairing could not be saved (500) | "The computer could not save the pairing. Nothing was paired. Show a new code and scan again." |
| the browser refused to store the token | the pairing still works for this visit, and the page says a reload will need a new code. |
| the page cannot reach the host at all | the browser's own "site can't be reached". The desktop copy says: keep both on the same network, and allow OpenRemote through the firewall. |
| no daemon / pairing off | the desktop's Mobile view says so, with the button that turns it on, and with no phones paired it also says nothing is listening |
| the daemon could not open the pairing port at start | the panel shows the daemon's own sentence (`notice`), so a paired phone that cannot reach this computer is explained instead of silent |

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
   is a follow-up, not tonight. The daemon bounds it to one line and 40 characters, which is the
   same bound the console applies before drawing it, so a phone cannot push a long name into the
   list.
7. **The QR encoder is hand-written in the console.** Neither lockfile has a QR dependency, and
   adding one is not allowed. `src/qr.js` is a small, tested, byte-mode encoder (versions 1 to 7,
   error correction level M), which covers payloads from 14 to 122 bytes; a pairing URL is at most
   about 40. Its tests read every symbol back the way a scanner does and check the format strings
   against the published table, because a transposed format block looks fine in a matrix and fails
   on a real phone.
8. **`cargo fmt` already fails at this branch's base** in `openremote-core/src/{model,store}.rs`
   (another session's in-flight work, blacklisted here). Those two files are untouched by this
   work, and the report names them as the only diffs the formatter finds.
9. **The listener binds the machine's own LAN address, not `0.0.0.0`.** The address is resolved
   before the socket is opened, and the QR carries that address, so binding it exactly means the
   socket exists on the interface the QR points at and on no other: not loopback aliases, not a
   VPN, not a second adapter the person did not mean to expose. The test asserts loopback does not
   answer. The listener records where it actually bound, and a mint that finds this computer
   advertising a different address closes that socket and rebinds, so after a DHCP lease moves, a
   switch from Wi-Fi to Ethernet, or a VPN coming up, the next code names an address something is
   listening on instead of repeating the stale one. While a code is already on screen the socket
   keeps the address the QR was drawn with; that QR is five minutes old at most, and a phone on the
   wrong network needs a new one anyway.

## How the security story is proved

Every claim above is a test in `daemon/crates/openremote-daemon/tests/e2e_pairing.rs`. The phone
half is a second HTTP client on loopback, so the flow under test is the shipped flow: the same
payload the console draws, the same exchange, the same token.

| Claim | Test |
| --- | --- |
| the owner token buys nothing on the LAN (401), and the phone token buys nothing on the loopback API (401, including the `/pairing/*` control routes) | `a_fake_phone_pairs_and_can_reach_only_its_own_route` |
| the LAN listener has no route that reads the owner token at all: `/sessions`, `/capabilities`, `/healthz`, `/pairing/*` answer 404 with either credential, because those routes are not merged into that router | `a_fake_phone_pairs_and_can_reach_only_its_own_route` |
| a used code is refused (404) and an expired one with 410, and neither mints a token or leaves a phone record behind | `a_code_is_single_use_and_expires` |
| five wrong guesses burn the live code rather than feeding a brute force | `wrong_codes_burn_the_live_code_rather_than_feed_guesses` |
| the socket is down at first boot (a refused connection, not a 401), comes up with a code, and closes by itself when that code expires unscanned | `nothing_listens_until_a_code_is_live` |
| revoking ends one phone's access while the other keeps working, and the last revoke closes the socket | `revoking_a_phone_ends_its_access_and_nothing_idles_on_the_lan` |
| the phones file holds a digest and never the token, and the phone survives a restart | `paired_phones_survive_a_restart_and_only_their_digest_is_written` |
| the shipped bind resolves a real address the phone can dial, and does not answer on loopback | `the_production_bind_puts_a_real_network_address_in_the_payload` |
| ten wrong guesses fired at once pair nothing, and the fifth burn takes the socket down with the code | `ten_parallel_wrong_guesses_pair_nothing` |
| a phones file that cannot be written leaves the phone paired and answers 500 rather than reporting a removal that did not happen | `a_revoke_that_cannot_be_saved_keeps_the_phone_paired` |
| a pairing whose record cannot be written hands out no token at all | `a_pairing_that_cannot_be_saved_hands_out_no_token` |

One rule is not in that table because the suite cannot reach it: a mint that fails after a previous code
was already live (the error arm calls cancel before it reports, so nothing stays redeemable behind an
error the user is looking at). The arm is reachable in production, which is why it exists: a mint after
the address moved can rebind and find every candidate port taken (`NoPort`), and a machine whose
network went away resolves nothing at all (`NoNetwork`). Proving it end to end would mean moving or
dropping this machine's network under a running daemon, which no test here can do. The report says it
is read, not proved.

## Explicitly out of scope tonight

- Driving harnesses from the phone: sending prompts, answering approvals, creating chats.
- Any public exposure, any tunnel or relay, any Cloud involvement, mDNS discovery. TLS with a
  certificate pinned at the first pairing is the next step (see the plain HTTP section), not a thing
  done tonight.
- One phone managing several desktops, or one desktop pairing with several phones at once (the
  list holds many phones; only one code is live at a time).
- Renaming a paired phone, per-phone permissions, or a phone session log.
- Installer firewall rules for the LAN port. Until those exist, Windows will ask the user, and a
  deny is a silent "site can't be reached" on the phone.
