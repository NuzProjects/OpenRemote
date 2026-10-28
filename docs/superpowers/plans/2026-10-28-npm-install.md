# npm install channel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `npm install -g morewebs/openremote` then `openremote` opens the desktop app on Windows, with the Rust daemon prebuilt.

**Architecture:** The repo root `package.json` gains a `bin`. That script is a dependency-free Node launcher: it resolves the current stable release tag, downloads the prebuilt console + daemon pair from that release into a per-tag cache under `%LOCALAPPDATA%`, verifies both against the release's checksum asset, and spawns the console detached. The release workflow publishes the pair under version-free names so the launcher never embeds a version.

**Tech Stack:** Node 18+ (global `fetch`, `node:crypto`, `node:fs`), GitHub Releases as the binary host, `node --test` for tests.

**Spec:** `docs/superpowers/specs/2026-10-28-npm-install-design.md`

## Global Constraints

- Windows x64 only. Every other platform prints the installer URL for that platform and exits 1.
- Zero runtime dependencies in the launcher. No `import` outside `node:` builtins.
- Version-free asset names, matching the release channel convention already in the repo.
- No em dashes anywhere in prose or comments (repo convention).
- The sidecar must be written as `openremote-daemon.exe` beside `OpenRemote.exe`; that filename is the contract the Tauri shell resolves.
- Nothing is spawned before both files verify against `SHA256SUMS-portable-windows-x64`.

## Review Focus

- **No network on a later run.** A cached install must launch without any HTTP request; a machine offline with a warm cache still works.
- **A truncated or hostile download.** A checksum mismatch must never spawn a process and must not leave the partial file where the next run would trust it.
- **A redirected or rate-limited `releases/latest`.** An unexpected redirect target, a 404, or a 302 that lands somewhere without a tag must fail with a readable message, not spawn.
- **A probe build that is a directory or a locked file.** A cache directory left half-written by an interrupted run must be replaced, not spawned from.
- **npm's shim on Windows.** `openremote` must work from `cmd`, from PowerShell, and from a path containing spaces.

---

### Task 1: Pure resolution rules

**Files:**
- Create: `npm/bin/openremote.mjs` (exports only at first)
- Test: `npm/bin/openremote.test.mjs`
- Modify: `package.json:11` (the `test` script gains the new glob)

**Interfaces:**
- Produces: `assetNamesFor(platform, arch)` -> `{ app, daemon, sums } | null`;
  `cacheRoot(env)` -> string; `cacheDir(env, tag)` -> string;
  `tagFromLatestUrl(url)` -> string | null; `parseSums(text)` -> `Map<string,string>`;
  `checksumFor(sums, name)` -> string | null; `parseArgs(argv)` ->
  `{ mode: "run"|"update"|"version"|"where"|"help", passthrough: string[] }`.

- [ ] **Step 1: Write the failing test**

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { assetNamesFor, cacheDir, tagFromLatestUrl, parseSums, checksumFor, parseArgs } from "./openremote.mjs";

test("win32 x64 has a portable pair, other platforms do not", () => {
  assert.deepEqual(assetNamesFor("win32", "x64"), {
    app: "OpenRemote-windows-x64.exe",
    daemon: "openremote-daemon-windows-x64.exe",
    sums: "SHA256SUMS-portable-windows-x64",
  });
  assert.equal(assetNamesFor("darwin", "arm64"), null);
  assert.equal(assetNamesFor("linux", "x64"), null);
});

test("the cache is per tag under LOCALAPPDATA", () => {
  assert.equal(
    cacheDir({ LOCALAPPDATA: "C:\\Users\\x\\AppData\\Local" }, "v0.4.1"),
    "C:\\Users\\x\\AppData\\Local\\moreweb\\openremote\\v0.4.1",
  );
});

test("the tag comes from the redirect, and a URL without one yields null", () => {
  assert.equal(tagFromLatestUrl("https://github.com/morewebs/OpenRemote/releases/tag/v0.4.1"), "v0.4.1");
  assert.equal(tagFromLatestUrl("https://github.com/morewebs/OpenRemote/releases/latest"), null);
  assert.equal(tagFromLatestUrl("https://github.com/login?return_to=%2Fmorewebs"), null);
});

