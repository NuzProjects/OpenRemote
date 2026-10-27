// How much one message may carry.
//
// The daemon's loopback listener takes the framework's default body limit of
// 2 MiB, and the JSON envelope around a prompt spends a little of that on the
// request id, so the honest client bound sits just under the ceiling. A
// message over it is answered 413 with an empty body, which the client can
// only report as "HTTP 413" - a number nobody can act on. Both halves live
// here so the composer that warns and the error that explains cannot drift
// apart.

export const MAX_MESSAGE_BYTES = 2_000_000

function megabytes(bytes) {
  return `${(bytes / 1e6).toFixed(1)} MB`
}

/// The bytes a message actually takes on the wire, not its character count:
/// an emoji is four bytes and would otherwise pass a bound it should not.
export function messageBytes(text) {
  return typeof text === 'string' ? new TextEncoder().encode(text).length : 0
}

/// The sentence to show before a send, carrying the message's own size and
/// the limit, because "too long" without either number leaves the person
/// guessing which half to cut.
export function tooLongMessage(bytes) {
  return `That message is ${megabytes(bytes)}. OpenRemote sends at most ${megabytes(MAX_MESSAGE_BYTES)} in one message. Split it, or attach it as a file.`
}

/// What the client says when a body was refused before it could read a size
/// from the answer: the same limit, without a number for this message.
export const TOO_LONG_SENTENCE = `That message is too long. OpenRemote sends at most ${megabytes(MAX_MESSAGE_BYTES)} in one message. Split it, or attach it as a file.`

/// Null while the message fits, the sentence when it does not. A composer
/// disables its send control on this and shows the sentence beside it.
export function messageBound(text) {
  const bytes = messageBytes(text)
  return bytes <= MAX_MESSAGE_BYTES ? null : tooLongMessage(bytes)
}
