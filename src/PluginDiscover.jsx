// Plugins > Discover: every plugin the marketplaces offer,
// read from their cached catalogs. Opening it fetches any catalog over a
// day old - nothing refreshes in the background.

import { useEffect, useMemo, useState } from 'react'
import {
  ArrowClockwise,
  CaretDown,
  CaretUp,
  MagnifyingGlass,
  Warning,
  X,
} from '@phosphor-icons/react'
import { useConsole } from './state/console.jsx'
import PickerMenu from './PickerMenu.jsx'
import PluginCard from './PluginCard.jsx'
import PluginDetailModal from './PluginDetailModal.jsx'
import {
  groupEntriesByCategory,
  isStale,
  searchEntries,
} from './plugins.js'

export default function PluginDiscover({ onInstall }) {
  const { catalog, marketplaces, refreshMarketplace } = useConsole()
  const [query, setQuery] = useState('')
  const [category, setCategory] = useState('')
  const [market, setMarket] = useState('')
  const [inspectedEntry, setInspectedEntry] = useState(null)
  const [expandedCategories, setExpandedCategories] = useState(() => new Set())
  const [dismissedErrors, setDismissedErrors] = useState(() => new Set())
  const [fetching, setFetching] = useState([])
  const [picker, setPicker] = useState(null)

  const openPicker = (kind) => (e) => setPicker({ kind, x: e.clientX, y: e.clientY })

  const refreshOne = async (name) => {
    setFetching((curr) => (curr.includes(name) ? curr : [...curr, name]))
    try {
      await refreshMarketplace(name)
    } catch {
      // Errors surface on the marketplace record
    } finally {
      setFetching((curr) => curr.filter((n) => n !== name))
    }
  }

  // Opening Discover fetches each catalog that is on and over a day old.
  useEffect(() => {
    const stale = (marketplaces ?? []).filter((m) => isStale(m))
    if (!stale.length) return
    for (const m of stale) {
      refreshOne(m.name)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const all = catalog?.entries ?? []
  const on = (marketplaces ?? []).filter((m) => m.enabled)
  const failed = on.filter((m) => m.error && !dismissedErrors.has(m.name))

  const handleRefresh = () => {
    if (fetching.length > 0) return
    const stale = on.filter((m) => isStale(m))
    const targets = stale.length > 0 ? stale : on
    for (const m of targets) {
      refreshOne(m.name)
    }
  }

  const handleRetry = (name) => {
    setDismissedErrors((prev) => {
      const next = new Set(prev)
      next.delete(name)
      return next
    })
    refreshOne(name)
  }

  const handleDismiss = (name) => {
    setDismissedErrors((prev) => new Set([...prev, name]))
  }

  const toggleCategory = (catKey) => {
    setExpandedCategories((prev) => {
      const next = new Set(prev)
      if (next.has(catKey)) {
        next.delete(catKey)
      } else {
        next.add(catKey)
      }
      return next
    })
  }

  const isFiltering = Boolean(query.trim() || category || market)

  const shown = useMemo(() => {
    if (!isFiltering) return []
    return searchEntries(all, { query, category, marketplace: market })
  }, [isFiltering, all, query, category, market])

  const allGroups = useMemo(() => groupEntriesByCategory(all), [all])

  const categoryOptions = useMemo(
    () => allGroups.map((g) => ({ value: g.category, label: g.label })),
    [allGroups],
  )

  const groups = isFiltering ? [] : allGroups

  if (!on.length) {
    return (
      <div className="pg-discover-view">
        <p className="pn-empty">Every marketplace is off. Turn one on under Marketplaces.</p>
      </div>
    )
  }

  return (
    <div className="pg-discover-view">
      <div className="pg-toolbar">
        <div className="pg-search-box">
          <MagnifyingGlass size={15} className="pg-search-icon" />
          <input
            type="text"
            className="pg-search-input"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search plugins"
            spellCheck={false}
            autoComplete="off"
            aria-label="Search plugins"
          />
          {query && (
            <button
              type="button"
              className="pg-search-clear"
              onClick={() => setQuery('')}
              aria-label="Clear search"
              title="Clear search"
            >
              <X size={13} weight="bold" />
            </button>
          )}
        </div>

        {/* Two filters, the console's own dropdown engine: an OS-drawn list
            could not be searched, keyboard-navigated or themed. */}
        <button
          type="button"
          className="pg-select"
          onClick={openPicker('category')}
          aria-label="Category"
          aria-haspopup="listbox"
          aria-expanded={picker?.kind === 'category'}
        >
          {categoryOptions.find((opt) => opt.value === category)?.label ?? 'All categories'}
          <CaretDown size={11} />
        </button>
        {picker?.kind === 'category' && (
          <PickerMenu
            label="Category"
            searchPlaceholder="Search categories"
            items={[
              { id: '', name: 'All categories' },
              ...categoryOptions.map((opt) => ({ id: opt.value, name: opt.label })),
            ]}
            groups={null}
            selectedId={category}
            onChoose={(id) => {
              setCategory(id)
              setPicker(null)
            }}
            onClose={() => setPicker(null)}
            anchor={{ left: picker.x, top: picker.y }}
          />
        )}

        <button
          type="button"
          className="pg-select"
          onClick={openPicker('market')}
          aria-label="Marketplace"
          aria-haspopup="listbox"
          aria-expanded={picker?.kind === 'market'}
        >
          {market || 'All marketplaces'}
          <CaretDown size={11} />
        </button>
        {picker?.kind === 'market' && (
          <PickerMenu
            label="Marketplace"
            searchPlaceholder="Search marketplaces"
            items={[
              { id: '', name: 'All marketplaces' },
              ...on.map((m) => ({ id: m.name, name: m.name })),
            ]}
            groups={null}
            selectedId={market}
            onChoose={(id) => {
              setMarket(id)
              setPicker(null)
            }}
            onClose={() => setPicker(null)}
            anchor={{ left: picker.x, top: picker.y }}
          />
        )}

        <button
          type="button"
          className="pn-btn pg-refresh-btn"
          onClick={handleRefresh}
          disabled={fetching.length > 0}
          title={fetching.length > 0 ? `Fetching ${fetching.join(', ')}...` : 'Refresh catalogs'}
          aria-label="Refresh catalogs"
        >
          <ArrowClockwise
            size={15}
            weight="bold"
            className={fetching.length > 0 ? 'pg-spin' : ''}
          />
        </button>
      </div>

      {failed.length > 0 && (
        <div className="pg-errors">
          {failed.map((m) => (
            <div key={m.name} className="pg-error-card" role="alert">
              <div className="pg-error-card-main">
                <Warning size={16} weight="bold" className="pg-error-icon" />
                <div className="pg-error-content">
                  <h4 className="pg-error-title">Couldn&apos;t refresh {m.name}</h4>
                  <p className="pg-error-msg">{m.error}</p>
                </div>
              </div>
              <div className="pg-error-actions">
                <button
                  type="button"
                  className="pn-btn pg-error-btn"
                  onClick={() => handleRetry(m.name)}
                >
                  Retry
                </button>
                <button
                  type="button"
                  className="pn-btn pg-error-btn"
                  onClick={() => handleDismiss(m.name)}
                >
                  Dismiss
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {isFiltering ? (
        <div className="pg-catalog-filtered">
          <p className="pg-count-banner">
            Showing {shown.length} of {all.length} plugins
          </p>
          {shown.length === 0 ? (
            <p className="pn-empty">No plugins match your search.</p>
          ) : (
            <div className="pg-grid-2col">
              {shown.map((e) => (
                <PluginCard
                  key={e.id ?? `${e.marketplace ?? ''}:${e.name}`}
                  entry={e}
                  onInstall={onInstall}
                  onInspect={setInspectedEntry}
                />
              ))}
            </div>
          )}
        </div>
      ) : (
        <div className="pg-sections">
          {all.length === 0 && !fetching.length && (
            <p className="pn-empty">
              No catalog has been fetched yet. A marketplace's catalog is read once and kept on this
              computer; use the refresh button above once one is on.
            </p>
          )}
          {all.length === 0 && fetching.length > 0 && (
            <p className="pn-empty">Reading the marketplaces' catalogs...</p>
          )}
          {groups.map((group) => {
            const isExpanded = expandedCategories.has(group.category)
            const sliced = isExpanded ? group.entries : group.entries.slice(0, 6)
            const hasMore = group.entries.length > 6
            const remaining = group.entries.length - 6

            return (
              <section key={group.category} className="pg-section">
                <div className="pg-section-head">
                  <h3 className="pg-section-title">{group.label}</h3>
                  <span className="pg-section-count">{group.entries.length}</span>
                </div>
                <div className="pg-grid-2col">
                  {sliced.map((e) => (
                    <PluginCard
                      key={e.id ?? `${e.marketplace ?? ''}:${e.name}`}
                      entry={e}
                      onInstall={onInstall}
                      onInspect={setInspectedEntry}
                    />
                  ))}
                </div>
                {hasMore && (
                  <button
                    type="button"
                    className="pg-expand-btn"
                    onClick={() => toggleCategory(group.category)}
                  >
                    {isExpanded ? (
                      <>
                        <span>Show less</span>
                        <CaretUp size={13} weight="bold" />
                      </>
                    ) : (
                      <>
                        <span>Show {remaining} more</span>
                        <CaretDown size={13} weight="bold" />
                      </>
                    )}
                  </button>
                )}
              </section>
            )
          })}
        </div>
      )}

      {inspectedEntry && (
        <PluginDetailModal
          entry={inspectedEntry}
          onClose={() => setInspectedEntry(null)}
          onInstall={onInstall}
        />
      )}
    </div>
  )
}
