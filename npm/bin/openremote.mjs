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
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const REPO = "morewebs/OpenRemote";
const RELEASES = `https://github.com/${REPO}/releases`;
const LATEST = `${RELEASES}/latest`;
const INSTALLER = `${RELEASES}/latest/download/OpenRemote-Setup-x64.exe`;

// The release assets are version-free on purpose (the release workflow keeps
// them that way so no URL moves with a version bump). The local names are the
// ones the shell looks for beside itself at run time.
const LOCAL_APP = "OpenRemote.exe";
const LOCAL_DAEMON = "openremote-daemon.exe";

const HELP = `openremote - the harness console for this computer

usage: openremote [--update | --version | --where | --help] [-- <app args>]

  (no flag)   start the app, fetching this release once if it is not cached
  --update    fetch the newest release, then start it
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

export function parseArgs(argv) {
  const args = argv ?? [];
  const separator = args.indexOf("--");
  const own = separator === -1 ? args : args.slice(0, separator);
  const passthrough = separator === -1 ? [] : args.slice(separator + 1);
  const flag = own.find((arg) => ["--version", "--where", "--update", "--help", "-h"].includes(arg));
  const mode =
    flag === "--version" ? "version"
      : flag === "--where" ? "where"
        : flag === "--update" ? "update"
          : flag === "--help" || flag === "-h" ? "help"
            : "run";
  return { mode, passthrough };
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

export async function readState(root) {
  try {
    const state = JSON.parse(await readFile(join(root, "current.json"), "utf8"));
    if (typeof state.tag !== "string" || typeof state.sha256 !== "object" || !state.sha256) return null;
    return { tag: state.tag, sha256: state.sha256 };
  } catch {
    return null;
  }
}

export async function writeState(root, state) {
  await mkdir(root, { recursive: true });
  await writeFile(
    join(root, "current.json"),
    `${JSON.stringify({ tag: state.tag, sha256: state.sha256 }, null, 2)}\n`,
  );
}

async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
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
  const staged = [];
  try {
    for (const [asset, local] of [[names.app, LOCAL_APP], [names.daemon, LOCAL_DAEMON]]) {
      const expected = checksumFor(sums, asset);
      if (!expected) throw new Error(`${names.sums} does not list ${asset}`);
      const part = join(dir, `${local}.part`);
      log(`openremote: fetching ${asset}`);
      await fetchTo(`${RELEASES}/download/${tag}/${asset}`, part, fetchImpl);
      if (!(await verifyFile(part, expected))) {
        throw new Error(`${asset} does not match its checksum, so it was not used (expected sha256 ${expected})`);
      }
      const final = join(dir, local);
      await rename(part, final);
      staged.push(final);
      sha256[local] = expected;
    }
  } catch (error) {
    // A refused download must not look installed to the next run.
    await Promise.all(staged.map((path) => rm(path, { force: true })));
    await rm(join(dir, `${LOCAL_APP}.part`), { force: true });
    await rm(join(dir, `${LOCAL_DAEMON}.part`), { force: true });
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
  const installed = await install({ tag, dir: cacheDir(env, tag), names, fetchImpl, log });
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

async function ensureInstalled({ tag, env, names, fetchImpl, log, warn }) {
  const root = cacheRoot(env);
  const state = await readState(root);
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
  const state = await readState(root);

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
  if (mode === "update") {
    const latest = await resolveLatest(fetchImpl);
    if (latest !== tag) {
      tag = latest;
      await installRelease({ tag, env, names, fetchImpl, log });
    }
  }
  if (!tag) tag = await resolveLatest(fetchImpl);

  const { app } = await ensureInstalled({ tag, env, names, fetchImpl, log, warn });

  // Detached so the window outlives the terminal, which is what `code .` and
  // every other CLI launch feels like. The console starts its own daemon from
  // beside itself, so there is no sidecar to start here.
  const child = spawnImpl(app, passthrough, {
    cwd: cacheDir(env, tag),
    detached: true,
    stdio: "ignore",
    windowsHide: false,
  });
  child.unref();
  log(`openremote: starting OpenRemote ${tag}`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((error) => {
      process.stderr.write(`openremote: ${error.message}\n`);
      process.exit(1);
    });
}
