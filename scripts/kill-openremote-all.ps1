# Kill everything a dev run leaves behind, then say what survived.
#
# Three processes outlive each other and none is the others' parent: the app,
# its daemon sidecar (the shell spawns it and can be killed without it), and
# the Vite dev server (the Tauri CLI's beforeDevCommand child, which survives a
# force-killed CLI). A stale Vite keeps 5175 and serves the old module graph,
# which is how the next `tauri dev` ends up showing code nobody saved.
$ErrorActionPreference = 'SilentlyContinue'

Get-Process openremote-ui-desktop | Stop-Process -Force
Get-Process openremote-daemon | Stop-Process -Force

# The app's own WebView2 processes: the name alone would take Edge's too, so
# the command line has to carry the app's user-data dir.
$ours = Get-CimInstance Win32_Process -Filter "name='msedgewebview2.exe'" |
  Where-Object { $_.CommandLine -match 'space\.moreweb\.openremote' }
foreach ($p in $ours) {
  Write-Output "killing webview PID $($p.ProcessId)"
  Stop-Process -Id $p.ProcessId -Force
}

# Whoever is listening on the dev port (`vite.config.js` pins 5175 and refuses
# to fall back to another one, so a survivor keeps the real port busy).
$server = Get-NetTCPConnection -LocalPort 5175 -State Listen |
  Select-Object -ExpandProperty OwningProcess -Unique
foreach ($owner in $server) {
  Write-Output "killing dev server PID $owner"
  Stop-Process -Id $owner -Force
}

Start-Sleep -Seconds 2

$left = Get-CimInstance Win32_Process -Filter "name='msedgewebview2.exe'" |
  Where-Object { $_.CommandLine -match 'space\.moreweb\.openremote' }
Write-Output "remaining ours: $($left.Count)"
# 5175 is the dev server; 9333 is the dev build's DevTools port (main.rs).
foreach ($port in 5175, 9333) {
  $listeners = Get-NetTCPConnection -LocalPort $port -State Listen
  Write-Output "port ${port} listeners: $($listeners.Count)"
}
