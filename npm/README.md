# @morewebs/openremote

The terminal door into [OpenRemote](https://github.com/morewebs/OpenRemote) -
one window for the agent harnesses on this computer (Claude Code, Codex,
grok, pi, opencode, agy), run side by side.

```sh
npm install -g @morewebs/openremote
openremote
```

This package is a launcher, not the app. The first `openremote` downloads the
prebuilt desktop app from the current release (about 28MB, into
`%LOCALAPPDATA%\moreweb\openremote\<release>\`), checks both binaries against
the release's own SHA256SUMS, and starts the console. Later runs use that copy
and need no network.

```sh
openremote --update     # move to the newest release, then start it
openremote --version    # which release is cached or available
openremote --where      # the path it would start
openremote --help
```

Windows x64 only for now. On macOS and Linux the launcher says so and points
at the `.dmg`, `.AppImage` and `.deb` on the release page.

The app is unsigned by decision, so SmartScreen asks the first time the window
opens: **More info**, then **Run anyway**. It carries the same identity as an
installed copy, so both read the same chats, settings and paired phone.

AGPL-3.0-only. Harness names and marks belong to their owners; OpenRemote is
not affiliated with them.
