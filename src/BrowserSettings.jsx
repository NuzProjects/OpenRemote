// Settings > Browser: the search engine, what the browser opens with, the
// bookmarks bar, the sites' remembered permissions and clearing browsing
// data. Small on purpose: it sits in the app's main bundle, while the
// browser itself loads on first use. The values live in the daemon
// (browser-data.js), shared with the open browser.

import { useEffect, useState } from 'react'
import PickerMenu from './PickerMenu.jsx'
import BrowserClearData from './BrowserClearData.jsx'
import { useConsole } from './state/console.jsx'
import { SEARCH_ENGINES, engineName } from './browser-omnibox.js'
import { hostOf, permissionName, permissionRows } from './browser-chrome.js'
import { browserSetting, loadBrowserData, setBrowserSetting, setSitePermission, useBrowserData } from './browser-data.js'
import './panels.css'
import './browser-settings.css'

const STARTUP = [
  { id: 'continue', name: 'Continue where you left off' },
  { id: 'new_tab', name: 'Open the new tab page' },
]

export default function BrowserSettings() {
  const { api, connection } = useConsole()
  const data = useBrowserData()
  const [picker, setPicker] = useState(null)
  const [clearing, setClearing] = useState(false)
  const [cleared, setCleared] = useState(false)

  useEffect(() => {
    if (api?.ready) loadBrowserData(api)
  }, [api, connection.state])

  const engine = browserSetting(data.settings, 'search')
  const startup = browserSetting(data.settings, 'startup')
  const bar = browserSetting(data.settings, 'bookmarks_bar')
  const sites = permissionRows(data.permissions)
  const openPicker = (kind) => (e) => setPicker({ kind, x: e.clientX, y: e.clientY })
  const choose = (key) => (id) => {
    setBrowserSetting(api, key, id)
    setPicker(null)
  }

  return (
    <>
      <p className="pn-lead">The built-in browser on this computer. Agents use it with you; these are yours.</p>
      <div className="pn-list pn-list--tight">
        <div className="pn-row">
          <div>
            <div className="pn-name">Search engine</div>
            <div className="pn-detail">What the address bar searches when you type words, not an address.</div>
          </div>
          <button
            type="button"
            className="pn-btn"
            onClick={openPicker('search')}
            aria-haspopup="listbox"
            aria-expanded={picker?.kind === 'search'}
          >
            {engineName(engine)}
          </button>
          {picker?.kind === 'search' && (
            <PickerMenu
              label="Search engine"
              searchPlaceholder="Search engines"
              items={Object.entries(SEARCH_ENGINES).map(([id, e]) => ({ id, name: e.name }))}
              groups={null}
              selectedId={engine}
              onChoose={choose('search')}
              onClose={() => setPicker(null)}
              anchor={{ left: picker.x, top: picker.y }}
            />
          )}
        </div>
        <div className="pn-row">
          <div>
            <div className="pn-name">On startup</div>
            <div className="pn-detail">
              Your tabs from last time come back as you left them (private tabs never do), or the browser starts on a
              new tab.
            </div>
          </div>
          <button
            type="button"
            className="pn-btn"
            onClick={openPicker('startup')}
            aria-haspopup="listbox"
            aria-expanded={picker?.kind === 'startup'}
          >
            {STARTUP.find((s) => s.id === startup)?.name ?? STARTUP[0].name}
          </button>
          {picker?.kind === 'startup' && (
            <PickerMenu
              label="On startup"
              searchPlaceholder="Search"
              items={STARTUP}
              groups={null}
              selectedId={startup}
              onChoose={choose('startup')}
              onClose={() => setPicker(null)}
              anchor={{ left: picker.x, top: picker.y }}
            />
          )}
        </div>
        <div className="pn-row">
          <div>
            <div className="pn-name">Show bookmarks bar</div>
            <div className="pn-detail">On every page. Off, it shows on new tabs only.</div>
          </div>
          <button
            type="button"
            className={bar ? 'pn-btn on' : 'pn-btn'}
            onClick={() => setBrowserSetting(api, 'bookmarks_bar', !bar)}
          >
            {bar ? 'On' : 'Off'}
          </button>
        </div>
        <div className="pn-row pn-row--stack">
          <div>
            <div className="pn-name">Site permissions</div>
            <div className="pn-detail">
              {sites.length
                ? 'What you told sites they may or may not use. Reset and the site asks again.'
                : 'Sites ask before using your camera, microphone, location and the like. Answers you remember show here.'}
            </div>
          </div>
          {sites.length > 0 && (
            <div className="bws-sites">
              {sites.map((p) => (
                <div key={`${p.origin}|${p.kind}`} className="bws-site">
                  <span className="bws-site-host pv">{hostOf(p.origin) || p.origin}</span>
                  <span className="bws-site-kind">
                    {permissionName(p.kind)}: {p.state === 'allow' ? 'allowed' : 'blocked'}
                  </span>
                  <button
                    type="button"
                    className="pn-btn"
                    onClick={() => setSitePermission(api, p.origin, p.kind, null)}
                  >
                    Reset
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
        <div className="pn-row">
          <div>
            <div className="pn-name">Clear browsing data</div>
            <div className="pn-detail">
              {cleared ? 'Cleared.' : 'History, cookies and site data, and cached files.'}
            </div>
          </div>
          <button type="button" className="pn-btn" onClick={() => setClearing(true)}>
            Clear…
          </button>
        </div>
      </div>
      {clearing && (
        <BrowserClearData api={api} onClose={() => setClearing(false)} onCleared={() => setCleared(true)} />
      )}
    </>
  )
}
