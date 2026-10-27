# OpenRemote design contract

The design system for the OpenRemote console. This file is the reference of
record; the console transcribes it, never improvises past it.

---

name: OpenRemotePrototype
colors:
  app-canvas: "#0A0C0F"        # --bg-app - the whole main canvas
  sidebar: "#0F1216"           # --bg-side - sidebar + titlebar
  hover: "rgba(255,255,255,0.045)"
  active: "rgba(255,255,255,0.07)"
  line: "rgba(255,255,255,0.07)"   # 1px separators everywhere
  text-primary: "#E8EBEF"      # --text-1
  text-secondary: "#9AA3AE"    # --text-2
  text-muted: "#5F6873"        # --text-3
  accent: "#DCA24B"            # amber - primary interactive accent
  green: "#4CB487"             # running / ok
  idle-dot: "#4A525C"
typography:
  sans:
    fontFamily: "'Inter', -apple-system, 'Segoe UI', system-ui, sans-serif"
    weights: [400, 500, 600]
  mono:
    fontFamily: "'Geist Mono', ui-monospace, Consolas, monospace"
    use: install commands, code, paths - technical content only
  scale:
    greeting: 24px   # "What are we working on?"
    chat-title: 16px
    body: 14px       # chat messages
    ui: 13px         # most controls and labels
    dense: 12.5px    # facts rows, meta
    caption: 12px    # section titles, search
spacing:
  rhythm: 4px grid; paddings 6–16px; view gutters 32px
rounded:
  default: 7px       # --radius - cards, boxes, pickers
  full: 9999px       # dots, send buttons, pills

## Overview

A quiet, dense, machine-room dark UI: near-black canvas with a cool cast,
one amber accent, and a single green for life. Chrome recedes; the content
(chats, tools, commands) is the surface. No shadows for depth - 1px
`rgba(255,255,255,0.07)` lines and white-alpha tint steps define structure.
Everything is small and calm: 11–14px type, 7px radii, generous but not airy
spacing.

## Colors

- **Canvas `#0A0C0F` / sidebar `#0F1216`:** two dark steps only. The sidebar
  and frameless titlebar share `--bg-side`; the main canvas is `--bg-app`.
  Hover and active states are white-alpha tints (4.5% / 7%), not new colors.
- **Text tiers:** `#E8EBEF` primary, `#9AA3AE` secondary, `#5F6873` muted -
  cool greys, not warm.
- **Amber `#DCA24B` is the one accent:** primary buttons (send), waiting
  dots, brand marks, focus. Used sparingly - most chrome is grey.
- **Green `#4CB487` means running/ok:** the running dot (with a 2.4s breathe
  animation), agent activity. Never decorative.

## Typography

- Inter for all UI (400/500/600). Geist Mono strictly for technical content:
  install commands, code, paths, tool I/O.
- 12.5–13px is the working size for controls, facts, and meta; 14px for chat
  message text; 16px chat titles; 24px the New chat greeting only.

## Layout

- **Frameless window, custom titlebar (36px, `--bg-side`):** sidebar toggle,
  back/forward on the left; the centered title + about; then at the right end
  the split-view toggle (where VS Code keeps its split editor) and, on
  Windows, the caption glyphs - minimize, maximize/restore, close, drawn as
  MDL2's own 10px geometry rather than set in the font, because the font
  resolves some codepoints through fallback on a real Windows 10 box. macOS
  keeps its traffic lights at the left and draws no caption buttons. The
  whole bar is a drag region.
- **Sidebar (264px, collapsible):** mode switch (Local/Cloud), New chat tile,
  search, then nav tiles - Plugins and Automations in Local, Machines in
  Cloud (grid-rows reveal, reduced-motion aware); then the two sections -
  Projects (the registered ones, each with collapse caret and count, the
  `+` in the section head, unregister on hover; a project's chats grouped
  under it) and the flat Chats list (every chat that belongs to no
  project), each row led by its harness's brand mark with the status dot
  at the row's right edge; the footer is an icon row - Account, Mobile,
  Metrics, Settings - spaced evenly. The Mobile tile is the phones'
  status without words: green tile + black glyph while one is
  reachable, a hollow corner dot while away, quiet when there is none.
