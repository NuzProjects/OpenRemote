# Writing an OpenRemote plugin

A plugin is a folder. It is Claude Code's plugin layout (skills, agents,
commands, hooks, MCP servers under `.claude-plugin/`) plus OpenRemote's
own part in `openremote.json` beside it, so one folder can be a plugin to
both. This guide covers the OpenRemote part: what a plugin runs, what it
adds to OpenRemote, and what it may do.

Two examples sit in this repo:

- [`examples/plugins/toy-harness`](../../examples/plugins/toy-harness):
  a process plugin that wraps a toy command-line agent as a harness and
  gives agents one tool. Node.js, no dependencies.
- [`examples/plugins/text-tools`](../../examples/plugins/text-tools):
  a WASM plugin with three agent tools, written in Rust, one of them
  reaching the internet.

The protocol a plugin's code speaks is in [protocol.md](protocol.md).

## The folder

```
my-plugin/
  openremote.json          OpenRemote's part (this guide)
  .claude-plugin/
    plugin.json            Claude Code's part, when it has one
  skills/ agents/ commands/ hooks/ .mcp.json    Claude Code parts, if any
  ...                      the plugin's own files: its program, module, pages
```

A plugin without `openremote.json` is a Claude Code plugin; OpenRemote
installs and runs those too (its runtime is shown as "Claude plugin").

## openremote.json

```json
{
  "api": 1,
  "name": "ssh-machines",
  "version": "1.2.0",
  "description": "Your SSH hosts, for you and your agents.",
  "runtime": "process",
  "entry": {"command": "node", "args": ["${OPENREMOTE_PLUGIN_ROOT}/main.js"]},
  "powers": ["run_programs", "network"],
  "contributes": {
    "tools": [ ... ],
    "views": [ ... ],
    "settings": [ ... ]
  }
}
```

| Field | Required | |
|---|---|---|
| `api` | yes | `1`. |
| `name` | yes, here or in `.claude-plugin/plugin.json` | Lowercase letters, digits and dashes, up to 64. Not a built-in harness's id. |
| `version` | no | Shown at install; updates compare it. |
| `description` | no | One line, shown at install. |
| `runtime` | yes | `process`, `wasm`, `js` or `content` (below). |
| `entry` | for `process` and `wasm` | What it runs (below). |
| `powers` | no | What it may do (below). |
| `contributes` | no | What it adds to OpenRemote (below). |

Everything is checked when the plugin is read for install. A mistake is
refused with a message that names it, and a `contributes` kind this
OpenRemote doesn't know is refused rather than ignored, so the user
always sees everything a plugin adds before approving it.

### Runtimes

- **`process`**: a program OpenRemote starts and talks to over stdio
  ([protocol.md](protocol.md)). It can give agents tools, drive a
  harness, and answer its own views. It **runs as you, not sandboxed**:
  it can do anything your account can, and the install screen says so in
  those words. Pick it when you need the machine: a CLI to wrap, SSH,
  files, a local database.
- **`wasm`**: agent tools compiled to WebAssembly, run inside the daemon,
  sandboxed. It sees its own memory and only the host functions its
  powers grant (with `network`, HTTP requests to the internet). Pick it
  for tools that compute or call web APIs.
- **`js`**: a plugin that lives in the console, in a sandboxed frame:
  composer buttons and views of its own.
- **`content`**: a Claude Code plugin with no OpenRemote code of its own
  (skills, agents, commands, hooks, MCP servers).

### entry

- A **process** plugin's entry is the program to run:
  - a path inside the plugin's folder, run as it is
    (`"entry": "bin/my-plugin"`), or
  - a command with arguments:
    ```json
    "entry": {
      "command": "node",
      "args": ["${OPENREMOTE_PLUGIN_ROOT}/main.js"],
      "windows": {"command": "${OPENREMOTE_PLUGIN_ROOT}/bin/my-plugin.exe", "args": []}
    }
    ```
    `${OPENREMOTE_PLUGIN_ROOT}` stands for the plugin's folder. A command
    with a slash that isn't an absolute path is a file in the plugin's
    folder; a bare name (`node`, `python3`) is found on the PATH. The
    optional `windows`, `macos` and `linux` entries replace the command on
    that system. A program inside the plugin must be there at install.
