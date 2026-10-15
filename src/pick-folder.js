// The workspace picker: the native OS folder dialog under Tauri, nothing
// in browser mode (no dead buttons - the caller hides Browse there).
// Cloud machines get their own picker when remote check-in lands.

export const hasTauri = typeof window !== 'undefined' && !!window.__TAURI_INTERNALS__

/// Open the OS folder dialog; resolves to the chosen path or null.
export async function pickFolder(title = 'Choose a workspace folder') {
  if (!hasTauri) return null
  const { open } = await import('@tauri-apps/plugin-dialog')
  return open({ directory: true, multiple: false, title })
}

/// Open the OS file dialog for a plugin archive; the chosen path or null.
export async function pickFile(title) {
  if (!hasTauri) return null
  const { open } = await import('@tauri-apps/plugin-dialog')
  return open({
    directory: false,
    multiple: false,
    title,
    filters: [{ name: 'Plugin archive', extensions: ['zip', 'gz', 'tgz'] }],
  })
}

export const canPickFolder = hasTauri
