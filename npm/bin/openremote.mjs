#!/usr/bin/env node
// The terminal door into the app.
//
// npm installs a package, not a desktop app, so this file carries no binary:
// the first run fetches the portable pair from the current release, checks it
// against the release's own checksums, and keeps it in a per-release cache.
// Every run after that verifies the cached pair against the checksums it was
// installed with and spawns it, touching no network.
//
// The pair is what the window needs: the console alone cannot start without
// openremote-daemon beside it, and that filename is the one the Tauri shell
// resolves.

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = "morewebs/OpenRemote";
const RELEASES = `https://github.com/${REPO}/releases`;
const LATEST = `${RELEASES}/latest`;
const INSTALLER = `${RELEASES}/latest/download/OpenRemote-Setup-x64.exe`;

// The release assets are version-free on purpose (the release workflow keeps
// them that way so no URL moves with a version bump). The local names are the
// ones the shell looks for beside itself at run time.
const LOCAL_APP = "OpenRemote.exe";
const LOCAL_DAEMON = "openremote-daemon.exe";

// Two records, both written atomically. The one at the root says which release
// to start; the one in the release's own directory says what it was installed
// as. The second is what lets a cache survive losing the first.
const STATE_FILE = "current.json";
const DIR_RECORD = "checksums.json";

const HELP = `openremote - the harness console for this computer

usage: openremote [--update | --version | --where | --help] [-- <app args>]

  (no flag)   start the app, fetching this release once if it is not cached
  --update    fetch the newest release, then start it (starting what is
              already here if it cannot be reached)
  --version   print the release that is cached or available
  --where     print the path of the console it would start
  --help      this text

The app downloads once, about 28MB, into
%LOCALAPPDATA%\\moreweb\\openremote\\<release>\\. It does not check for a newer
release on its own.`;

export function assetNamesFor(platform, arch) {
  if (platform !== "win32" || arch !== "x64") return null;
  return {
    app: "OpenRemote-windows-x64.exe",
    daemon: "openremote-daemon-windows-x64.exe",
    sums: "SHA256SUMS-portable-windows-x64",
  };
}

export function cacheRoot(env) {
  const base = env.LOCALAPPDATA ?? env.APPDATA;
  if (!base) throw new Error("neither LOCALAPPDATA nor APPDATA is set, so there is nowhere to cache the download");
  return join(base, "moreweb", "openremote");
}

export function cacheDir(env, tag) {
  return join(cacheRoot(env), tag);
}

// releases/latest is a redirect to releases/tag/<tag>, so the tag is the only
// thing about the newest release this launcher has to know.
export function tagFromLatestUrl(url) {
  const match = /\/releases\/tag\/([^/?#]+)\s*$/.exec(url ?? "");
  return match ? decodeURIComponent(match[1]) : null;
}

export function parseSums(text) {
  const sums = new Map();
  for (const line of (text ?? "").split("\n")) {
    const fields = line.trim().split(/\s+/).filter(Boolean);
    if (fields.length < 2) continue;
    // sha256sum format: <hex>  <name>. A leading * marks a binary-mode line.
    sums.set(fields[fields.length - 1].replace(/^\*/, ""), fields[0].toLowerCase());
  }
  return sums;
}

export function checksumFor(sums, name) {
  return sums.get(name) ?? null;
}

const KNOWN_FLAGS = ["--version", "--where", "--update", "--help", "-h"];

export function parseArgs(argv) {
  const args = argv ?? [];
  const separator = args.indexOf("--");
  const own = separator === -1 ? args : args.slice(0, separator);
  const tail = separator === -1 ? [] : args.slice(separator + 1);
  const flag = own.find((arg) => KNOWN_FLAGS.includes(arg));
  const mode =
    flag === "--version" ? "version"
      : flag === "--where" ? "where"
        : flag === "--update" ? "update"
          : flag === "--help" || flag === "-h" ? "help"
            : "run";
  // Anything this launcher does not understand is the app's, not ours to
  // swallow: a mistyped flag should reach the app, not vanish silently.
  const passthrough = [...own.filter((arg) => !KNOWN_FLAGS.includes(arg)), ...tail];
  return { mode, passthrough };
}

// pnpm, `npm link` and a Windows junction all reach this file through a path
// that is not its own real path, so the name is accepted as well as the real
// path. Without this the launcher exits 0 having done nothing at all.
export function isEntry(argv1, selfPath) {
  if (!argv1) return false;
  if (basename(argv1).toLowerCase() === basename(selfPath).toLowerCase()) return true;
  try {
    return realpathSync(argv1) === realpathSync(selfPath);
  } catch {
    return false;
  }
}

export async function verifyFile(path, expectedHex) {
  if (!expectedHex) return false;
  try {
    const bytes = await readFile(path);
    return createHash("sha256").update(bytes).digest("hex") === expectedHex.toLowerCase();
  } catch {
    return false;
  }
}

async function readJson(path) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return null;
  }
}

