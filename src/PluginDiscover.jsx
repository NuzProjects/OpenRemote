// Plugins > Discover: every plugin the marketplaces that are on offer,
// read from their cached catalogs. Opening it fetches any catalog over a
// day old - nothing refreshes in the background. A card shows what a
// plugin asks for when that can be known before install; the review in
// the Install dialog always reads the plugin itself.

import { useEffect, useMemo, useState } from 'react'
import { useConsole } from './state/console.jsx'
import { openExternal } from './platform.js'
import {
  CLAUDE_PART_LABEL,
  POWER_LABEL,
  POWER_SHORT,
  RUNTIME_LABEL,
  categories,
  entryState,
  filterEntries,
  isStale,
} from './plugins.js'

const STATE_LABEL = {
  installed: 'Installed',
  update: 'Update',
  unavailable: "Can't install",
}

export default function PluginDiscover({ onInstall }) {
  const { catalog, marketplaces, refreshMarketplace } = useConsole()
  const [query, setQuery] = useState('')
  const [category, setCategory] = useState('')
  const [market, setMarket] = useState('')
  const [selected, setSelected] = useState(null)
  const [fetching, setFetching] = useState([])

  // Opening Discover fetches each catalog that is on and over a day old.
  useEffect(() => {
    const stale = (marketplaces ?? []).filter((m) => isStale(m))
    if (!stale.length) return
    setFetching(stale.map((m) => m.name))
    for (const m of stale) {
      refreshMarketplace(m.name)
        .catch(() => {})
        .finally(() => setFetching((names) => names.filter((n) => n !== m.name)))
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const all = catalog?.entries ?? []
  const shown = useMemo(
    () => filterEntries(all, { query, category, marketplace: market }),
    [all, query, category, market],
  )
  const on = (marketplaces ?? []).filter((m) => m.enabled)
  const failed = on.filter((m) => m.error)
  const current = all.find((e) => e.id === selected) ?? null

  if (!on.length) {
    return <p className="pn-empty">Every marketplace is off. Turn one on under Marketplaces.</p>
  }

  return (
    <>
      <div className="pg-filters">
        <label className="pn-search pg-search">
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search plugins"
            spellCheck={false}
            autoComplete="off"
            aria-label="Search plugins"
          />
        </label>
        <select className="pg-select" value={category} onChange={(e) => setCategory(e.target.value)} aria-label="Category">
          <option value="">Every category</option>
          {categories(all).map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
        <select className="pg-select" value={market} onChange={(e) => setMarket(e.target.value)} aria-label="Marketplace">
          <option value="">Every marketplace</option>
          {on.map((m) => (
            <option key={m.name} value={m.name}>
              {m.name}
            </option>
          ))}
        </select>
      </div>
      <p className="pg-count">
        {fetching.length
          ? `Fetching ${fetching.join(' and ')}…`
          : `${shown.length} of ${all.length} plugins`}
      </p>
      {failed.map((m) => (
        <p key={m.name} className="pg-sub pg-failed">
          Couldn&apos;t fetch {m.name}: {m.error}
        </p>
      ))}

      <div className="pg-discover">
        <div className="pg-cards">
          {shown.length === 0 && !fetching.length && (
            <p className="pn-empty">{all.length ? 'No plugin matches.' : 'No catalog has been fetched yet.'}</p>
          )}
          {shown.map((e) => {
            const state = entryState(e)
            return (
              <button
                key={e.id}
                type="button"
                className={e.id === selected ? 'pg-card on' : 'pg-card'}
                onClick={() => setSelected(e.id)}
              >
                <span className="pg-card-head">
                  <span className="pg-card-name">{e.display_name ?? e.name}</span>
                  {STATE_LABEL[state] && <span className={`pg-state pg-state--${state}`}>{STATE_LABEL[state]}</span>}
                </span>
                {e.description && <span className="pg-card-desc">{e.description}</span>}
                <span className="pg-card-meta">
                  {[e.author, e.marketplace, e.category].filter(Boolean).join(' · ')}
                </span>
              </button>
            )
          })}
        </div>
        <aside className="pg-details" aria-live="polite">
          {current ? (
            <EntryDetails entry={current} onInstall={onInstall} />
          ) : (
            <p className="pn-empty">Pick a plugin to see what it is and what it asks for.</p>
          )}
        </aside>
      </div>
    </>
  )
}

function EntryDetails({ entry, onInstall }) {
  const state = entryState(entry)
  return (
    <>
      <h2 className="pg-details-name">{entry.display_name ?? entry.name}</h2>
      <div className="pg-details-id pv">{entry.id}</div>
      {entry.description && <p className="pg-details-desc">{entry.description}</p>}
      <div className="pg-review">
        {entry.version && (
          <div className="pg-review-row">
            <span className="pg-review-label">Version</span>
            <span>{entry.version}</span>
          </div>
        )}
        {entry.author && (
          <div className="pg-review-row">
            <span className="pg-review-label">By</span>
            <span>{entry.author}</span>
          </div>
        )}
        <div className="pg-review-row">
          <span className="pg-review-label">From</span>
          <span className="pg-wrap pv">{entry.from || entry.source_kind}</span>
        </div>
        {entry.runtime && (
          <div className="pg-review-row">
            <span className="pg-review-label">Runs as</span>
            <span>{RUNTIME_LABEL[entry.runtime] ?? entry.runtime}</span>
          </div>
        )}
        {entry.claude_parts?.length > 0 && (
          <div className="pg-review-row">
            <span className="pg-review-label">Carries</span>
            <span>{entry.claude_parts.map((p) => CLAUDE_PART_LABEL[p] ?? p).join(', ')}</span>
          </div>
        )}
        <div className="pg-review-row">
          <span className="pg-review-label">It may</span>
          {entry.powers == null ? (
            <span className="pg-muted">Shown when you review it</span>
          ) : entry.powers.length ? (
            <ul className="pg-powers">
              {entry.powers.map((w) => (
                <li key={w}>{POWER_LABEL[w] ?? w}</li>
              ))}
            </ul>
          ) : (
            <span>Nothing beyond itself</span>
          )}
        </div>
      </div>
      {entry.not_sandboxed && (
        <div className="pg-facts">
          <span className="pg-chip pg-warn">Runs as you, not sandboxed</span>
          {(entry.powers ?? [])
            .filter((w) => w !== 'run_programs')
            .map((w) => (
              <span key={w} className="pg-chip">
                {POWER_SHORT[w] ?? w}
              </span>
            ))}
        </div>
      )}
      {entry.why_not && <p className="pg-sub">OpenRemote can&apos;t install it: {entry.why_not}.</p>}
      <div className="pg-details-actions">
        {entry.homepage && (
          <button type="button" className="pn-btn" onClick={() => openExternal(entry.homepage).catch(() => {})}>
            Homepage
          </button>
        )}
        {state === 'available' && (
          <button type="button" className="dv-act" onClick={() => onInstall(entry)}>
            Install
          </button>
        )}
        {state === 'update' && (
          <button type="button" className="dv-act" onClick={() => onInstall(entry)}>
            Update{entry.version ? ` to ${entry.version}` : ''}
          </button>
        )}
        {state === 'installed' && (
          <button type="button" className="pn-btn" disabled>
            Installed
          </button>
        )}
      </div>
    </>
  )
}
