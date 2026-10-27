// The account's one row: where the sign-in stands, in the daemon's own
// state words, and its door - sign in (the browser handoff, the link
// when no browser opened) or sign out (with its confirm). Account and
// Mobile both open with it; the poll settles everything after.

import { useState } from 'react'
import { useConsole } from './state/console.jsx'
import { cloudAlert, cloudAnswered, signedIn, daemonReason } from './cloud.js'
import './panels.css'
import { errorCopy } from './error-copy.js'

// What signing out does to this device's copy, said where the person is about
// to press it. The revoked row next door already explains the same consequence
// for the removal case; this is the half a person can choose.
const SIGN_OUT_NOTE =
  'Signing out removes the chats this computer copied from your Cloud here. Private chats stay on this computer.'

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
  // Not asked yet: the console starts before the daemon has said anything,
  // and a signed-in person must not read "Not signed in" for that gap.
  if (!cloudAnswered(cloud)) {
    return { name: 'Checking the Cloud sign-in', detail: 'Asking the daemon on this computer.' }
  }
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
      return { name: signedName(email), detail: 'Connecting to Cloud.' }
    case 'online':
      // What the daemon knows is that its relay link is up, not that every
      // device of the account is answering: a row that said "your devices are
      // reachable" would be promising for the one machine that is asleep.
      return { name: signedName(email), detail: 'Connected to Cloud.' }
    case 'offline':
      return { name: signedName(email), detail: 'Cloud is not reachable right now.' }
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
  const [signingOut, setSigningOut] = useState(false)
  const [error, setError] = useState(null)
  const [confirmSignOut, setConfirmSignOut] = useState(false)
  const inCloud = signedIn(cloud)
  const signingIn = cloud?.state === 'signing_in'
  const answers = words(cloud, one)
  // While the confirm is up or the sign-out is running, the row says what the
  // button is about to do and then what it is doing, instead of continuing to
  // describe a Cloud state that is being left.
  const name = signingOut ? 'Signing out' : confirmSignOut ? 'Sign out?' : answers.name
  const detail = signingOut || confirmSignOut ? SIGN_OUT_NOTE : answers.detail
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

  // Signing out is a click that can fail (the daemon may be restarting, the
  // request may be refused) and the row must not keep claiming the account
  // state it is trying to leave: the words above switch to "Signing out"
  // while it runs, and a rejection surfaces the way a failed sign-in does.
  const signOut = async () => {
    setConfirmSignOut(false)
    setSigningOut(true)
    setError(null)
    try {
      await signOutCloud()
    } catch (err) {
      setError(errorCopy(err))
    } finally {
      setSigningOut(false)
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
              <button type="button" className="pn-btn" onClick={signOut} disabled={busy}>
                Sign out
              </button>
              <button type="button" className="pn-btn" onClick={() => setConfirmSignOut(false)}>
                Cancel
              </button>
            </div>
          ) : (
            <button
              type="button"
              className="pn-btn"
              onClick={() => setConfirmSignOut(true)}
              disabled={signingOut}
            >
              Sign out
            </button>
          )
        ) : !cloudAnswered(cloud) ? null : (
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
