# The OpenRemote plugin protocol

How OpenRemote talks to a plugin's code. Two runtimes run in the daemon
and share one tool contract:

- **Process plugins** (`"runtime": "process"`): a program OpenRemote starts
  and talks to over its stdin and stdout. It can give agents tools, drive a
  harness, and answer its own views. It runs as the user, not sandboxed.
- **WASM plugins** (`"runtime": "wasm"`): agent tools compiled to
  WebAssembly, run inside the daemon, sandboxed.

A plugin's manifest (`openremote.json`, described in
[authoring.md](authoring.md)) declares what it contributes. OpenRemote
reads the declaration at install, shows it to the user for approval, and
uses it afterwards without asking the plugin: the agent tools a chat lists
come from the manifest, so listing them never starts a program.

This is protocol version **1**.

## Process plugins

### Framing

- JSON-RPC 2.0 messages, one per line: UTF-8 JSON, ended by `\n`. No
  `Content-Length` headers.
- stdout carries protocol messages and nothing else. A line that isn't JSON
  is dropped with a note on OpenRemote's stderr.
- stderr is the plugin's log: each line appears on OpenRemote's stderr as
  `plugin <id>: <line>`.
- A line may be up to 16 MiB (a tool result can carry pictures).
- Both sides send requests (with an `id`), answers (with the same `id`
  and `result` or `error`) and notifications (no `id`, no answer).
- **When stdin closes, OpenRemote is gone: exit.** This is what keeps a
  plugin from outliving the daemon if the daemon is killed.

### Lifecycle

- One program per plugin per machine, started the first time something
  needs it: an agent's tool call, a chat on its harness, a model or
  command list for its harness, or one of its views asking it something.
  Nothing starts at install or at boot.
- It runs in the plugin's folder, with these variables set:
  - `OPENREMOTE_PLUGIN_ID`: its id, `name@marketplace` (with
    `~<project>` for a project install);
  - `OPENREMOTE_PLUGIN_ROOT`: the plugin's folder;
  - `OPENREMOTE_PLUGIN_DATA`: a folder of its own for what it keeps,
    private to the user.
- Its settings, secrets included, reach it in `initialize` and in
  `settings/changed`, never on the command line or in the environment
  (which other programs can read). OpenRemote never logs them.
- OpenRemote stops the program when the plugin is turned off, updated or
  removed, and when the daemon exits. The next need starts it again.
- A program that stops by itself is started again at the next need, after
  a pause: 1 s, then 2 s, 4 s and so on up to a minute while it keeps
  stopping within a minute of starting. Calls during the pause fail with a
  message that says when it starts again.
- Chats a plugin drives end when its program stops (each chat gets a final
  stderr line and closes).

### `initialize` (OpenRemote to plugin)

The first call. Answer within 20 seconds.

```json
{"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {
  "protocol": 1,
  "openremote": "0.3.2",
  "plugin": {
    "id": "ssh-machines@openremote",
    "name": "ssh-machines",
    "version": "1.2.0",
    "root": "/home/me/.openremote/plugins/openremote/ssh-machines",
    "data": "/home/me/.openremote/plugin-data/ssh-machines@openremote",
    "scope": "machine"
  },
  "powers": ["run_programs", "agent_tools", "network"],
  "settings": {"default_user": "deploy", "key_passphrase": "..."},
  "platform": "linux"
}}
```

- `scope` is `global`, `machine`, `project_local` or `project`.
- `powers` are the ones the user approved.
- `settings` holds every declared setting that has a value (set by the
  user, else its default). Secrets are included. A required setting is
  always set: OpenRemote doesn't start a plugin whose required settings
  are missing, and says which ones instead.
- `platform` is `windows`, `macos` or `linux`.

Answer with the protocol version you speak. Anything else is ignored for
now:

```json
{"jsonrpc": "2.0", "id": 1, "result": {"protocol": 1}}
```

An answer naming another version stops the program with an error the user
sees.

### `settings/changed` (OpenRemote to plugin, notification)

The user saved new values. Same shape as `initialize`'s `settings`:

```json
{"jsonrpc": "2.0", "method": "settings/changed", "params": {"settings": {"default_user": "root"}}}
```

### `log` (plugin to OpenRemote, notification)

```json
{"jsonrpc": "2.0", "method": "log", "params": {"level": "info", "message": "connected to 3 hosts"}}
```

