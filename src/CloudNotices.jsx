// What Cloud owes the user right where they work: a device that joined
// their account (any sign-in adds one, so "Not you?" is their check), and
// this computer being made a machine from another device. Each notice is
// shown once and says what it can undo.

import { useEffect, useState } from 'react'
import { useConsole } from './state/console.jsx'
import { madeMachineElsewhere, newDevices, signedIn } from './cloud.js'
import { errorCopy } from './error-copy.js'
import './notices.css'

function load(key) {
  try {
    return JSON.parse(localStorage.getItem(key) ?? 'null')
  } catch {
    return null
  }
}

function save(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value))
  } catch {
    /* storage unavailable */
  }
}

export default function CloudNotices() {
  const { cloud, devices, thisDevice, removeDevice, setDeviceKind } = useConsole()
  const account = cloud?.account?.id
  const knownKey = `openremote-known-devices:${account}`
  const kindKey = `openremote-last-kind:${thisDevice}`
  const [known, setKnown] = useState(null)
  const [lastKind, setLastKind] = useState(null)
  const [confirming, setConfirming] = useState(null)
  // The device whose removal is in flight. The confirm's own button used to
  // fire twice on a double click, and the second call failed with "no such
  // device" and painted that error over a removal that had worked.
  const [removing, setRemoving] = useState(null)
  const [error, setError] = useState(null)
  const ready = signedIn(cloud) && account && thisDevice && (devices ?? []).length > 0
  const me = (devices ?? []).find((d) => d.id === thisDevice)

  const settleKind = (kind) => {
    save(kindKey, kind)
    setLastKind(kind)
  }

  // The first look at an account is the baseline: nothing is new yet.
  useEffect(() => {
    if (!ready) return
    let saved = load(knownKey)
    if (!saved) {
      saved = devices.map((d) => d.id)
      save(knownKey, saved)
    }
    setKnown(saved)
    let kind = load(kindKey)
    if (!kind && me) {
      kind = me.kind
      save(kindKey, kind)
    }
    setLastKind(kind)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, knownKey, kindKey])

  // A kind change that is not news (made here, or reverted) is remembered
  // in an effect, never in the render body: a render can be thrown away
  // (StrictMode double-run, a concurrent update landing mid-render), and
  // a storage write from a render nobody committed to must not stand as
  // the last word. The baseline effect above establishes `lastKind`
  // first; until it has, there is nothing to reconcile against. The
  // `lastKind` dep re-runs this once the baseline lands, so the two never
  // race past each other.
  useEffect(() => {
    if (!me || lastKind == null || me.kind === lastKind) return
    if (madeMachineElsewhere(me.kind, lastKind, load(`openremote-kind-set-here:${thisDevice}`))) return
    // Changed here, or back: nothing to say, just remember it.
    settleKind(me.kind)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [me?.kind, lastKind])

  if (!ready || !known) return null

  const acknowledge = (id) => {
    const next = [...known, id]
    save(knownKey, next)
    setKnown(next)
    setConfirming(null)
  }

  const fresh = newDevices(devices, known, thisDevice)
  const madeMachine = me && madeMachineElsewhere(me.kind, lastKind, load(`openremote-kind-set-here:${thisDevice}`))
  if (fresh.length === 0 && !madeMachine && !error) return null

  return (
    <div className="cn-stack" role="status">
      {fresh.map((device) => (
        <div key={device.id} className="cn-row">
          <span className="cn-text">
            {confirming === device.id
              ? <>Remove <span className="pv">{device.name}</span>? It loses access to your machines and chats.</>
              : <>New device: <span className="pv">{device.name}</span> joined your Cloud. Not you?</>}
          </span>
          {confirming === device.id ? (
            <>
              <button
                type="button"
                className="cn-btn primary"
                disabled={removing === device.id}
                onClick={async () => {
                  if (removing === device.id) return
                  setRemoving(device.id)
                  setError(null)
                  try {
                    await removeDevice(device.id)
                    acknowledge(device.id)
                  } catch (err) {
                    // The daemon's words are quoted by errorCopy; this note has
                    // no retry of its own, so the line promises none.
                    setError(errorCopy(err))
                  } finally {
                    setRemoving(null)
                  }
                }}
              >
                {removing === device.id ? 'Removing...' : 'Remove'}
              </button>
              <button type="button" className="cn-btn" onClick={() => setConfirming(null)} disabled={removing === device.id}>
                Keep
              </button>
            </>
          ) : (
            <>
              <button type="button" className="cn-btn" onClick={() => setConfirming(device.id)}>
                Remove
              </button>
              <button type="button" className="cn-btn" onClick={() => acknowledge(device.id)}>
                It's mine
              </button>
            </>
          )}
        </div>
      ))}
      {madeMachine && (
        <div className="cn-row">
          <span className="cn-text">
            This computer was made a machine: your other devices can run chats here while OpenRemote is open.
          </span>
          <button
            type="button"
            className="cn-btn"
            onClick={async () => {
              setError(null)
              try {
                await setDeviceKind(thisDevice, 'desktop')
                settleKind('desktop')
              } catch (err) {
                setError(errorCopy(err))
              }
            }}
          >
            Undo
          </button>
          <button type="button" className="cn-btn" onClick={() => settleKind('machine')}>
            OK
          </button>
        </div>
      )}
      {error && (
        <div className="cn-row">
          <span className="cn-text">{error}</span>
          <button type="button" className="cn-btn" onClick={() => setError(null)}>
            OK
          </button>
        </div>
      )}
    </div>
  )
}
