import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The launcher ships for Windows x64 only, and two of these assertions read host
// path rules rather than the launcher's own: `cacheDir` joins with the running
// platform's separator, and `isEntry` normalises with it, so the same Windows
// strings answer differently on Linux and macOS. CI runs this suite on all
// three, where those two would fail while the code is right; skipping them off
// Windows says that plainly instead of letting a platform claim look like a
// regression.
const windowsOnly = {
  skip: process.platform !== "win32" ? "the launcher ships for Windows x64 only" : false,
};

import {
  assetNamesFor,
  cacheDir,
  checksumFor,
  isEntry,
  main,
  parseArgs,
  parseSums,
  readState,
  tagFromLatestUrl,
  verifyFile,
  writeDirChecksums,
  writeState,
} from "./openremote.mjs";

test("win32 x64 has a portable pair, other platforms do not", () => {
  assert.deepEqual(assetNamesFor("win32", "x64"), {
    app: "OpenRemote-windows-x64.exe",
    daemon: "openremote-daemon-windows-x64.exe",
    sums: "SHA256SUMS-portable-windows-x64",
  });
  assert.equal(assetNamesFor("darwin", "arm64"), null);
  assert.equal(assetNamesFor("linux", "x64"), null);
  assert.equal(assetNamesFor("win32", "arm64"), null);
});

test("the cache is per tag under LOCALAPPDATA", windowsOnly, () => {
  assert.equal(
    cacheDir({ LOCALAPPDATA: "C:\\Users\\x\\AppData\\Local" }, "v0.4.1"),
    "C:\\Users\\x\\AppData\\Local\\moreweb\\openremote\\v0.4.1",
  );
});

test("the tag comes from the redirect, and a URL without one yields null", () => {
  assert.equal(
    tagFromLatestUrl("https://github.com/morewebs/OpenRemote/releases/tag/v0.4.1"),
    "v0.4.1",
  );
  assert.equal(
    tagFromLatestUrl("https://github.com/morewebs/OpenRemote/releases/latest"),
    null,
  );
  assert.equal(tagFromLatestUrl("https://github.com/login?return_to=%2Fmorewebs"), null);
  assert.equal(tagFromLatestUrl(""), null);
});

test("checksums parse into a name map, ignoring blank lines", () => {
  const sums = parseSums(
    "abc  OpenRemote-windows-x64.exe\n\ndef  openremote-daemon-windows-x64.exe\n",
  );
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
  assert.equal(parseArgs(["-h"]).mode, "help");
  assert.deepEqual(parseArgs(["--", "--chat", "x"]).passthrough, ["--chat", "x"]);
  assert.deepEqual(parseArgs(["--version"]).passthrough, []);
});

test("the cache remembers the checksums it installed against", async () => {
  const root = await mkdtemp(join(tmpdir(), "or-state-"));
  assert.equal(await readState(root), null);
  await writeState(root, {
    tag: "v0.4.1",
    sha256: { "OpenRemote.exe": "aa", "openremote-daemon.exe": "bb" },
  });
  assert.deepEqual(await readState(root), {
    tag: "v0.4.1",
    sha256: { "OpenRemote.exe": "aa", "openremote-daemon.exe": "bb" },
  });
});

// The launcher's job is what it does to a real cache directory, so these drive
// main() against a temp root with a fake network and a fake spawn.
const NAMES = assetNamesFor("win32", "x64");

function fakeRelease({ appBytes = "console-bytes", daemonBytes = "daemon-bytes", tag = "v9.9.9" } = {}) {
  const hash = (text) => createHash("sha256").update(text).digest("hex");
  const base = `https://github.com/morewebs/OpenRemote/releases/download/${tag}`;
  const wanted = {
    [`${base}/${NAMES.sums}`]: `${hash(appBytes)}  ${NAMES.app}\n${hash(daemonBytes)}  ${NAMES.daemon}\n`,
    [`${base}/${NAMES.app}`]: appBytes,
    [`${base}/${NAMES.daemon}`]: daemonBytes,
  };
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    if (url === "https://github.com/morewebs/OpenRemote/releases/latest") {
      return { ok: true, url: `https://github.com/morewebs/OpenRemote/releases/tag/${tag}`, text: async () => "", arrayBuffer: async () => new ArrayBuffer(0) };
    }
    if (!(url in wanted)) return { ok: false, status: 404, url, text: async () => "", arrayBuffer: async () => new ArrayBuffer(0) };
    return { ok: true, url, text: async () => wanted[url], arrayBuffer: async () => Buffer.from(wanted[url]) };
  };
  return { fetchImpl, calls };
}