The line lands on OpenRemote's stderr as `plugin <id> [<level>]:
<message>`, cut at 2000 characters. Never log secrets.

### Agent tools: `tools/call` (OpenRemote to plugin)

A chat's agent called one of the tools the manifest declares. The agent
sees each tool on OpenRemote's MCP server as `<plugin name>__<tool name>`
(two underscores); the plugin is called with its own tool name.

```json
{"jsonrpc": "2.0", "id": 7, "method": "tools/call", "params": {
  "name": "run_command",
  "arguments": {"host": "web-1", "command": "uptime"},
  "chat": {"id": "2320d324-78ce-4ee1-b13e-18e7ca310f14", "workspace": "/home/me/code/site"}
}}
```

`chat.workspace` is null for a chat in no project. Answer with an MCP tool
result:

```json
{"jsonrpc": "2.0", "id": 7, "result": {
  "content": [
    {"type": "text", "text": " 10:42:01 up 12 days,  3 users,  load average: 0.08"},
    {"type": "image", "data": "<base64>", "mimeType": "image/png"}
  ],
  "isError": false
}}
```

- `content` items are MCP's: `text` (`text`) and `image` (`data` in
  base64, `mimeType`). Other MCP content types pass through as they are.
- A plain string `result` is taken as one text item.
- A tool that failed in a way the agent should read answers a result with
  `"isError": true`. A JSON-RPC `error` reaches the agent as an error
  result too, prefixed with the plugin's name.
- The call waits for the tool's `timeout_secs` from the manifest (1 to
  600), else 120 seconds; then the agent is told it timed out.
- Every call is approved like any other MCP tool call: the chat's
  permission mode decides whether the user is asked. A tool's
  `read_only` flag reaches the agent as MCP's `readOnlyHint` and never
  skips that approval.

### Harness methods (OpenRemote to plugin)

A plugin that contributes a harness drives it through these calls, and
reports what happens through `harness/event` notifications. The methods
mirror OpenRemote's own drivers, so a plugin harness works like the
built-in six: it is listed in pickers, chats run on it, its questions
become decision cards, and stopped chats resume.

One program drives any number of chats at once. Each chat is a
**session**: a handle OpenRemote picks (`s-<uuid>`) and names in every
call and event about that chat.

#### `harness/spawn`

Start a chat. Answer once the session is ready for its first prompt.

```json
{"jsonrpc": "2.0", "id": 3, "method": "harness/spawn", "params": {
  "session": "s-6f0d...",
  "harness": "toy",
  "cwd": "/home/me/code/site",
  "model": "toy-echo",
  "effort": null,
  "permission_mode": "ask",
  "resume": null,
  "fast": false,
  "mcp_servers": [
    {"id": "openremote", "command": "/opt/openremote/openremote-daemon",
     "args": ["mcp-chat", "--session", "...", "--port", "...", "--data-dir", "..."]}
  ],
  "allowed_tools": ["mcp__openremote__browser_snapshot"]
}}
```

- `harness` is one of the plugin's harness ids.
- `model`, `effort` and `permission_mode` are words the manifest lists
  (or null: the harness's own default).
- `resume` is null for a new chat, or the `session_ref` an earlier
  session of this chat answered with: open that conversation again.
- `mcp_servers` are the MCP servers OpenRemote gives this chat, its own
  per-chat server among them. A harness that takes MCP servers passes
  them on; one that can't ignores them.
- `allowed_tools` are tools that run without asking, in Claude Code's
  `mcp__<server>__<tool>` names, for a harness that has such a list.

Answer with the harness's own name for the conversation (what a resume
hands back), and the model and permission mode it runs, when known:

```json
{"jsonrpc": "2.0", "id": 3, "result": {"session_ref": "c41e...", "model": "toy-echo", "permission_mode": "ask"}}
```

A spawn answer without `session_ref` can send an `initialized` event
later instead. An `error` answer fails the chat with its message.

#### `harness/prompt`

```json
{"jsonrpc": "2.0", "id": 4, "method": "harness/prompt", "params": {"session": "s-6f0d...", "text": "fix the failing test"}}
```

Answer as soon as the prompt is accepted. The turn itself is reported
through events and always ends with a `turn_completed` event.

If the manifest says `one_prompt_at_a_time`, OpenRemote never sends a
prompt while a turn runs: messages wait in the chat's queue. If it says
`steers_mid_turn`, a prompt sent while a turn runs belongs to that turn
(the harness folds it in and ends the turn once). Otherwise a prompt
during a turn opens a new turn after it.

#### `harness/settings`

A live change of model, effort or fast mode (each field null when it
doesn't change). Answer with an `error` for a change the harness can't
make while it runs; the user is told to stop the chat and resume it.

```json
{"jsonrpc": "2.0", "id": 5, "method": "harness/settings", "params": {"session": "s-6f0d...", "model": "toy-mirror", "effort": null, "fast": null}}
```

#### `harness/interrupt`

Stop the running turn. The turn still ends with a `turn_completed` event,
with `outcome` `interrupted`.

```json
{"jsonrpc": "2.0", "id": 6, "method": "harness/interrupt", "params": {"session": "s-6f0d..."}}
```

#### `harness/answer`

The user answered one of the harness's questions (an `approval` or
`question` event), with one of the option ids it offered.

```json
{"jsonrpc": "2.0", "id": 8, "method": "harness/answer", "params": {
  "session": "s-6f0d...", "ref": "q-1", "choice": "allow", "request": {"prompt": "please shout this"}
}}
```

`request` is the event's `request`, given back. Answer with what the
choice means for the turn and the session:

```json
{"jsonrpc": "2.0", "id": 8, "result": {"interrupts_turn": false, "session_grant": null}}
```

- `interrupts_turn`: the choice ends the turn (the harness's boundary
  event follows).
- `session_grant`: the harness now allows this tool for the rest of the
  session, named in the harness's own words.

#### `harness/stop`

End the chat's session. The program keeps running for its other chats
and tools. Answer within 10 seconds; OpenRemote closes the chat either
way.

```json
{"jsonrpc": "2.0", "id": 9, "method": "harness/stop", "params": {"session": "s-6f0d..."}}
```

```json
{"jsonrpc": "2.0", "id": 9, "result": {"exit_code": 0}}
```

#### `harness/models` (optional)

Asked when the manifest's harness lists no `models` and a picker needs
them. Answer `-32601` (method not found) when the harness lists none.

```json
{"jsonrpc": "2.0", "id": 10, "method": "harness/models", "params": {"harness": "toy"}}
```

```json
{"jsonrpc": "2.0", "id": 10, "result": {"models": [
  {"model": "toy-echo", "display_name": "Toy Echo", "efforts": [], "default": true}
]}}
```

#### `harness/commands` (optional)

What a composer's `/` and `@` menus offer for the harness in a folder.
Answer `-32601` when it lists nothing.

```json
{"jsonrpc": "2.0", "id": 11, "method": "harness/commands", "params": {"harness": "toy", "cwd": "/home/me/code/site"}}
```

```json
{"jsonrpc": "2.0", "id": 11, "result": {
  "commands": [{"name": "review", "description": "Review the diff", "argument_hint": "<branch>", "aliases": []}],
  "agents": [{"name": "tester", "description": "Writes tests"}]
}}
```

### `harness/event` (plugin to OpenRemote, notification)

Everything a driven chat does:

```json
{"jsonrpc": "2.0", "method": "harness/event", "params": {"session": "s-6f0d...", "event": {"type": "text", "text": "Done."}}}
```

| `type` | Fields | Meaning |
|---|---|---|
| `initialized` | `session_ref`, `model`?, `permission_mode`? | The conversation is named (when the spawn answer didn't). |
| `text` | `text` | A whole message from the agent. |
| `text_delta` | `text` | A piece of a message as it streams. |
| `reasoning` | `text` | The agent's reasoning, shown dim and folded. |
| `reasoning_delta` | `text` | A piece of reasoning as it streams. |
| `tool_started` | `id`, `name`, `input` | The harness ran one of its tools. |
| `tool_result` | `id`, `name`, `text`, `is_error`? | That tool's result. |
| `approval` | `ref`, `options`, `tool_name`?, `summary`?, `request`?, `interrupts_turn`? | The harness asks permission. |
| `question` | same as `approval` | The harness asks a question. |
| `turn_completed` | `outcome`, `subtype`?, `error`? | The turn ended. |
| `context` | `used`, `window`? | The conversation's size in tokens. |
| `cost` | `usd` | What the turn cost. |
| `compacted` | | The harness compacted the conversation. |
| `model` | `model` | The model it now runs. |
| `commands` | `names` | The command names it offers now (refreshes the `/` menu). |
| `stderr` | `line` | A diagnostic line: the last few explain a failed chat. |
| `closed` | | The session ended on its own: the chat stops. |

- `options` are `[{"id": "allow", "label": "Allow"}, ...]`, in the
  harness's own words; the answer comes back as `harness/answer` with
  the same `ref`.
- `interrupts_turn` lists the option ids that end the turn.
- `outcome` is `completed`, `interrupted` or `failed`; `subtype` is the
  harness's own word for it, kept verbatim; `error` explains a failure in
  the transcript.
- A turn's boundary is always explicit: every prompt's turn ends with
  exactly one `turn_completed`.

### Views: `ui/request` (OpenRemote to plugin)

A plugin's view (a page the console runs in a sandboxed frame) asked the
plugin's program something. The console relays it through the daemon's
`POST /plugins/{id}/request`.

```json
{"jsonrpc": "2.0", "id": 12, "method": "ui/request", "params": {"name": "hosts", "params": {}}}
```

Answer with whatever JSON the view expects. The call waits 60 seconds.

### Calls to OpenRemote (plugin to OpenRemote)

A plugin can ask OpenRemote for a few things, each one only with a power
the user approved. A call without the power fails with code `-32003`.

| Method | Power | Params | Result |
|---|---|---|---|
| `chats/list` | `read_chats` | | `{"chats": [{"id", "title", "harness", "model", "status", "workspace", "updated_at"}]}` |
| `chats/read` | `read_chats` | `{"chat"}` | `{"text"}`: the chat's messages, oldest first |
| `chats/start` | `agent_tools` | `{"harness", "workspace"?, "model"?, "effort"?, "prompt"?}` | `{"chat"}` |
| `chats/prompt` | `agent_tools` | `{"chat", "text"}` | `{"queued": true}`: sent now, or after the running turn |
| `chats/stop` | `agent_tools` | `{"chat"}` | `{"stopped": true}` |

A chat a plugin starts runs on this machine with the harness's default
permissions: a plugin can't grant a chat more than one the user starts
gets.

### Errors

Standard JSON-RPC codes, plus OpenRemote's own:

| Code | Meaning |
|---|---|
| `-32601` | No such method. Optional methods answer this. |
| `-32602` | Bad params. |
| `-32000` | The call failed (its message says why). From OpenRemote: the plugin stopped. |
| `-32001` | From OpenRemote: the plugin didn't answer in time. |
| `-32003` | From OpenRemote: the plugin lacks the power for that call. |

## WASM plugins

A WASM plugin is a WebAssembly module whose exports OpenRemote calls for
each agent tool call. It runs inside the daemon, sandboxed: it sees its
own memory and the host functions its powers grant, nothing else. Each
call runs on a fresh instance, so nothing carries over between calls or
chats.

### The module

Exports:

- `memory`: its linear memory.
- `or_alloc(len: i32) -> i32`: reserve `len` bytes, return where.
- `or_call(ptr: i32, len: i32) -> i64`: run one call. The input is `len`
  bytes of JSON at `ptr`. Return `(out_ptr << 32) | out_len`: where the
  answer's JSON lies in memory.

The input:

```json
{
  "tool": "slugify",
  "arguments": {"text": "Hello, World"},
  "settings": {"separator": "-"},
  "chat": {"id": "2320d324-...", "workspace": "/home/me/code/site"}
}
```

`settings` holds the plugin's declared settings (set, else default),
secrets included. The answer is an MCP tool result, as for process
plugins (`{"content": [...], "isError": false}`); a plain JSON string is
taken as one text item.

### Host functions

Imported from the module `openremote`. A module may import only what its
powers grant; the review refuses one that imports more.

| Import | Signature | Power | Does |
|---|---|---|---|
| `log` | `(ptr: i32, len: i32)` | none | A line on OpenRemote's stderr (up to 4096 bytes). |
| `http` | `(ptr: i32, len: i32) -> i32` | `network` | One HTTP request; returns the answer's length. |
| `take` | `(ptr: i32, len: i32) -> i32` | `network` | Copy the last answer into memory at `ptr`; returns bytes copied. |

`http`'s request, JSON at `ptr`:

```json
{"method": "GET", "url": "https://api.example.com/v1/items", "headers": {"accept": "application/json"},
 "body": "optional text", "content_type": "application/json"}
```

The answer (reserve `len` bytes with your allocator, then `take` them):

```json
{"status": 200, "headers": {"content-type": "application/json"}, "body": "..."}
```

A body that isn't UTF-8 comes as `body_base64` instead. A request that
can't be made answers `{"error": "..."}`.

- Requests go through the daemon's own HTTP client, to http and https
  addresses on the internet only: a name or address that leads to this
  machine (loopback), a private network or a link-local address (such as
  a cloud's metadata service) is refused.
- 16 requests per call, 30 seconds each, an answer up to the client's
  body limit.

### Limits

- About two billion instructions of fuel per call: a few seconds of work.
  A call that runs out is stopped, and the agent is told it ran past its
  time limit.
- 64 MiB of memory per instance; growing past it fails.
- Input and output up to 16 MiB each; a module up to 32 MiB.
- Four calls run at once; more wait their turn.

## Versions

This is protocol 1. Fields and methods may be added within version 1;
plugins ignore what they don't know, and OpenRemote does the same. A
change that would break a plugin gets a new version number, which
`initialize` names.
