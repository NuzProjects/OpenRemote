import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    // Localhost only (vite's default): nothing consumes the dev server
    // off this machine, and binding all interfaces would put the dev
    // console on the LAN.
    // Pinned to match tauri.conf.json devUrl. Vite's default (5173) collides
    // with other apps on this machine, and its silent fallback to the next
    // free port leaves the Tauri window pointed at the wrong server.
    // Host pinned to 127.0.0.1: on this machine, ::1 loopback connects are
    // denied system-wide (EACCES), so Vite's default IPv6-only bind leaves
    // Tauri's readiness probe and the webview unable to reach the server.
    host: '127.0.0.1',
    port: 5175,
    strictPort: true,
    watch: {
      ignored: [
        '**/src-tauri/**',
        '**/daemon/**',
        // An editor that saves atomically writes the new file into a
        // `.name.hash.tmpdir` directory beside the original and renames it
        // into place. The watcher sees the temporary name appear and can lose
        // the race with the rename, which it reports as EBUSY on a path that no
        // longer exists - and Vite treats a watcher error as fatal, so the dev
        // server exits under a window that stays open and looks hung. The
        // temporary directory is never worth watching: only the file it becomes
        // matters, and that write is seen after the rename.
        '**/.*.tmpdir/**',
      ],
      // fs.watch on Windows reports a rename over a file being read as EBUSY,
      // and Vite treats a watcher error as fatal: the dev server exits and the
      // window keeps its last frame, which reads as a hang. Polling does not
      // use the platform watcher at all, so a save can never take the server
      // down; 400 ms is the upper bound on how stale a hot update can be, and
      // the tree being watched is one source folder.
      usePolling: true,
      interval: 400,
    },
  },
})