function fakeSpawn() {
  const spawned = [];
  const spawnImpl = (file, args, options) => {
    spawned.push({ file, args, options });
    return {
      unref() {},
      // Real spawn emits "spawn" once the child is running, and "error" when
      // it never starts. The launcher waits for one of them.
      once(event, handler) {
        if (event === "spawn") setTimeout(() => handler(), 0);
      },
    };
  };
  return { spawnImpl, spawned };
}

async function sandbox() {
  const base = await mkdtemp(join(tmpdir(), "or-main-"));
  return { LOCALAPPDATA: base };
}

test("a warm cache starts the app and makes no request at all", async () => {
  const env = await sandbox();
  const root = join(env.LOCALAPPDATA, "moreweb", "openremote");
  const dir = join(root, "v0.4.1");
  await mkdir(dir, { recursive: true });
  const bytes = "console-bytes";
  const hex = createHash("sha256").update(bytes).digest("hex");
  await writeFile(join(dir, "OpenRemote.exe"), bytes);
  await writeFile(join(dir, "openremote-daemon.exe"), bytes);
  await writeState(root, {
    tag: "v0.4.1",
    sha256: { "OpenRemote.exe": hex, "openremote-daemon.exe": hex },
  });

  const offline = async () => {
    throw new Error("the launcher made a request with a warm cache");
  };
  const { spawnImpl, spawned } = fakeSpawn();
  const code = await main([], { env, platform: "win32", arch: "x64", fetchImpl: offline, spawnImpl, log: () => {}, warn: () => {} });

  assert.equal(code, 0);
  assert.equal(spawned.length, 1);
  assert.equal(spawned[0].file, join(dir, "OpenRemote.exe"));
  assert.equal(spawned[0].options.detached, true);
});

test("the first run fetches both halves, records their checksums and spawns", async () => {
  const env = await sandbox();
  const { fetchImpl } = fakeRelease();
  const { spawnImpl, spawned } = fakeSpawn();

  const code = await main([], { env, platform: "win32", arch: "x64", fetchImpl, spawnImpl, log: () => {}, warn: () => {} });

  assert.equal(code, 0);
  const root = join(env.LOCALAPPDATA, "moreweb", "openremote");
  const dir = join(root, "v9.9.9");
  assert.equal(await readFile(join(dir, "OpenRemote.exe"), "utf8"), "console-bytes");
  assert.equal(await readFile(join(dir, "openremote-daemon.exe"), "utf8"), "daemon-bytes");
  const state = await readState(root);
  assert.equal(state.tag, "v9.9.9");
  assert.equal(spawned[0].file, join(dir, "OpenRemote.exe"));

  // The second run reads the record instead of the network.
  const second = await main([], {
    env, platform: "win32", arch: "x64", spawnImpl,
    fetchImpl: async () => { throw new Error("second run went to the network"); },
    log: () => {}, warn: () => {},
  });
  assert.equal(second, 0);
});

test("a checksum that does not match never spawns and leaves nothing installed", async () => {
  const env = await sandbox();
  const hash = (text) => createHash("sha256").update(text).digest("hex");
  const base = "https://github.com/morewebs/OpenRemote/releases/download/v9.9.9";
  const fetchImpl = async (url) => {
    if (url.endsWith("/releases/latest")) {
      return { ok: true, url: "https://github.com/morewebs/OpenRemote/releases/tag/v9.9.9" };
    }
    if (url === `${base}/${NAMES.sums}`) {
      return { ok: true, text: async () => `${hash("something else")}  ${NAMES.app}\n${hash("x")}  ${NAMES.daemon}\n` };
    }
    return { ok: true, arrayBuffer: async () => Buffer.from("tampered") };
  };
  const { spawnImpl, spawned } = fakeSpawn();

  await assert.rejects(
    main([], { env, platform: "win32", arch: "x64", fetchImpl, spawnImpl, log: () => {}, warn: () => {} }),
    /does not match its checksum/,
  );
  assert.equal(spawned.length, 0);
  const dir = join(env.LOCALAPPDATA, "moreweb", "openremote", "v9.9.9");
  const absent = async (path) => {
    try {
      await stat(path);
      return false;
    } catch {
      return true;
    }
  };
  assert.equal(await absent(join(dir, "OpenRemote.exe")), true);
  assert.equal(await absent(join(dir, "OpenRemote.exe.part")), true);
});

test("--version answers without fetching the app", async () => {
  const env = await sandbox();
  const { fetchImpl, calls } = fakeRelease();
  const out = [];
  const code = await main(["--version"], { env, platform: "win32", arch: "x64", fetchImpl, log: (l) => out.push(l), warn: () => {} });
  assert.equal(code, 0);
  assert.deepEqual(out, ["v9.9.9"]);
  assert.equal(calls.length, 1, "only the tag lookup");
});

