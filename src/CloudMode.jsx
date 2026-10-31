// Cloud's door: the main area while the mode switch sits on Cloud and this
// computer isn't signed in. The subject is the cloud, drawn in once, then
// the words and one action. Signing in happens in the system browser; the
// daemon opens it and the poll notices when it's done.

import { useState } from 'react'
import { Copy } from '@phosphor-icons/react'
import { useConsole } from './state/console.jsx'
import { cloudAlert, daemonReason } from './cloud.js'
import { isMobile } from './platform.js'
import './cloudmode.css'
import { errorCopy } from './error-copy.js'

// What the screen says for each sign-in state. A phone is Cloud only, so
// its door speaks for the whole app and never offers Local.
function words(cloud) {
  if (isMobile) return phoneWords(cloud)
  switch (cloud?.state) {
    case 'signing_in':
      return {
        title: 'Finish in your browser',
        body: "moreweb's sign-in page is open in your browser. Come back here once it says you're signed in.",
      }
    case 'relink': {
      const reason = daemonReason(cloud)
      if (reason) return { title: 'Sign in again', body: reason }
      return {
        title: 'Sign in again',
        body: 'Your sign-in on this computer ended. Sign in to reach your other devices again.',
      }
    }
    case 'revoked':
      return {
        title: 'This computer was removed',
        body: "It was taken out of your Cloud, and the synced chats it kept for your other devices were deleted here. Its Local chats are untouched. Sign in to add it again.",
      }
    default:
      return {
        title: 'Sign in to use Cloud',
        body: 'Cloud connects this computer with your others - servers, home machines, other laptops. Chats sync between them end to end encrypted; moreweb never sees or keeps them.',
      }
  }
}

function phoneWords(cloud) {
  switch (cloud?.state) {
    case 'signing_in':
      return {
        title: 'Finish signing in',
        body: "moreweb's sign-in page is open. Authorize OpenRemote there and you'll come straight back here.",
      }
    case 'relink': {
      const reason = daemonReason(cloud)
      if (reason) return { title: 'Sign in again', body: reason }
      return {
        title: 'Sign in again',
        body: 'Your sign-in on this phone ended. Sign in to reach your computers again.',
      }
    }
    case 'revoked':
      return {
        title: 'This phone was removed',
        body: 'It was taken out of your Cloud, and the synced chats it kept were deleted. Sign in to add it again.',
      }
    default:
      return {
        title: 'Your coding agents, in your pocket',
        body: 'Agents run on your computers. Chats sync encrypted. moreweb never sees or keeps them.',
      }
  }
}

export default function CloudMode() {
  const { cloud, connection, signInCloud, cancelCloudSignIn } = useConsole()
  const [link, setLink] = useState(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const { title, body } = words(cloud)
  const signingIn = cloud?.state === 'signing_in'
  // A failed click answers with the daemon's own sentence, which is often
  // the body already: the alert drops it rather than saying it twice.
  const alert = cloudAlert({ clickError: error, cloud, body, signingIn })

  const start = async () => {
    setBusy(true)
    setError(null)
    try {
      const started = await signInCloud()
      // No browser could be opened from here: hand over the link instead.
      setLink(started?.opened ? null : started?.authorize_url ?? null)
    } catch (err) {
      setError(errorCopy(err))
    } finally {
      setBusy(false)
    }
  }

  const cancel = async () => {
    setLink(null)
    try {
      await cancelCloudSignIn()
    } catch {
      /* the poll settles it */
    }
  }

  return (
    <div className="cloudmode">
      <div className="cm-panel">
        <svg
          className="cm-hero"
          viewBox="0 0 260 170"
          role="img"
          aria-label="Cloud"
        >
          <path
            className="cm-cloud"
            d="M17.5 19H9a7 7 0 1 1 6.71-9h1.79a4.5 4.5 0 1 1 0 9Z"
            transform="translate(68 34) scale(5.2)"
          />
        </svg>

        <h1 className="cm-title">{title}</h1>
        <p className="cm-body">{body}</p>
        {alert && (
          <p className="cm-error" role="alert">
            {alert}
          </p>
        )}

        {link && (
          <div className="cm-linkbox">
            <span className="cm-linktext">{link}</span>
            <button
              type="button"
              className="cm-back cm-copy"
              onClick={() => navigator.clipboard?.writeText(link)}
              title="Copy the sign-in link"
            >
              <Copy size={13} />
              Copy link
            </button>
          </div>
        )}

        <div className="cm-actions">
          {signingIn ? (
            <>
              <button type="button" className="cm-back primary" onClick={start} disabled={busy}>
                Open the page again
              </button>
              <button type="button" className="cm-back" onClick={cancel}>
                Cancel
              </button>
            </>
          ) : (
            <>
              <div className="cm-door">
                <button
                  type="button"
                  className="cm-back primary"
                  onClick={start}
                  disabled={busy || connection.state !== 'connected'}
                >
                  {cloud?.state === 'revoked' || cloud?.state === 'relink' ? 'Sign in again' : 'Sign in'}
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