// Rename, not truncate: two runs must never leave a half-written record that
// the next run reads as no record at all.
async function writeJsonAtomic(path, value) {
  const staging = `${path}.${process.pid}.tmp`;
  await writeFile(staging, `${JSON.stringify(value, null, 2)}\n`);
  await rename(staging, path);
}

export async function readState(root) {
  const state = await readJson(join(root, STATE_FILE));
  if (!state || typeof state.tag !== "string" || typeof state.sha256 !== "object" || !state.sha256) return null;
  return { tag: state.tag, sha256: state.sha256 };
}

export async function writeState(root, state) {
  await mkdir(root, { recursive: true });
  await writeJsonAtomic(join(root, STATE_FILE), { tag: state.tag, sha256: state.sha256 });
}

export async function writeDirChecksums(dir, sha256) {
  await mkdir(dir, { recursive: true });
  await writeJsonAtomic(join(dir, DIR_RECORD), { sha256 });
}

async function readDirChecksums(dir) {
  const record = await readJson(join(dir, DIR_RECORD));
  return record && typeof record.sha256 === "object" && record.sha256 ? record.sha256 : null;
}

async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function modified(path) {
  try {
    return (await stat(path)).mtimeMs;
  } catch {
    return 0;
  }
}

async function fetchText(url, fetchImpl) {
  const response = await fetchImpl(url);
  if (!response.ok) throw new Error(`${url} answered ${response.status}`);
  return response.text();
}

async function fetchTo(url, dest, fetchImpl) {
  const response = await fetchImpl(url);
  if (!response.ok) throw new Error(`${url} answered ${response.status}`);
  // The pair is 28MB, so it is held whole rather than streamed: one write, and
  // a failure leaves nothing half-verified behind.
  await writeFile(dest, Buffer.from(await response.arrayBuffer()));
}

export async function install({ tag, dir, names, fetchImpl = fetch, log = () => {} }) {
  await mkdir(dir, { recursive: true });
  const sums = parseSums(await fetchText(`${RELEASES}/download/${tag}/${names.sums}`, fetchImpl));
  const sha256 = {};
  const mine = [];
  try {
    for (const [asset, local] of [[names.app, LOCAL_APP], [names.daemon, LOCAL_DAEMON]]) {
      const expected = checksumFor(sums, asset);
      if (!expected) throw new Error(`${names.sums} does not list ${asset}`);
      // A pid-unique staging name: two `openremote` runs at once must not
      // delete or rename each other's half-written file.
      const part = join(dir, `${local}.${process.pid}.part`);
      mine.push(part);
      log(`openremote: fetching ${asset}`);
      await fetchTo(`${RELEASES}/download/${tag}/${asset}`, part, fetchImpl);
      if (!(await verifyFile(part, expected))) {
        throw new Error(`${asset} does not match its checksum, so it was not used (expected sha256 ${expected})`);
      }
      await rename(part, join(dir, local));
      sha256[local] = expected;
    }
    await writeDirChecksums(dir, sha256);
  } catch (error) {
    // Only this run's own staging files. The final names belong to whichever
    // run finished them, and deleting those is how one run breaks another.
    await Promise.all(mine.map((path) => rm(path, { force: true })));
    throw error;
  }
  return { app: join(dir, LOCAL_APP), daemon: join(dir, LOCAL_DAEMON), sha256 };
}

// One release on disk is enough. A directory that will not go is one whose
// console is still running, which is a reason to leave it alone rather than
// a reason to fail.
async function prune(root, keep) {
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name === keep) continue;
    await rm(join(root, entry.name), { recursive: true, force: true }).catch(() => {});
  }
}

async function resolveLatest(fetchImpl) {
  const response = await fetchImpl(LATEST, { redirect: "follow" });
  if (!response.ok) throw new Error(`releases/latest answered ${response.status}`);
  const tag = tagFromLatestUrl(response.url);
  // A redirect that lands somewhere else is a change to GitHub's or the
  // repo's shape, not something to guess a download URL from.
  if (!tag) throw new Error(`releases/latest landed on ${response.url}, which names no release tag`);
  return tag;
}

async function installRelease({ tag, env, names, fetchImpl, log }) {
  log(`openremote: OpenRemote ${tag} is not on this machine yet, fetching it once (about 28MB)`);
  let installed;
  try {
    installed = await install({ tag, dir: cacheDir(env, tag), names, fetchImpl, log });
  } catch (error) {
    // Every failure here ends in the same place for the user, so every failure
    // says where that place is.
    throw new Error(`${error.message}\n  Install from ${INSTALLER} instead, or try again.`);
  }
  await writeState(cacheRoot(env), { tag, sha256: installed.sha256 });
  await prune(cacheRoot(env), tag);
  return installed;
}

// Both halves are checked against what they were installed as. There is no
// request here: the record written at install time is enough, so a warm cache
// starts offline.
async function soundCopy(dir, state) {
  if (!state) return false;
  const app = await verifyFile(join(dir, LOCAL_APP), state.sha256[LOCAL_APP]);
  const daemon = await verifyFile(join(dir, LOCAL_DAEMON), state.sha256[LOCAL_DAEMON]);
  return app && daemon;
}

