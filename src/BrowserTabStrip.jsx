// The browser's tab strip: Chrome's tabs, each with its page's icon (a
// breathing ring while it loads), its title, the chat using it when an
// agent is, and a close button; a new-tab button; and the list of every
// tab at the right. Middle-click closes; right-click has the tab's menu.

import { CaretDown, ClockCounterClockwise, Detective, DownloadSimple, Globe, Plus, Star, X } from '@phosphor-icons/react'
import { internalPage } from './browser-omnibox.js'
import { tabTitle } from './browser-tabs.js'
import { usePrivacyMode } from './privacy.js'
import { DeviceIcon } from './BrowserLiveView.jsx'

const PAGE_ICONS = { history: ClockCounterClockwise, downloads: DownloadSimple, bookmarks: Star }

// A tab's icon: the ring while its page loads, the browser's own page's
// icon, the private mark, the site's icon, or a globe.
export function TabIcon({ tab, size = 14 }) {
  if (tab.remote) return <DeviceIcon platform={tab.remote.platform} size={size} className="bw-tab-icon" />
  if (tab.loading && tab.native) return <span className="bw-spinner" aria-label="Loading" />
  const Page = PAGE_ICONS[internalPage(tab.url)]
  if (Page) return <Page size={size} className="bw-tab-icon" />
  if (tab.private) return <Detective size={size} className="bw-tab-icon" aria-label="Private" />
  if (tab.favicon) return <img className="bw-favicon" src={tab.favicon} alt="" />
  return <Globe size={size} className="bw-tab-icon" />
}

// Which chat's agent holds the tab: its title on a small badge that
// breathes while the agent acts, still once the user took over.
export function AgentBadge({ controller }) {
  const privacy = usePrivacyMode()
  const name = controller.title || 'A chat'
  const live = controller.kind === 'agent'
  const said = live ? `${name} is using this tab` : `You took over from ${name}`
  return (
    <span className={`bw-agent${live ? ' live' : ''}`} title={privacy ? (live ? 'An agent is using this tab' : 'You took over from an agent') : said}>
      <span className="bw-agent-dot" />
      <span className="bw-agent-name pv">{name}</span>
    </span>
  )
}

export default function BrowserTabStrip({ tabs, active, act, hint, precapture }) {
  return (
    <div className="bw-tabs" role="tablist" aria-label="Tabs" onPointerEnter={precapture}>
      <div className="bw-tabs-scroll">
        {tabs.map((t) => (
          <div
            key={t.key}
            role="tab"
            aria-selected={t.key === active}
            className={`bw-tab${t.key === active ? ' on' : ''}${t.private ? ' private' : ''}`}
            onMouseDown={(e) => {
              if (e.button === 1) {
                e.preventDefault()
                act.close(t.key)
              } else if (e.button === 0) act.select(t.key)
            }}
            onContextMenu={(e) => {
              e.preventDefault()
              e.stopPropagation()
              act.tabMenu(t, e.clientX, e.clientY)
            }}
            title={tabTitle(t)}
          >
            <TabIcon tab={t} />
            <span className="bw-tab-title">{tabTitle(t)}</span>
            {t.controller && <AgentBadge controller={t.controller} />}
            <button
              type="button"
              className="bw-tab-close"
              title={hint('Close tab', 'browser-close-tab')}
              onMouseDown={(e) => e.stopPropagation()}
              onClick={() => act.close(t.key)}
            >
              <X size={11} weight="bold" />
            </button>
          </div>
        ))}
        <button type="button" className="bw-newtab" title={hint('New tab', 'browser-new-tab')} onClick={() => act.openTab()}>
          <Plus size={14} />
        </button>
      </div>
      <button
        type="button"
        className="bw-btn bw-tabsearch"
        title="Your tabs"
        onClick={(e) => act.menu('tabs', e.currentTarget)}
      >
        <CaretDown size={14} />
      </button>
    </div>
  )
}