test("another platform is told where the installer is, and nothing spawns", async () => {
  const env = await sandbox();
  const { spawnImpl, spawned } = fakeSpawn();
  const said = [];
  const code = await main([], { env, platform: "darwin", arch: "arm64", fetchImpl: async () => { throw new Error("no request should be made"); }, spawnImpl, warn: (l) => said.push(l), log: () => {} });
  assert.equal(code, 1);
  assert.equal(spawned.length, 0);
  assert.match(said.join("\n"), /no npm build of the app for darwin-arm64/);
});

test("the registry package and the app carry one version", async () => {
  const app = JSON.parse(await readFile(new URL("../../package.json", import.meta.url), "utf8"));
  const published = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  // Two manifests name the same release. A publish from one of them at a
  // version the other does not carry is how a channel starts lying about
  // which build it installs.
  assert.equal(published.version, app.version);
  assert.equal(published.bin.openremote, "bin/openremote.mjs");
  assert.equal(published.private, undefined, "a private package cannot be published");
});

test("--update moves to a newer release and drops the old one", async () => {
  const env = await sandbox();
  const root = join(env.LOCALAPPDATA, "moreweb", "openremote");
  const old = join(root, "v0.4.1");
  await mkdir(old, { recursive: true });
  const hex = createHash("sha256").update("old-console").digest("hex");
  await writeFile(join(old, "OpenRemote.exe"), "old-console");
  await writeFile(join(old, "openremote-daemon.exe"), "old-console");
  await writeState(root, {
    tag: "v0.4.1",
    sha256: { "OpenRemote.exe": hex, "openremote-daemon.exe": hex },
  });

  const { fetchImpl } = fakeRelease({ tag: "v0.4.2" });
  const { spawnImpl, spawned } = fakeSpawn();
  const code = await main(["--update"], {
    env, platform: "win32", arch: "x64", fetchImpl, spawnImpl, log: () => {}, warn: () => {},
  });

  assert.equal(code, 0);
  assert.equal(spawned[0].file, join(root, "v0.4.2", "OpenRemote.exe"));
  assert.equal((await readState(root)).tag, "v0.4.2");
  // One release on disk: the superseded copy goes, or the cache grows by 28MB
  // per release with nothing that ever reads it again.
  let oldStillThere = true;
  try {
    await stat(old);
  } catch {
    oldStillThere = false;
  }
  assert.equal(oldStillThere, false);
});

test("a warm cache with an older release does not reach for the newer one", async () => {
  const env = await sandbox();
  const root = join(env.LOCALAPPDATA, "moreweb", "openremote");
  const dir = join(root, "v0.4.1");
  await mkdir(dir, { recursive: true });
  const hex = createHash("sha256").update("console-bytes").digest("hex");
  await writeFile(join(dir, "OpenRemote.exe"), "console-bytes");
  await writeFile(join(dir, "openremote-daemon.exe"), "console-bytes");
  await writeState(root, {
    tag: "v0.4.1",
    sha256: { "OpenRemote.exe": hex, "openremote-daemon.exe": hex },
  });

  // The app has never looked for updates on its own, and the launcher keeps
  // that promise: a plain run starts what is here.
  const { spawnImpl, spawned } = fakeSpawn();
  const code = await main([], {
    env, platform: "win32", arch: "x64", spawnImpl,
    fetchImpl: async () => { throw new Error("a plain run went to the network"); },
    log: () => {}, warn: () => {},
  });
  assert.equal(code, 0);
  assert.equal(spawned[0].file, join(dir, "OpenRemote.exe"));
});

async function warmCache(env, tag = "v0.4.1") {
  const root = join(env.LOCALAPPDATA, "moreweb", "openremote");
  const dir = join(root, tag);
  await mkdir(dir, { recursive: true });
  const hex = createHash("sha256").update("console-bytes").digest("hex");
  await writeFile(join(dir, "OpenRemote.exe"), "console-bytes");
  await writeFile(join(dir, "openremote-daemon.exe"), "console-bytes");
  const sha256 = { "OpenRemote.exe": hex, "openremote-daemon.exe": hex };
  await writeState(root, { tag, sha256 });
  await writeDirChecksums(dir, sha256);
  return dir;
}