- A **wasm** plugin's entry is its module: `"entry": "tool.wasm"`. The
  install screen refuses a module that doesn't compile, doesn't export
  what OpenRemote calls, or imports more than its powers allow.
- A **js** plugin's entry, when it has one, is its main page or script.

### powers

What a plugin may do, approved by the user at install, in these words:

| Power | The user sees |
|---|---|
| `run_programs` | Run programs on this computer |
| `read_chats` | Read chats and project files |
| `agent_tools` | Give agents tools, and start, steer and stop chats |
| `network` | Reach the internet |
| `microphone` | Use the microphone |

Some powers come with what a plugin is, and are shown like the rest
without being listed: a process plugin runs programs, a plugin with
harnesses runs programs, a plugin with agent tools has `agent_tools`, and
a Claude Code plugin's hooks and MCP servers run programs. An update that
asks for a new power says so at review.

What the powers gate in OpenRemote's own surfaces:

- a WASM module may import `http` only with `network`;
- a process plugin's calls to OpenRemote (`chats/list`, `chats/read`
  need `read_chats`; `chats/start`, `chats/prompt`, `chats/stop` need
  `agent_tools`).

A process plugin runs as you whatever it declares: declare honestly, the
user decides on what you say.

### contributes

#### harnesses

A harness the plugin drives, listed in pickers beside the built-in six.
Process plugins only.

```json
"harnesses": [{
  "id": "toy",
  "name": "Toy CLI",
  "description": "Echoes what you say.",
  "models": [{"model": "toy-echo", "display_name": "Toy Echo", "efforts": [], "default": true}],
  "permission_modes": ["ask", "allow"],
  "default_permission": "ask",
  "fast": false,
  "one_prompt_at_a_time": true,
  "steers_mid_turn": false
}]
```