- **Settings is a window over the app:** a sidebar with a settings search
  and one tab per section, grouped General (New tasks, Appearance, Startup,
  Keyboard), System (Cloud, Daemon, Harnesses, MCP servers), Chats (Archived
  chats), and About (This install). Only the selected section fills the
  right pane, its rows in hairline groups rather than floating cards. Phone
  width stacks the search and a horizontal tab strip above the pane.
- **Main canvas:** one view at a time; views are flat lists/cards, not
  dashboards.
- **Panes (the split view), modelled on VS Code's editor groups:**
  - One pane is the whole main area and carries no header. Two or more
    panes each get a 30px header (`--bg-side`, one hairline under it): the
    pane's title on the left, then on the right the split action and an
    overflow that names every direction in words - "Split right", "Split
    down", "Split left", "Split up", each with its shortcut - then close
    on every pane but the primary. Direction is a word, never a bare
    directional glyph: the one icon-only button is split right and wears
    VS Code's split-editor shape (a page divided down the middle), which
    the titlebar's split toggle shares.
  - Five ways to split, in the order people find them: the titlebar's
    split toggle at the bar's right end, `Ctrl+\` (right) and
    `Ctrl+Shift+\` (down), a chat's context menu in the sidebar or main
    area, and dragging a chat - from the sidebar or from another pane's
    title - onto a pane. The middle of a pane opens the chat there; an
    outer band splits that pane on that side, with the half it is about to
    take tinted in the accent while the chat hovers. Panes are read-only
    drop targets for foreign drags: only a chat payload acts.
  - Focus moves with `Ctrl+1`..`Ctrl+4` in reading order; the focused pane
    carries a hairline accent inset and a brighter title.
  - Dividers are a 7px strip over a 1px line, with the resize cursor on
    the strip; dragging reallocates the two neighbours (neither below 15%)
    and double-clicking evens out that split's panes.
  - Four panes is the most. Every split action disables and says so at the
    cap, and a chat dropped on an edge at the cap opens in that pane
    instead of doing nothing.
  - A phone has no panes: one view, no headers.

## Components

- **Status dots (`dot--*`):** 6px pills of truth - `running` green (breathing),
  `waiting` amber, `idle` hidden. The same dot language everywhere. The
  chat header's facts dot breathes too, on the same 2.4s cycle.
- **Tool status (`cv-tool-status`):** every tool card carries its state,
  right-aligned on the name line - a breathing green dot and "Running" while
  in flight, a green check and "Done" when the result lands, a red check
  and "Failed" on error. The status flip is the beat of agent work.
- **Decision cards:** the question (where the harness asked one
  structurally) renders as content, 14px/500 `--text-1` inside the card;
  the pending state wears the brand amber (border `rgba(220,162,75,0.35)`,
  background `rgba(220,162,75,0.07)`), and the affirmative option is the
  one amber button. On answer the amber drains back to a settled card over
  0.3s and the label flips to a green "Answered: {choice}".
- **The composer family:** New chat's large box and the chat view's floating
  box share anatomy - autosizing textarea, a footer with pickers
  (Model `via` Harness) on the left, send button right. The foot's chips
  are plain ghost text (`nc-meta`: no fill, no border, the hover wash is
  the only affordance) - the film filled them as pills; the founder
  overrode that the day it shipped (2026-10-08): the pickers read as
  text, not buttons in boxes. The workspace/machine rows under the box
  share the same ghost. The floating chat composer publishes its
  measured height (`--cv-clear`) so the transcript's bottom padding keeps
  the last message above it, never under it.
- **Send button:** 30px radius-8 rounded square; amber (`--accent`) with a
  white arrow when ready, transparent with a muted arrow when empty. The
  press pulses - a scale dip to 0.8 and an amber glow bloom - the one
  recurring primary action, rewarded.
- **PickerMenu:** the one dropdown engine - opens at the cursor, searches,
  optional groups, keyboard-navigated, viewport-clamped.
- **Settings search:** one field above the tabs; searches every setting's
  label, keywords and description across sections. Results name their
  section, and choosing one opens that tab and marks the matching row.
- **Keyboard filter:** the Keyboard tab carries its own filter beside a
  Reset all action; an action answers by name, group, or current key
  ("Ctrl+N"), and the row being rebound stays visible while it is captured.
- **Switches (`tg-switch`):** real toggles for settings - 30x18 with a
  sliding knob, amber when on; green stays reserved for running/ok. On/Off
  words never stand in for a switch.
- **Modals:** one family (Esc / backdrop / X close): device, plugin, about,
  confirm, and the thirteen overlays `src/esc-layer-wiring.test.js` lists
  (counted as the files in its `MODALS` array). Panels, not surprise
  shapes. The onboarding panel is not one of them: it is a full-screen
  view with no backdrop and no X, one step at a time, each step with its
  own button out.
- **Context ring:** a 20px SVG donut of context-window usage (2px stroke,
  round cap, track `rgba(255,255,255,0.12)`), in the composer foot left of
  the send button, hover card with used/remaining/auto-compact rows.
  Renders wherever usage is known: codex reports its window too; claude
  reports usage only, so the fill rides a nominal 200k window and the card
  says so ("~200k tokens (nominal)", "Window: not reported yet").
- **Split-diff tints:** del `rgba(248,113,113,0.18)` / add
  `rgba(76,180,135,0.20)` - a fix reads as a change, not a faint wash
  (text colors unchanged: `#F87171` / `#4CB487`).