test("the entry guard survives a symlinked or junctioned install", windowsOnly, () => {
  // pnpm and `npm link` both run the entry through a symlink or junction, and
  // that path is not the module's own real path.
  const linked = "C:\\Users\\x\\AppData\\Local\\pnpm\\global\\5\\node_modules\\@morewebs\\openremote\\bin\\openremote.mjs";
  const real = "C:\\Users\\x\\AppData\\Local\\pnpm\\store\\v10\\files\\ab\\cd\\node_modules\\@morewebs\\openremote\\bin\\openremote.mjs";
  assert.equal(isEntry(linked, real), true);
  assert.equal(isEntry("C:\\x\\something-else.mjs", real), false);
  assert.equal(isEntry("", real), false);
});

test("a spawn that fails says so instead of claiming it started", async () => {
  const env = await sandbox();
  await warmCache(env);
  const said = [];
  const warned = [];
  const spawnImpl = () => ({
    unref() {},
    once(event, handler) {
      // The asynchronous failure: no such file, or a quarantined exe.
      if (event === "error") setTimeout(() => handler(new Error("spawn ENOENT")), 0);
    },
  });

  const code = await main([], {
    env, platform: "win32", arch: "x64", fetchImpl: async () => { throw new Error("no network"); },
    spawnImpl, log: (line) => said.push(line), warn: (line) => warned.push(line),
  });

  assert.equal(code, 1);
  assert.match(warned.join("\n"), /could not start/);
  assert.equal(said.some((line) => /starting OpenRemote/.test(line)), false);
});

test("a lost record does not throw away a cache that still verifies", async () => {
  const env = await sandbox();
  const root = join(env.LOCALAPPDATA, "moreweb", "openremote");
  const dir = join(root, "v0.4.1");
  await mkdir(dir, { recursive: true });
  const hex = createHash("sha256").update("console-bytes").digest("hex");
  await writeFile(join(dir, "OpenRemote.exe"), "console-bytes");
  await writeFile(join(dir, "openremote-daemon.exe"), "console-bytes");
  await writeDirChecksums(dir, { "OpenRemote.exe": hex, "openremote-daemon.exe": hex });
  // current.json deleted, both binaries intact: this is what an offline machine
  // with a good cache looks like after a half-finished cleanup.
  const { spawnImpl, spawned } = fakeSpawn();

  const code = await main([], {
    env, platform: "win32", arch: "x64", spawnImpl,
    fetchImpl: async () => { throw new Error("offline"); },
    log: () => {}, warn: () => {},
  });

  assert.equal(code, 0);
  assert.equal(spawned[0].file, join(dir, "OpenRemote.exe"));
  assert.equal((await readState(root)).tag, "v0.4.1");
});

test("a refused download leaves another run's partial file alone", async () => {
  const env = await sandbox();
  const root = join(env.LOCALAPPDATA, "moreweb", "openremote");
  const dir = join(root, "v9.9.9");
  await mkdir(dir, { recursive: true });
  const foreign = join(dir, "OpenRemote.exe.4242.part");
  await writeFile(foreign, "another process is mid-download");

  const fetchImpl = async (url) => {
    if (url.endsWith("/releases/latest")) {
      return { ok: true, url: "https://github.com/morewebs/OpenRemote/releases/tag/v9.9.9" };
    }
    return { ok: false, status: 404, url };
  };

  await assert.rejects(main([], {
    env, platform: "win32", arch: "x64", fetchImpl,
    spawnImpl: () => ({ unref() {}, once() {} }), log: () => {}, warn: () => {},
  }));
  assert.equal(await readFile(foreign, "utf8"), "another process is mid-download");
});

test("--update with no network starts what is already here", async () => {
  const env = await sandbox();
  const dir = await warmCache(env);
  const { spawnImpl, spawned } = fakeSpawn();
  const warned = [];

  const code = await main(["--update"], {
    env, platform: "win32", arch: "x64", spawnImpl,
    fetchImpl: async () => { throw new Error("offline"); },
    log: () => {}, warn: (line) => warned.push(line),
  });

  assert.equal(code, 0);
  assert.equal(spawned[0].file, join(dir, "OpenRemote.exe"));
  assert.match(warned.join("\n"), /newest release|offline/i);
});

test("a file matches only its own checksum", async () => {
  const dir = await mkdtemp(join(tmpdir(), "or-sha-"));
  const path = join(dir, "a.bin");
  await writeFile(path, "hello");
  const good = createHash("sha256").update("hello").digest("hex");
  assert.equal(await verifyFile(path, good), true);
  assert.equal(await verifyFile(path, good.toUpperCase()), true);
  const bad = good.replace(/^./, (c) => (c === "0" ? "1" : "0"));
  assert.equal(await verifyFile(path, bad), false);
  assert.equal(await verifyFile(join(dir, "absent"), good), false);
});