test("checksums parse into a name map, ignoring blank lines", () => {
  const sums = parseSums("abc  OpenRemote-windows-x64.exe\n\ndef  openremote-daemon-windows-x64.exe\n");
  assert.equal(checksumFor(sums, "OpenRemote-windows-x64.exe"), "abc");
  assert.equal(checksumFor(sums, "openremote-daemon-windows-x64.exe"), "def");
  assert.equal(checksumFor(sums, "missing.exe"), null);
});

test("arguments select a mode", () => {
  assert.equal(parseArgs([]).mode, "run");
  assert.equal(parseArgs(["--version"]).mode, "version");
  assert.equal(parseArgs(["--where"]).mode, "where");
  assert.equal(parseArgs(["--update"]).mode, "update");
  assert.equal(parseArgs(["--help"]).mode, "help");
  assert.deepEqual(parseArgs(["--", "--chat", "x"]).passthrough, ["--chat", "x"]);
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `node --test npm/bin/openremote.test.mjs`
Expected: FAIL, cannot find module or missing export.

- [ ] **Step 3: Implement the exports in `npm/bin/openremote.mjs`**

`assetNamesFor` returns the fixed triple for `win32`/`x64` and `null`
otherwise. `cacheDir` joins `LOCALAPPDATA`, `moreweb`, `openremote`, tag.
`tagFromLatestUrl` matches `/releases/tag/([^/?#]+)$`. `parseSums` splits on
whitespace, takes the last field as the name and the first as the hash, and
skips empty lines. `parseArgs` treats the first recognised flag as the mode,
defaults to `run`, and takes everything after a bare `--` as passthrough.

- [ ] **Step 4: Add the glob to the test script**

`"test": "node --test \"src/**/*.test.js\" \"npm/**/*.test.mjs\""`

- [ ] **Step 5: Run the whole suite**

Run: `npm test`
Expected: PASS, and the printed count is the previous count plus 5.

- [ ] **Step 6: Commit**

```bash
git add npm/bin/openremote.mjs npm/bin/openremote.test.mjs package.json
git commit -m "npm: the install channel's rules, before its fetch"
```

### Task 2: Fetch, verify, spawn

**Files:**
- Modify: `npm/bin/openremote.mjs`
- Test: `npm/bin/openremote.test.mjs`

**Interfaces:**
- Consumes: everything from Task 1.
- Produces: `verifyFile(path, expectedHex)` -> Promise<boolean>;
  `install({ tag, dir, names, fetchImpl })` -> Promise<{ app: string, daemon: string }>;
  `main(argv)` -> Promise<number>.

- [ ] **Step 1: Write the failing tests**

```js
test("a file matches only its own checksum", async () => {
  const dir = await mkdtemp(join(tmpdir(), "or-sha-"));
  const p = join(dir, "a.bin");
  await writeFile(p, "hello");
  const good = createHash("sha256").update("hello").digest("hex");
  assert.equal(await verifyFile(p, good), true);
  assert.equal(await verifyFile(p, good.replace(/^./, (c) => (c === "0" ? "1" : "0"))), false);
  assert.equal(await verifyFile(join(dir, "absent"), good), false);
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `node --test npm/bin/openremote.test.mjs`
Expected: FAIL on the missing export.

- [ ] **Step 3: Implement `verifyFile`**

Stream the file through `createHash("sha256")`, compare hex lowercased,
return `false` for any read error rather than throwing.

- [ ] **Step 4: Run it and watch it pass**

Run: `node --test npm/bin/openremote.test.mjs`
Expected: PASS.

- [ ] **Step 5: Implement `install` and `main`**

`install` downloads `sums` first, parses it, then for each of `app` and
`daemon` downloads to `<dir>/<name>.part`, verifies, and renames into place,
removing the `.part` on any failure. It throws with the asset name and the
expected hash on a mismatch. `main` resolves the tag (cached tag if present
and not `--update`, else `releases/latest`), prints a one-line progress note
before downloading, spawns `<dir>/OpenRemote.exe` with `detached: true,
stdio: "ignore"` and `unref()`, and returns 0. Non-win32 prints the
installer URL and returns 1. Errors print one line and return 1.

- [ ] **Step 6: Run the whole suite**

Run: `npm test`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add npm/bin/openremote.mjs npm/bin/openremote.test.mjs
git commit -m "npm: the launcher fetches, verifies, then spawns"
```

### Task 3: The package manifest

**Files:**
- Modify: `package.json`

**Interfaces:**
- Produces: a `bin` mapping `openremote` -> `npm/bin/openremote.mjs`, and a
  `files` list that keeps the tarball to `npm/`.

- [ ] **Step 1: Move the app's runtime dependencies to `devDependencies`**

Vite bundles them into `dist/`; nothing reads `node_modules` at run time, and
a global git install would otherwise fetch ~45MB of React to start an exe.

- [ ] **Step 2: Add `bin`, `files`, `engines.node`**

`"bin": { "openremote": "npm/bin/openremote.mjs" }`, `"files": ["npm"]`,
`"engines": { "node": ">=18.17" }`.

- [ ] **Step 3: Verify the tarball carries the launcher and no binaries**

Run: `npm pack --dry-run`
Expected: the file list includes `npm/bin/openremote.mjs` and no `.exe`.

- [ ] **Step 4: Verify a clean install still builds and tests**

Run: `npm ci && npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add package.json package-lock.json
git commit -m "npm: the repo is installable, and a global install fetches nothing"
```

### Task 4: The release carries the pair

**Files:**
- Modify: `.github/workflows/release.yml`

**Interfaces:**
- Produces: assets `OpenRemote-windows-x64.exe`,
  `openremote-daemon-windows-x64.exe`, `SHA256SUMS-portable-windows-x64` on
  every release from `v0.4.1` on.

- [ ] **Step 1: Stage the pair in the Windows job**

After the installer staging step, copy the two release binaries to the three
version-free names and write the checksums with `sha256sum`.

- [ ] **Step 2: Upload them and add them to the publish job's list**

Add the three to `upload-artifact`'s path, to the publish job's `find`
pattern, and to `NAMES`, with a comment recording that `0.4.1` is the first
release that carries them.

- [ ] **Step 3: Check the workflow parses**

Run: `node -e "const y=require('fs').readFileSync('.github/workflows/release.yml','utf8'); if (!y.includes('SHA256SUMS-portable-windows-x64')) process.exit(1); console.log('ok')"`
Expected: `ok`.

- [ ] **Step 4: Commit**

```bash
git add .github/workflows/release.yml
git commit -m "release: every release carries the portable pair the npm channel reads"
```

### Task 5: Backfill `v0.4.1`

**Files:** none. Live release.

- [ ] **Step 1: Extract the pair from the published msi**

`msiexec /a OpenRemote-Setup-x64.msi /qn TARGETDIR=<dir>` yields
`PFiles/OpenRemote/openremote-ui-desktop.exe` (15029248 bytes) and
`openremote-daemon.exe` (13251072 bytes).

- [ ] **Step 2: Stage them under the version-free names and hash them**

- [ ] **Step 3: Upload to the release**

`gh release upload v0.4.1 <three files>`.

- [ ] **Step 4: Verify the published assets download and re-hash**

Run: `curl -sSLO` on the three `releases/latest/download/` URLs, then hash
them and compare with the staged values.

### Task 6: Say it exists

**Files:**
- Modify: `README.md` (install section), `docs/release-channels.md`,
  `AGENTS.md` (Commands block)

- [ ] **Step 1: README gains the two lines and what they fetch**
- [ ] **Step 2: `docs/release-channels.md` names the three new assets**
- [ ] **Step 3: `AGENTS.md` gains the launcher's flags beside the app commands**
- [ ] **Step 4: Commit**

```bash
git add README.md docs/release-channels.md AGENTS.md
git commit -m "docs: the terminal door into the app"
```

### Task 7: Prove the real command

**Files:** none.

- [ ] **Step 1: Install from the branch**

`npm install -g github:morewebs/OpenRemote#npm/github-install`

- [ ] **Step 2: Run it and watch the window, the cache, and the sidecar**

Expected: a one-line progress note, then a window; the cache holds
`OpenRemote.exe` and `openremote-daemon.exe`; the running daemon's path is
the cached one.

- [ ] **Step 3: Run again offline**

Expected: no network, window opens.

- [ ] **Step 4: Corrupt a cached file and run again**

Expected: a refusal naming the asset, no window.

- [ ] **Step 5: Merge to main and run the literal command**

`npm install -g morewebs/openremote`, then `openremote`.