- **Press feedback on primaries:** send and decision buttons pulse on press
  (scale ~0.9-0.8 + an amber glow bloom where amber) - implemented once
  in the two families, applies to every primary action in the console.
- **Reduce motion:** a first-class setting (`data-reduce-motion` attr) kills
  the breathe and update animations; the preference is applied before
  first paint at boot, not just carried within a session.

## Motion

- One transition curve family (`cubic-bezier(0.2,0,0,1)`-ish), 0.12–0.18s.
- The running dot breathes 2.4s (sidebar rows, the facts dot, the
  in-flight tool status); the press pulse (scale dip + amber bloom) and
  the answered decision's 0.3s amber-drain are the only other moves.
- Measured, not felt: the Archive documents that native wheel scrolling beat
  a custom takeover; don't fight the compositor.

## Do's and Don'ts

- **Do:** keep grey chrome dominant; let amber mark interaction and green
  mark life; put technical content in mono; keep the dot language consistent.
- **Don't:** add shadows for hierarchy (1px lines + tints only); introduce
  new colors beyond the set; animate beyond the breathe, the press pulse,
  and hover fades; brighten the canvas.

---

## OpenRemote standing adaptations

- **Many-agent power tool:** the console supervises many concurrent harnesses;
  a chat view is a zoom-in, not the whole product.