// The root record is the one thing in the cache not addressed by tag and
// content, so losing it must not throw away a good install: any release
// directory that still carries its own record and matches it is adopted back.
async function adoptCache(root) {
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return null;
  }
  let best = null;
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dir = join(root, entry.name);
    const sha256 = await readDirChecksums(dir);
    if (!sha256) continue;
    const candidate = { tag: entry.name, sha256 };
    if (!(await soundCopy(dir, candidate))) continue;
    const stamp = await modified(join(dir, DIR_RECORD));
    if (!best || stamp > best.stamp) best = { ...candidate, stamp };
  }
  if (!best) return null;
  const state = { tag: best.tag, sha256: best.sha256 };
  await writeState(root, state);
  return state;
}

async function ensureInstalled({ tag, state, env, names, fetchImpl, log, warn }) {
  const dir = cacheDir(env, tag);
  if (state && state.tag === tag && (await soundCopy(dir, state))) {
    return { app: join(dir, LOCAL_APP), daemon: join(dir, LOCAL_DAEMON) };
  }
  // A cache that is present but damaged is replaced rather than spawned: a
  // truncated exe is a crash on a window the user cannot see the reason for.
  if (state && state.tag === tag) {
    warn(`openremote: the cached copy of ${tag} did not match its checksums, fetching it again`);
    await rm(dir, { recursive: true, force: true });
  }
  return installRelease({ tag, env, names, fetchImpl, log });
}

// A spawn that fails asynchronously (no such file, or a file the system
// quarantined) is still a failed launch. Reporting "starting" over it would be
// a lie the user cannot see through.
function waitForSpawn(child) {
  return new Promise((resolve) => {
    if (typeof child.once !== "function") {
      child.unref();
      resolve(null);
      return;
    }
    let settled = false;
    child.once("spawn", () => {
      if (settled) return;
      settled = true;
      child.unref();
      resolve(null);
    });
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      resolve(error);
    });
  });
}

export async function main(argv, options = {}) {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  const fetchImpl = options.fetchImpl ?? fetch;
  const spawnImpl = options.spawnImpl ?? spawn;
  const log = options.log ?? ((line) => process.stdout.write(`${line}\n`));
  const warn = options.warn ?? ((line) => process.stderr.write(`${line}\n`));

  const { mode, passthrough } = parseArgs(argv);
  if (mode === "help") {
    log(HELP);
    return 0;
  }

  const names = assetNamesFor(platform, arch);
  if (!names) {
    warn(`openremote: there is no npm build of the app for ${platform}-${arch} yet.`);
    warn(`  Windows x64: ${INSTALLER}`);
    warn(`  macOS and Linux: ${RELEASES} (dmg, AppImage, deb)`);
    return 1;
  }

  const root = cacheRoot(env);
  let state = await readState(root);
  if (!state) state = await adoptCache(root);

  // Reporting the release must not fetch it, so these two answer from the
  // cache alone when there is one.
  if (mode === "version" || mode === "where") {
    const tag = state?.tag ?? (await resolveLatest(fetchImpl));
    if (mode === "version") {
      log(tag);
      return 0;
    }
    log(join(cacheDir(env, tag), LOCAL_APP));
    log(join(cacheDir(env, tag), LOCAL_DAEMON));
    return 0;
  }

  let tag = state?.tag ?? null;
  let installed = null;

  if (mode === "update") {
    let latest = null;
    try {
      latest = await resolveLatest(fetchImpl);
    } catch (error) {
      // Offline with a good cache: starting what is here beats starting
      // nothing, and the update simply did not happen.
      warn(`openremote: could not reach the newest release (${error.message}); starting ${tag ?? "nothing, there is no cache"}`);
    }
    if (latest && latest !== tag) {
      tag = latest;
      installed = await installRelease({ tag, env, names, fetchImpl, log });
    }
  } else if (!tag) {
    tag = await resolveLatest(fetchImpl);
  }

  if (!tag) throw new Error("no release is cached and none could be reached");

  if (!installed) installed = await ensureInstalled({ tag, state, env, names, fetchImpl, log, warn });

  // Detached so the window outlives the terminal, which is what `code .` and
  // every other CLI launch feels like. The console starts its own daemon from
  // beside itself, so there is no sidecar to start here.
  const child = spawnImpl(installed.app, passthrough, {
    cwd: cacheDir(env, tag),
    detached: true,
    stdio: "ignore",
    windowsHide: false,
  });

  const failure = await waitForSpawn(child);
  if (failure) {
    warn(`openremote: could not start ${installed.app}: ${failure.message}`);
    return 1;
  }
  log(`openremote: starting OpenRemote ${tag}`);
  return 0;
}

if (isEntry(process.argv[1], fileURLToPath(import.meta.url))) {
  main(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((error) => {
      process.stderr.write(`openremote: ${error.message}\n`);
      process.exit(1);
    });
}
