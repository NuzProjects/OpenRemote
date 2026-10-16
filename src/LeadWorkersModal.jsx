import { useEffect } from 'react'
import { X } from '@phosphor-icons/react'
import { useConsole } from './state/console.jsx'
import { useBack } from './use-back.js'
import { descendantsOf, isAlive } from './team.js'
import './devices.css'
import './panels.css'
import './contextmenu.css'

// A chat that has workers is being archived or deleted: what becomes of
// them is the user's call, asked once, in place, wherever the click came
// from (the sidebar, a pane's menu, Settings, the chat's own header). Esc,
// the backdrop and X close it like the other modals - and mean "never mind".
export default function LeadWorkersModal() {
  const { teamAsk } = useConsole()
  return teamAsk ? <Asking ask={teamAsk} /> : null
}

function Asking({ ask }) {
  const { answerTeamAsk, sessions, chats } = useConsole()
  const cancel = () => answerTeamAsk(null)
  useBack(true, cancel)
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape') cancel()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const team = descendantsOf(sessions, ask.id)
  const running = team.filter(({ session }) => isAlive(session)).length
  const title = chats[ask.id]?.title ?? sessions.find((s) => s.id === ask.id)?.title ?? 'This chat'
  const workers = `${team.length} worker${team.length === 1 ? '' : 's'}`
  const archive = ask.action === 'archive'

  return (
    <div
      className="dv-modal-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) cancel()
      }}
    >
      <div
        className="dv-modal"
        role="dialog"
        aria-modal="true"
        aria-label={archive ? 'Archive with its workers' : 'Delete with its workers'}
      >
        <div className="dv-modal-head">
          <h2 className="dv-modal-title">{archive ? 'Archive with its workers?' : 'Delete with its workers?'}</h2>
          <button className="dv-modal-close" onClick={cancel} title="Close">
            <X size={14} weight="bold" />
          </button>
        </div>
        <p className="dv-modal-hint">
          <strong className="pv">{title}</strong> has {workers}
          {running > 0 ? `, ${running} still running` : ''}.{' '}
          {archive
            ? 'Archiving hides a chat on this computer; it keeps running.'
            : 'Deleting it neither stops them nor deletes them, unless you say so.'}
        </p>
        <div className="ctx-modal-actions">
          <button type="button" className="pn-btn" onClick={cancel}>
            Cancel
          </button>
          {archive ? (
            <>
              <button type="button" className="pn-btn" onClick={() => answerTeamAsk('leave')}>
                Leave them
              </button>
              {running > 0 && (
                <button type="button" className="pn-btn" onClick={() => answerTeamAsk('stop')}>
                  Stop them, archive all
                </button>
              )}
              <button type="button" className="pn-btn on" onClick={() => answerTeamAsk('with')}>
                Archive them too
              </button>
            </>
          ) : (
            <>
              <button type="button" className="pn-btn" onClick={() => answerTeamAsk('keep')}>
                Keep them
              </button>
              <button type="button" className="pn-btn pn-btn--danger" onClick={() => answerTeamAsk('delete')}>
                Delete them too
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
