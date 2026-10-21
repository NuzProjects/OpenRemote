# The release channels

Two channels, one pipeline (`.github/workflows/release.yml`).

## Stable

A `v*` tag. Its release is the newest release in the repo, so these URLs
always point at the latest stable build:

```
https://github.com/morewebs/OpenRemote/releases/latest/download/OpenRemote-Setup-x64.exe
https://github.com/morewebs/OpenRemote/releases/latest/download/OpenRemote-Setup-x64.msi
https://github.com/morewebs/OpenRemote/releases/latest/download/OpenRemote-x86_64.AppImage
https://github.com/morewebs/OpenRemote/releases/latest/download/OpenRemote-amd64.deb
https://github.com/morewebs/OpenRemote/releases/latest/download/OpenRemote-universal.dmg
https://github.com/morewebs/OpenRemote/releases/latest/download/OpenRemote-universal.apk
https://github.com/morewebs/OpenRemote/releases/latest/download/openremote-daemon-linux-x86_64
https://github.com/morewebs/OpenRemote/releases/latest/download/SHA256SUMS
```

Every published release carries both names for each bundle: the versioned
one Tauri produces (`OpenRemote_0.3.2_x64-setup.exe`) and the version-free
one above. A version bump never edits a download link anywhere.

The version-free names start with the first tag after this landed - v0.3.2
predates them, so its release page has only the versioned assets.

## Nightly

The scheduled run, 03:17 UTC daily:

```
https://github.com/morewebs/OpenRemote/releases/download/nightly/OpenRemote-Setup-x64.exe
```

(the same names as the stable column, with `releases/download/nightly`
instead of `releases/latest/download`)

- Builds whatever is on the default branch, with no tag of its own. The
  release body names the commit, the build time, and the commits since the
  previous nightly.
- One rolling release at the tag `nightly`, deleted and recreated each
  night, so the URLs never change while the binaries follow `main`.
- **Always a prerelease.** That is what keeps `releases/latest` - and with
  it the site's download buttons and the in-app updater - on the stable
  channel. Never publish a nightly as a full release.
- A failed night leaves the channel empty until the next run (last night's
  release is deleted before tonight's is built, rather than serving a
  half-updated build). Re-running the failed scheduled run publishes it.
- Nightlies are not version-stamped: the app reports the stable version,
  so the release page's commit is the build's identity. Stamping a
  per-night version would have to survive MSI's numeric-only prerelease
  and macOS's numeric `CFBundleVersion`, which needs a real build on both
  to prove; until then the commit is the label.
- The APK keeps the stable `applicationId` and `versionCode`, so a nightly
  installs over a stable one and a stable one installs over a nightly
  (same signature, same code) - no uninstall, no wiped data.

### Firing it by hand

Actions > Release > Run workflow, channel `nightly`. With `build-only` the
run builds everything and publishes nothing, exactly as before.

Note that GitHub disables a scheduled workflow after 60 days of repository
inactivity; re-enable it in the Actions tab, then run it once by hand.

## Android versionCode

Unchanged rule, checked in the preflight for stable tags: each release's
`bundle.android.versionCode` must strictly exceed the previous tag's, or
Android refuses the update install. The nightly is exempt because it is
not a stable tag - and because it reuses the stable code on purpose.
