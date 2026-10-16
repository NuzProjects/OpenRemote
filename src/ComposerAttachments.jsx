// A composer's attachments: chips above its text - a picture's thumbnail,
// a picked element's picture and name - each with its own remove; and the
// ways in: paste, drop, and the attach button. Every composer uses it (the
// home screen's and each chat's, on the desktop and the phone). The items
// themselves live in attachments.js, where the browser adds its own.

import { useRef, useSyncExternalStore } from 'react'
import { CursorClick, ImageSquare, Paperclip, X } from '@phosphor-icons/react'
import { addAttachment, attachments, removeAttachment, subscribe } from './attachments.js'
import { MAX_IMAGES, imageAttachment } from './composer-attachments.js'

const NONE = []

// A file dropped anywhere else in the window must not replace the console
// with that file (a webview's default): only a composer takes files.
if (typeof window !== 'undefined') {
  const holdFiles = (e) => {
    if ([...(e.dataTransfer?.types ?? [])].includes('Files')) e.preventDefault()
  }
  window.addEventListener('dragover', holdFiles)
  window.addEventListener('drop', holdFiles)
}

/** A composer's attachments, live. */
export function useAttachments(key) {
  return useSyncExternalStore(subscribe, () => {
    const list = attachments(key)
    return list.length ? list : NONE
  })
}

function hostOf(url) {
  try {
    return new URL(url).host
  } catch {
    return url ?? ''
  }
}

function Chip({ item, off, why, onRemove }) {
  const element = item.kind === 'element'
  const name = element ? item.label || 'Element' : item.name || 'Picture'
  return (
    <div
      className={`ca-chip${element ? ' ca-chip--element' : ''}${off ? ' ca-chip--off' : ''}`}
      title={why ?? (element ? `${name} · ${hostOf(item.url)}` : name)}
    >
      {item.dataUrl ? (
        <img className="ca-thumb pv" src={item.dataUrl} alt="" draggable={false} />
      ) : (
        <span className="ca-thumb ca-thumb--none">
          {element ? <CursorClick size={14} /> : <ImageSquare size={14} />}
        </span>
      )}
      {element && (
        <span className="ca-label">
          <span className="ca-name">{name}</span>
          <span className="ca-where">{hostOf(item.url)}</span>
        </span>
      )}
      <button type="button" className="ca-remove" onClick={onRemove} title="Remove" aria-label={`Remove ${name}`}>
        <X size={11} weight="bold" />
      </button>
    </div>
  )
}

/**
 * The chips row above a composer's text. Where the harness reads no
 * pictures, a picture's chip is dimmed and says why (a picked element
 * still goes, as words).
 */
export function AttachmentChips({ composerKey, takesImages = true, harness = 'This harness' }) {
  const items = useAttachments(composerKey)
  if (!items.length) return null
  return (
    <div className="ca-row">
      {items.map((item) => {
        const off = !takesImages && item.kind === 'image'
        return (
          <Chip
            key={item.id}
            item={item}
            off={off}
            why={off ? `${harness} doesn't read pictures` : null}
            onRemove={() => removeAttachment(composerKey, item.id)}
          />
        )
      })}
    </div>
  )
}

/**
 * Paste, drop and the attach button for a composer: the handlers go on
 * its box, the button in its foot. Off (`enabled` false) where the
 * harness reads no pictures: nothing is taken in and there is no button.
 */
export function useAttachInput(composerKey, { enabled, onError }) {
  const fileRef = useRef(null)
  const isImage = (file) => file.type.startsWith('image/')
  const take = async (files) => {
    for (const file of files.filter(isImage)) {
      if (attachments(composerKey).length >= MAX_IMAGES) {
        onError?.(`A message can carry ${MAX_IMAGES} pictures at most.`)
        return
      }
      try {
        addAttachment(await imageAttachment(file), composerKey)
      } catch (err) {
        onError?.(err.message ?? String(err))
      }
    }
  }
  const onPaste = (e) => {
    const files = [...(e.clipboardData?.files ?? [])]
    if (!enabled || !files.some(isImage)) return
    e.preventDefault()
    take(files)
  }
  const onDragOver = (e) => {
    if (!enabled || ![...(e.dataTransfer?.types ?? [])].includes('Files')) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'copy'
  }
  const onDrop = (e) => {
    const files = [...(e.dataTransfer?.files ?? [])]
    if (!enabled || !files.some(isImage)) return
    e.preventDefault()
    take(files)
  }
  // The picker takes any picture: kinds the harnesses don't read are drawn
  // again as one they do.
  const button = enabled ? (
    <>
      <input
        ref={fileRef}
        type="file"
        accept="image/*"
        multiple
        hidden
        onChange={(e) => {
          take([...e.target.files])
          e.target.value = ''
        }}
      />
      <button
        type="button"
        className="nc-meta ca-attach"
        onClick={() => fileRef.current?.click()}
        title="Attach pictures - or paste or drop them"
        aria-label="Attach pictures"
      >
        <Paperclip size={14} />
      </button>
    </>
  ) : null
  return { onPaste, onDragOver, onDrop, button }
}
