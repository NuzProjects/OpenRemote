// Metrics: the session record, counted - statuses, the synced split,
// the harnesses, the rhythm of new chats - beside this machine's own
// presence band. Everything derives from the poll. The running totals a
// chat folds (cost, thinking tokens) exist only for chats this console
// has watched, so they stay out until the daemon can aggregate them
// itself.

import { useConsole } from './state/console.jsx'
import { harnessName } from './harness-names.js'
import { createdPerDay, harnessCounts, machinePresence, statusSentence, syncSplit } from './metrics.js'
import './devices.css'
import './panels.css'
import './metrics.css'

// One quiet bar: the count as height against the window's busiest day,
// never lower than the zero stub.
function DayBar({ band, max }) {
  const day = new Date(band.start).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
  return (
    <span
      className={`mx-bar${band.count === 0 ? ' mx-bar--zero' : ''}`}
      style={band.count === 0 ? undefined : { height: `${Math.max(4, Math.round((band.count / max) * 28))}px` }}
      title={`${band.count === 1 ? '1 chat' : `${band.count} chats`} · ${day}`}
    />
  )
}

export default function MetricsView() {
  const { sessions, machines, devices, thisDevice } = useConsole()
  const list = sessions ?? []
  const sentence = statusSentence(list)
  const split = syncSplit(list, thisDevice)
  const harnesses = harnessCounts(list)
  const days = createdPerDay(list, 14)
  const dayMax = Math.max(...days.map((d) => d.count), 1)
  const anyDays = days.some((d) => d.count > 0)
  const presence = machinePresence(machines)
  const onlineCount = (devices ?? []).filter((d) => d.online).length

  return (
    <div className="panel">
      <header className="dv-head">
        <div>
          <h1 className="dv-title">Metrics</h1>
          <p className="dv-meta">
            {list.length} {list.length === 1 ? 'chat' : 'chats'} on record
          </p>
        </div>
      </header>

      {list.length === 0 ? (
        <p className="pn-empty">No chats on record yet. Start one - it shows up here.</p>
      ) : (
        <>
          <h2 className="pn-section">Chats on record</h2>
          <div className="pn-list pn-list--tight">
            <div className="pn-row">
              <div>
                <div className="pn-name">
                  {list.length} {list.length === 1 ? 'chat' : 'chats'}, every status
                </div>
                {/* The sentence names only the nonzero statuses. */}
                <div className="pn-detail">{sentence || 'All idle.'}</div>
              </div>
            </div>
          </div>

          {split.here + split.elsewhere > 0 && (
            <>
              <h2 className="pn-section">In your Cloud</h2>
              <div className="pn-list pn-list--tight">
                <div className="pn-row">
                  <div>
                    <div className="pn-name">
                      {split.here + split.elsewhere} synced{' '}
                      {split.here + split.elsewhere === 1 ? 'chat' : 'chats'}
                    </div>
                    <div className="pn-detail">
                      {split.here === 1 ? '1 runs' : `${split.here} run`} here ·{' '}
                      {split.elsewhere === 1 ? '1 runs' : `${split.elsewhere} run`} on other devices
                      {(devices ?? []).length > 0
                        ? ` · ${onlineCount} device${onlineCount === 1 ? '' : 's'} online`
                        : ''}
                    </div>
                  </div>
                </div>
              </div>
            </>
          )}

          {harnesses.length > 0 && (
            <>
              <h2 className="pn-section">By harness</h2>
              <div className="pn-list pn-list--tight">
                {harnesses.map((h) => (
                  <div className="pn-row" key={h.harness}>
                    <div>
                      <div className="pn-name">{harnessName(h.harness)}</div>
                      <div className="pn-detail">
                        {h.count} {h.count === 1 ? 'chat' : 'chats'}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </>
          )}

          {anyDays && (
            <>
              <h2 className="pn-section">New chats</h2>
              <div className="mx-strip">
                {days.map((band) => (
                  <DayBar key={band.key} band={band} max={dayMax} />
                ))}
              </div>
              <p className="mx-cap">the last 14 days</p>
            </>
          )}
        </>
      )}

      {presence && (
        <>
          <h2 className="pn-section">Agent presence</h2>
          <div className="mx-band">
            {presence.map((on, i) => (
              <span key={i} className={`mx-cell${on ? ' mx-cell--on' : ''}`} />
            ))}
          </div>
          <p className="mx-cap">the last 24 hours - each cell is half an hour</p>
        </>
      )}
    </div>
  )
}
