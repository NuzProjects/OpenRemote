// The account's one row: where the sign-in stands, in the daemon's own
// state words, and its door - sign in (the browser handoff, the link
// when no browser opened) or sign out (with its confirm). Account and
// Mobile both open with it; the poll settles everything after.

import { useState } from 'react'
import { useConsole } from './state/console.jsx'
import { cloudAlert, signedIn, daemonReason } from './cloud.js'
import './panels.css'
import { errorCopy } from './error-copy.js'

const signedName = (email) =>
  email ? (
    <>
      Signed in as <span className="pv">{email}</span>
    </>
  ) : (
    'Signed in'
  )

// What the row says for each state. CloudMode says the same things on
// its door; this is the quiet, in-list version.
function words(cloud, one) {
  const email = cloud?.account?.email
  switch (cloud?.state) {
    case 'signing_in':
      return {
        name: 'Signing in',
        detail:
          one === 'phone'
            ? "The sign-in page is open. Authorize OpenRemote and you'll come straight back here."
            : "moreweb's sign-in page is open in your browser. Come back once it says you're signed in.",
      }
    case 'connecting':
      return { name: signedName(email), detail: 'Reaching your devices.' }
    case 'online':
      return { name: signedName(email), detail: 'Your devices are reachable.' }
    case 'offline':
      return { name: signedName(email), detail: 'Your devices are not reachable right now.' }
    case 'relink':
      return {
        name: 'Sign in ended',
        detail:
          daemonReason(cloud) ?? `Your sign-in on this ${one} ended. Sign in to reach your devices again.`,
      }
    case 'revoked':
      return {
        name: `This ${one} was removed`,
        detail:
          'It was taken out of your Cloud, and the synced chats it kept were deleted here. Sign in to add it again.',
      }
    default:
      return {
        name: 'Not signed in',
        detail:
          'Cloud connects your devices - chats sync between them end to end encrypted. Local chats never need an account.',
      }
  }
}

export default function CloudStateRow({ one = 'computer' }) {
  const { cloud, connection, signInCloud, cancelCloudSignIn, signOutCloud } = useConsole()
  const [link, setLink] = useState(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const [confirmSignOut, setConfirmSignOut] = useState(false)
  const inCloud = signedIn(cloud)
  const signingIn = cloud?.state === 'signing_in'
  const { name, detail } = words(cloud, one)
  // A failed click answers with the daemon's own sentence, which is often
  // the row's detail already: the alert drops it rather than saying it twice.
  const alert = cloudAlert({ clickError: error, cloud, body: detail, signingIn })

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
    <>
      <div className="pn-row">
        <div>
          <div className="pn-name">{name}</div>
          <div className="pn-detail">{detail}</div>
        </div>
        {signingIn ? (
          <div className="pn-actions">
            <button type="button" className="pn-btn" onClick={start} disabled={busy}>
              Open the page again
            </button>
            <button type="button" className="pn-btn" onClick={cancel}>
              Cancel
            </button>
          </div>
        ) : inCloud ? (
          confirmSignOut ? (
            <div className="pn-actions">
              <button
                type="button"
                className="pn-btn"
                onClick={async () => {
                  setConfirmSignOut(false)
                  await signOutCloud()
                }}
              >
                Sign out
              </button>
              <button type="button" className="pn-btn" onClick={() => setConfirmSignOut(false)}>
                Cancel
              </button>
            </div>
          ) : (
            <button type="button" className="pn-btn" onClick={() => setConfirmSignOut(true)}>
              Sign out
            </button>
          )
        ) : (
          <button
            type="button"
            className="pn-btn"
            onClick={start}
            disabled={busy || connection.state !== 'connected'}
          >
            {cloud?.state === 'revoked' || cloud?.state === 'relink' ? 'Sign in again' : 'Sign in'}
          </button>
        )}
      </div>
      {link && (
        <div className="pn-row">
          <code className="pn-command">{link}</code>
          <div className="pn-actions">
            <button
              type="button"
              className="pn-btn"
              onClick={() => navigator.clipboard?.writeText(link).catch(() => {})}
            >
              Copy link
            </button>
          </div>
        </div>
      )}
      {alert && (
        <p className="pn-error" role="alert">
          {alert}
        </p>
      )}
    </>
  )
}
