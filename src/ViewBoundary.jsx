// A view that throws while drawing itself must not take the window with
// it. This boundary wraps one pane's view (see renderPane in App.jsx): the
// sidebar, the titlebar and every other pane keep working, and the failed
// view answers with a panel that says what happened and offers two ways
// out. It is a class because a render error can only be caught that way in
// React; everything it decides lives in view-boundary.js, where it is
// tested.
//
// It sits in the pane, not around the whole app, on purpose: a boundary
// around App would replace the entire window (sidebar included) with one
// panel, and the point is that only the view that failed goes away.

import { Component } from 'react'
import { failureNotice } from './view-boundary.js'
import './view-boundary.css'

// The least the app can say if the panel itself cannot be drawn. No detail
// and no actions: this line is the end of the recovery path, and the rest
// of the window still works around it.
const FALLBACK_LINE = 'This view could not be drawn, and the note about it could not be shown.'

// A second boundary under the first: a panel that throws while rendering
// its own rows must not throw again, so its failure lands here as one
// centred line instead of a blank window.
class PanelGuard extends Component {
  state = { failed: false }

  static getDerivedStateFromError() {
    return { failed: true }
  }

  componentDidCatch(error) {
    console.error('[openremote] the view recovery panel could not be drawn:', error)
  }

  render() {
    if (!this.state.failed) return this.props.children
    return (
      <div className="vb vb--quiet" role="alert">
        <p className="vb-min">{FALLBACK_LINE}</p>
      </div>
    )
  }
}

// The panel. Calm on purpose: a title, what kind of failure it was, the
// error's own words and first frame, then the two things the reader can
// do. No animation, no shadow, no new colour - it is drawn from the same
// hairline and text tiers as every other quiet row in the app.
function ViewCrash({ notice, onRetry, onNewChat }) {
  return (
    <div className="vb" role="alert">
      <div className="vb-panel">
        <h2 className="vb-title">This view could not be drawn.</h2>
        <p className="vb-cause">{notice.cause}</p>
        <p className="vb-support">
          The rest of the window still works, and nothing on this computer has changed.
        </p>
        <div className="vb-detail">
          <div className="vb-detail-msg">{notice.detail.message}</div>
          {notice.detail.frame && (
            <div className="vb-detail-frame" title={notice.detail.frame}>
              {notice.detail.frame}
            </div>
          )}
        </div>
        {!notice.retry && (
          <p className="vb-support">
            Trying again would land in the same place, so going back is the way out.
          </p>
        )}
        <div className="vb-actions">
          {notice.retry && (
            <button type="button" className="vb-btn vb-btn--primary" onClick={onRetry}>
              Try again
            </button>
          )}
          <button type="button" className="vb-btn" onClick={onNewChat}>
            Go back to New chat
          </button>
        </div>
      </div>
    </div>
  )
}

export default class ViewBoundary extends Component {
  state = { error: null, componentStack: '', attempts: 0 }

  static getDerivedStateFromError(error) {
    return { error }
  }

  // React calls this once for each error it catches, which is the one log
  // line the console keeps per failure. The component stack is what names
  // where it happened, so it goes in the log and in the panel.
  componentDidCatch(error, info) {
    console.error('[openremote] a view could not be drawn:', error, info?.componentStack ?? '')
    this.setState({ componentStack: info?.componentStack ?? '' })
  }

  // One more try at the same view, from the same state. The pure module
  // decides whether offering it was honest; this only counts the tries.
  retry = () => {
    this.setState((state) => ({
      error: null,
      componentStack: '',
      attempts: state.attempts + 1,
    }))
  }

  // The safe view, and the failure let go with it: the route moves to New
  // chat, and this boundary forgets the error so it cannot paint the panel
  // over the view that replaced it.
  newChat = () => {
    this.setState({ error: null, componentStack: '', attempts: 0 })
    this.props.onNewChat?.()
  }

  render() {
    const { error, componentStack, attempts } = this.state
    if (!error) return this.props.children
    const notice = failureNotice({ error, componentStack, attempts })
    if (!notice) return this.props.children
    return (
      <PanelGuard>
        <ViewCrash notice={notice} onRetry={this.retry} onNewChat={this.newChat} />
      </PanelGuard>
    )
  }
}