- **Terminology parity:** present each harness's native options (approval
  modes, model/effort tiers) with the harness's own words - never invent
  OpenRemote vocabulary for them. A model's name is its catalog row's
  display name (claude's carries its own version, "Opus 5.5"); the console
  renders it through one shared lookup (`model-display.js`), which matches
  both spellings a harness reports - the pick word its picker takes and
  the resolved id a running session reports back - so a chat's name never
  changes when the first turn resolves the id. Where the catalog has no
  row, the raw id shows verbatim in a tooltip: never hidden, never
  re-cased, never parsed by the console.
- **No dead UI, ever:** controls that do nothing yet are not rendered.
- **Model selection is a reserved dock slot** until a harness advertises
  models through the daemon.
- **First run is a setup wizard** - connect, pick, start; one plain action
  per step.
- **Mobile is first-class:** the same visual language adapts to phone width,
  not a squeezed desktop.
- **Process:** build slowly; overthink single elements; review at real
  milestones only.
- **Vocabulary (2026-10-01, Cloud 2026-10-07, Projects 2026-10-08):** *chat*
  is the UI word for a conversation with a harness (the daemon domain says
  *session*; the console boundary translates). A *device* is any of your
  computers signed in to Cloud; a *machine* is a device that runs chats for
  your other devices. *task* is the prompt text a human or automation sends.
  A *project* is a registered entity the daemon stores (like rules and
  plugins): the folders whose chats group under it - exactly one this
  release, the list is the multi-folder future. A *workspace* is the folder a
  chat runs in - now optional; a chat with none belongs to no project and
  runs in the home folder. *Folder* is the disk thing; the word appears
  only inside the folder picker, never as a noun the UI groups by (the old
  derived basename grouping is gone - the sidebar's projects are the
  registered ones, everything else is the flat Chats section).

---

## Shipped - the parity build (2026-10-02)

Every screen the design specifies, backed by the real daemon:

- **New chat** - the greeting + composer; harness picker (installed only,
  with a pinned "Manage harnesses…" row that opens the harness manager:
  all six harnesses, each installable through its owner's own installer
  on Windows, macOS, and Linux - the command stays the daemon's, never
  shown; pi's Node.js is set up only after a calm go-ahead),
  model picker where the harness advertises (its own catalog, the model
  names alone - each row led by its own maker's real mark: Claude's
  starburst, OpenAI's hexapod, xAI's, Gemini, DeepSeek, Qwen, Kimi,
  Mistral, Meta, each its owner's official path in its official color,
  text alone where the maker is unknown - the effort picker offers the
  chosen model's own tiers
  right after, so the model rows carry no tier sublines), the permission
  picker where the harness has its own words (claude `--permission-mode`,
  codex `approvalPolicy`, grok `--permission-mode` - the vocabulary rides
  /capabilities, the harness's own default row marked "runs this by
  default", unset sends nothing so the default holds; agy/pi/opencode
  offer no words, so no chip), the Fast toggle
  where the harness's own fast mode is usable
  (claude `fastMode` ≥ 2.1.205, codex `fast` service tier ≥ 0.110), the
  project picker (the registered projects on the machine the chat runs
  on, "No project", and the picker's own Add project row - the one way
  in, which the in-app folder picker serves for every surface that asks:
  the sidebar's +, the settings rows, itself), the In-progress list.
- **Chat** - the rail transcript (user cards, agent text, notes, tool
  cards with In/Out, decisions in the harness's own words with its
  affirmative first), the facts row (workspace · harness · model ·
  effort · permission word · Fast · «tool» allowed for this chat ·
  status - the permission word shown in the harness's own spelling,
  changeable only while stopped: start-time on every harness, so a
  stopped chat's change lands on resume), stop/resume, the floating
  composer with the ContextRing where the harness reports its window
  (codex; claude reports usage but no window on the wire).
- **Machines** - Cloud's view of the account's devices (2026-10-07): this
  computer first with its "Make this computer a machine" row, then each
  device's card (platform, Machine/Desktop, version, online). A device's
  detail lists the synced chats it runs (from this computer's copies, so
  they show while it's offline) and, for an online machine, its harnesses -
  installed and signed in remotely through the same installer chain and
  sign-in relay. Add a machine mints a one-time Linux install command and
  notices the arrival; Remove is asked twice and says what it deletes.
- **Plugins** - MCP installs written by hand; the needs-key lifecycle
  (keys never cross the API); the ride-along through each harness's own MCP wire (claude `--mcp-config`
  JSON string, codex `thread/start` config keyPaths).
- **Automations** - rules with real sources only (a schedule on the
  machine's own clock, a webhook with its own key), Run now, the form,
  and the everywhere-pill (the keyword parser,
  the rule-draft action card, honest refusals for connector-only kinds).
  A rule's Chat section carries the permission picker too - the word
  rides the chat the rule fires.
- **Settings** - a view (section rail), not a popup: new-task defaults
  (harness/model/workspace, per-harness effort tier and permission word
  in the harness's own words - the same pickers the composer holds,
  rendered only where the default harness offers them), appearance
  (compact density; the dark theme is contract), startup
  (launch at login, reopen last view vs New chat), the daemon connection
  (the address, connect by address, which opens the manual form while
  nothing is connected, chats on record, restart, two-step Forget), the
  harness list,
  reduce-motion (restored before first paint), first-run replay.
- **Account, Mobile, Metrics** - the footer's views (2026-10-15), each
  rendering before Cloud's sign-in door with its own signed-out row:
  Account carries the sign-in state and its actions, this device's
  identity, and the devices count (its Machines button crosses modes);
  Mobile is the phone companion page in two halves that do not depend on
  each other: first the pairing panel (a QR code, the phones paired with
  this computer on the local network, each one removable), which needs no
  account at all; then the install-and-sign-in lead, the account's phones
  as cards opening the same device detail, and the signed-out row when
  there is no account; Metrics counts the polled record (status
  sentence, the synced split, per-harness counts, a 14-day strip of new
  chats) beside this machine's 48-cell presence band, all derived from
  the poll - cost and tokens stay out until the daemon aggregates them.

## Cloud mode (2026-10-07)

Local is this computer's chats and needs no account. Cloud is the user's
own computers working together through moreweb, end to end encrypted:
moreweb relays ciphertext and never stores a chat.

- **The door:** Cloud shows its sign-in screen (the cloud art, one amber
  action, Back to Local) until this computer is signed in. Signing in
  happens in the system browser; first launch never asks.
- **Lists:** Local lists everything that runs on this computer (synced
  ones carry a small cloud mark). Cloud lists every synced chat, with the
  device it runs on named in muted text and a hollow ring while that
  device is away. A copy stays readable offline.
- **New chat in Cloud:** a machine picker (this computer first, then the
  account's machines, online first) and that machine's own harnesses and
  models; its folders are browsed in the app (FolderBrowserModal), never
  typed. Chats made in Cloud sync to every device.
- **A chat on another device:** prompts, stop, resume and answers travel
  to it. When they can't, the composer says why (offline, not a machine,
  signed out, gone) and offers "Make it a machine" where that is the fix.
  Synced chats can be deleted everywhere, asked twice.
- **Notices:** a thin row above the main area for a device that joined the
  account ("Not you?" - any sign-in adds one), and for this computer made
  a machine from elsewhere (Undo). Shown once each.
- **While OpenRemote is open:** a desktop that is a machine serves its
  devices only while the app runs; the copy says so.
- **Keep running in the tray:** a Settings > Startup row, on by default
  while this computer is a machine. Closing the window then hides it;
  Quit lives in the tray menu. Where no tray can be shown (Linux without
  appindicator) the row is absent.
- **Sync this chat:** a private chat's facts row offers Sync once
  signed in, asked first ("tool output included"); the chat then syncs
  like one made in Cloud, running where it is.

Deferred: the updater and its badge, auto-update, the Linux AppImage
build, signed releases, machine installers beyond Linux, moving a chat
between machines and switching
its harness mid-chat (one hand-over mechanism), the connector triggers
(pipeline/errors/review/release), the agent behind the pill, claude's
context *window* on the wire (the ring rides a nominal 200k until the
stream-json carries one), grok/pi/opencode/agy MCP wires.

## Shipped - the film's design, adopted (2026-10-08)

The launch film's console mock beat the app in nine places
(`DESIGN-FROM-THE-FILM.md` is the delta; the rule is where the film's
design wins, the film leads). All adopted, every value transcribed
from the film's own components:

- **Tool cards carry status** - breathing green "Running" in flight,
  green check "Done" / red check "Failed" on landing, right-aligned on
  the name line. A tool left unresolved by an interrupted turn shows
  no status word - never a false Running.
- **Decision cards** - the structured question as content, pending
  amber (border 0.35 / fill 0.07), amber affirmative, settle to grey
  over 0.3s, green "Answered: {choice}" (the choice's label, never its
  wire id).
- **Amber send with press bloom** - ready amber + white arrow, empty
  quiet, press scales 1→0.8→1 with an 18→62px amber glow; the
  everywhere-pill's send speaks the same language.
- **Not adopted - the film's filled pill chips** (its §4): the founder
  overrode them the day the adoption shipped (2026-10-08) - the
  Model/Effort/Harness/Fast pickers stay plain ghost text, no fill, no
  border, same as the workspace/machine rows. The founder's word beats
  the film.
- **Diff tints doubled** - del 0.18 / add 0.20.
- **The context ring always renders where usage is known** - moved left
  of the send button, 2px stroke, track 0.12; claude rides a nominal
  200k window (the hover card says so) until its wire carries one.
- **The facts dot breathes** (2.4s, all statuses).
- **Sidebar rows** - the harness mark leads, the title follows, the
  status dot at the row's right edge (one vertical column of statuses).
- **Press feedback on primaries** - both send buttons, the decision
  affirmative; all of it under `data-reduce-motion`.

## Checking this contract

Most of this page can be checked without opening the app: `npm test` runs
the console's rule tests (279 of them the last time this line was checked,
and the run prints the live count) and a handful
of wiring tests read the source text for the parts only a browser could
show, such as the modal family and the waiting screen's doors. Colour,
type and motion are not testable that way, so a change to them is checked
by eye at both motion settings (`prefers-reduced-motion` and the in-app
toggle) before it counts as done.
