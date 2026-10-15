// Plugins: the plugin system's page (built next). The hand-written MCP
// servers that used to live here are in Settings > MCP servers.

import './devices.css'
import './panels.css'

export default function PluginsView() {
  return (
    <div className="panel">
      <header className="dv-head pn-head">
        <div>
          <h1 className="dv-title">Plugins</h1>
          <p className="dv-meta">MCP servers you set up by hand are now in Settings, under MCP servers.</p>
        </div>
      </header>
    </div>
  )
}
