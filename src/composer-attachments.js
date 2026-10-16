// A composer's attachments (attachments.js keeps them) as a message
// carries them: pictures become the message's attachments; an element
// picked in the browser becomes words added to the message - where it came
// from and what it is - plus its picture. The limits match the daemon's.

export const MAX_IMAGE_BYTES = 5 * 1024 * 1024
export const MAX_IMAGES = 10
// What the harnesses read; anything else is drawn again as one of these.
export const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp']
// Pictures for a chat on another device ride Cloud's 4 MB request; this
// leaves room for the rest of the message.
export const REMOTE_BYTES = 3_800_000
// A picture drawn smaller keeps at most this long side (what Claude reads
// in full; larger is scaled down on its side anyway).
const LONG_SIDE = 2576

/** A data URL's parts, `{ mime, data }` with the bytes in base64, or null. */
export function dataUrlParts(dataUrl) {
  if (typeof dataUrl !== 'string' || !dataUrl.startsWith('data:')) return null
  const comma = dataUrl.indexOf(',')
  const head = dataUrl.slice(5, comma)
  if (comma === -1 || !head.endsWith(';base64')) return null
  return { mime: head.split(';')[0], data: dataUrl.slice(comma + 1) }
}

/** How many bytes a base64 string holds. */
export function base64Bytes(data) {
  const pad = data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0
  return Math.floor((data.length * 3) / 4) - pad
}

/** The words a picked element adds to the message. */
export function elementText(item) {
  const where = item.title ? `${item.title} (${item.url})` : item.url
  return `Picked element from ${where}:\n${item.details ?? ''}`.trimEnd()
}

/**
 * What a composer sends: `{ text, attachments, error }`. The typed words
 * come first, then each picked element's; pictures go as attachments
 * (`{ kind: 'image', mime, data }`). For a harness that reads no pictures
 * (`images: false`) an element goes as words alone, and pictures can't go
 * at all - `error` says so, and nothing is sent.
 */
export function outgoing(text, items, { images = true, harness = 'This harness', remote = false } = {}) {
  const blocks = []
  const attachments = []
  let pictures = 0
  for (const item of items) {
    if (item.kind === 'element') {
      blocks.push(elementText(item))
      const parts = images ? dataUrlParts(item.dataUrl) : null
      if (parts) attachments.push({ kind: 'image', mime: parts.mime, data: parts.data })
    } else if (item.kind === 'image') {
      pictures += 1
      const parts = dataUrlParts(item.dataUrl)
      if (parts) attachments.push({ kind: 'image', mime: parts.mime, data: parts.data })
    }
  }
  const words = [text.trim(), ...blocks].filter(Boolean).join('\n\n')
  let error = null
  if (pictures && !images) {
    error = `${harness} doesn't read pictures - remove them to send.`
  } else if (attachments.length > MAX_IMAGES) {
    error = `A message can carry ${MAX_IMAGES} pictures at most.`
  } else if (attachments.some((a) => base64Bytes(a.data) > MAX_IMAGE_BYTES)) {
    error = 'A picture is over 5 MB - remove it or attach a smaller one.'
  } else if (remote && attachments.reduce((n, a) => n + a.data.length, words.length) > REMOTE_BYTES) {
    error = 'Pictures for a chat on another device can add up to about 3 MB per message - remove some.'
  }
  return { text: words, attachments, error }
}

function readAsDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result)
    reader.onerror = () => reject(reader.error)
    reader.readAsDataURL(blob)
  })
}

function encode(canvas, type, quality) {
  return new Promise((resolve) => canvas.toBlob(resolve, type, quality))
}

/**
 * A picture fit to send: as it is when the harnesses read its kind and it
 * is under the limit, else drawn again smaller - PNG kept as PNG where it
 * fits, JPEG otherwise.
 */
async function fitted(blob) {
  if (IMAGE_TYPES.includes(blob.type) && blob.size <= MAX_IMAGE_BYTES) return blob
  const bitmap = await createImageBitmap(blob)
  const scale = Math.min(1, LONG_SIDE / Math.max(bitmap.width, bitmap.height))
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.round(bitmap.width * scale))
  canvas.height = Math.max(1, Math.round(bitmap.height * scale))
  canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height)
  bitmap.close?.()
  let out = blob.type === 'image/png' ? await encode(canvas, 'image/png') : null
  if (!out || out.size > MAX_IMAGE_BYTES) out = await encode(canvas, 'image/jpeg', 0.9)
  if (!out || out.size > MAX_IMAGE_BYTES) throw new Error('This picture is too large to send, even made smaller.')
  return out
}

/** A pasted, dropped or picked file as a composer attachment. */
export async function imageAttachment(file) {
  let blob
  try {
    blob = await fitted(file)
  } catch (err) {
    throw new Error(err?.message?.startsWith('This picture') ? err.message : `${file.name || 'That file'} isn't a picture that can be sent.`)
  }
  return { kind: 'image', name: file.name || 'Pasted picture', mime: blob.type, dataUrl: await readAsDataUrl(blob) }
}
