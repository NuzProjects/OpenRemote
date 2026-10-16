# In-app updates

The desktop app checks the latest GitHub release for `latest.json` once a
day (Settings > This install > Updates) and installs a newer version when
the user clicks Update and restart. Updates are signed: the app carries the
public half of a signing key and refuses anything else.

Until the key exists, the app says updates aren't switched on and release
builds are exactly as before.

## Switching updates on (once)

1. Generate the key pair on your own machine (keep the private key and its
   password safe; losing them means users must reinstall by hand):

   ```sh
   npx tauri signer generate -w ~/.tauri/openremote-updates.key
   ```

2. Put the printed public key into `src-tauri/tauri.conf.json` at
   `plugins.updater.pubkey`.
3. Add two repository secrets on GitHub: `TAURI_SIGNING_PRIVATE_KEY` (the
   private key file's contents) and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`.

From the next tag on, the release workflow signs the Windows installer, the
macOS app archive and the Linux AppImage, uploads each `.sig` beside them,
and writes `latest.json` (`scripts/updater-manifest.mjs`).