- `id`: lowercase letters, digits and dashes, a letter first, up to 32;
  unique on the machine (another installed plugin's harness, or a
  built-in harness, can't share it). Each chat records it.
- `name`: how pickers name it.
- `models`: the harness's own model names. With none listed, OpenRemote
  asks the plugin (`harness/models`) when a picker needs them.
- `permission_modes`: the harness's own permission words, and its
  `default_permission`. With none, no permission picker shows.
- `fast`: it has a fast mode.
- `one_prompt_at_a_time`: a message sent while a turn runs waits in the
  queue (a CLI that runs once per prompt).
- `steers_mid_turn`: a message sent while a turn runs lands inside it.

A plugin with harnesses installs for this machine or every device, not
for one project: pickers are per machine.

#### tools

Tools a chat's agent can call. Process and wasm plugins.

```json
"tools": [{
  "name": "run_command",
  "description": "Run a shell command on one of your SSH hosts and get its output.",
  "input_schema": {
    "type": "object",
    "properties": {"host": {"type": "string"}, "command": {"type": "string"}},
    "required": ["host", "command"]
  },
  "read_only": false,
  "timeout_secs": 120
}]
```

- `name`: lowercase letters, digits and underscores, a letter first. The
  agent calls it `<plugin name>__<tool name>`, and its full MCP name
  (`mcp__openremote__<plugin>__<tool>`) must fit 64 characters.
- `description`: how the agent knows when to call it. Write it for the
  agent.
- `input_schema`: a JSON Schema object (MCP's `inputSchema` spelling
  reads too).
- `read_only`: the tool only reads. The agent sees it as MCP's
  read-only hint; it never skips the chat's own approval.
- `timeout_secs`: 1 to 600; 120 when left out.

Tools are listed from the manifest, so listing them starts nothing; a
process plugin starts at its first call. Every chat on the machine gets a
Global or Machine plugin's tools; a chat in a project gets that
project's too.

#### composer_inputs

Buttons in the composer's bottom row, each running a page of the plugin
in a sandboxed frame.

```json
"composer_inputs": [{"id": "dictate", "label": "Dictate", "icon": "Microphone", "entry": "ui/dictate.html"}]
```

- `id`: lowercase letters, digits and dashes.
- `label`: up to 40 characters.
- `icon`: a [Phosphor](https://phosphoricons.com) icon's name, the set
  OpenRemote draws its own icons with.
- `entry`: the page, a path inside the plugin. A js plugin may leave it
  out: its own entry answers its buttons.

#### views

Pages of the plugin's own, run in a sandboxed frame from its files.

```json
"views": [{"id": "hosts", "title": "SSH hosts", "place": "machines", "icon": "HardDrives", "entry": "ui/hosts.html"}]
```

- `place`: `sidebar` (a tile under Plugins), `machines` (a section of the
  Machines view) or `settings` (the plugin's own Settings page).
- `entry`: the page, a path inside the plugin.

A view's page reaches its plugin's program through the console (the
daemon's `POST /plugins/{id}/request`, arriving as `ui/request`).

#### settings

Values the user sets for the plugin, on its Settings page.

```json
"settings": [
  {"key": "default_user", "type": "string", "label": "Default user", "help": "Used when a host names none.", "default": "deploy"},
  {"key": "api_token", "type": "secret", "label": "API token", "required": true},
  {"key": "verbose", "type": "boolean", "label": "Verbose logs", "default": false},
  {"key": "timeout", "type": "number", "label": "Timeout (seconds)", "default": 30, "min": 1, "max": 600},
  {"key": "region", "type": "enum", "label": "Region", "options": ["eu", "us"], "default": "eu"}
]
```

- `key`: lowercase letters, digits and underscores.
- `type`: `string`, `secret`, `boolean`, `number` or `enum`.
- `label` and `help`: what the user reads.
- `default`: must fit the type; a secret has none.
- `options`: an enum's choices, as strings or `{"value", "label"}`.
- `min`, `max`: a number's bounds.
- `required`: the plugin doesn't run until it is set; a tool call says
  which setting is missing.

The values are kept on each machine, in a file only the user can read.
Secrets never come back out through the API (only whether they are set)
and never leave the machine they were typed on - a Global plugin's
settings are set on each device. A process plugin gets the values in
`initialize` and `settings/changed`; a WASM plugin gets them in every
call's input.

## Install scopes

The user picks who a plugin is for when installing:

- **Every device** (`global`): approved once for the account and
  installed on each of its devices, which copy the exact approved files
  from one another over Cloud. Any device can turn it off for itself; a
  device that was offline catches up when it is back.
- **This machine** (`machine`): this machine only.
- **One project, outside the repo** (`project_local`): the files stay in
  OpenRemote's own folder; only chats in that project get it.
- **One project, in the repo** (`project`): the files go into the
  project's folder at `.openremote/plugins/<name>/`, with a note in
  `.openremote/plugins.json` of where it came from, so whoever clones
  the repo has them. Files are not approval: each machine reviews and
  approves the plugin before it runs, and runs exactly the files it
  approved. A change in the repo waits for a new review.

A plugin made by a marketplace's command installs for this machine only,
and a plugin with harnesses can't be for one project.

## Trying a plugin

Install it from its folder: Plugins, Install from a file or link,
Folder. The review shows what OpenRemote read. A process plugin's stderr
and its `log` lines appear on the daemon's stderr, prefixed with its id.

## Publishing in a marketplace

A marketplace is Claude Code's own catalog
(`.claude-plugin/marketplace.json`). OpenRemote reads what an entry says
about it for OpenRemote from the entry's `metadata.openremote`, so
Discover can show it before anyone installs:

```json
{
  "name": "ssh-machines",
  "source": {"source": "github", "repo": "someone/ssh-machines", "sha": "4f2c..."},
  "description": "Your SSH hosts, for you and your agents.",
  "metadata": {"openremote": {"runtime": "process", "powers": ["run_programs", "network"]}}
}
```

The install still reads and checks the plugin itself.
