// Custom model endpoints: the machine-local records a harness runs
// through instead of its own provider (a self-hosted gateway, a
// relay on this network). The secret never leaves the daemon - the
// rows carry only metadata (`has_key`), and the key field stays empty
// unless the human is setting a new one.

import { useCallback, useEffect, useState } from 'react'
import { X } from '@phosphor-icons/react'
import { useConsole } from './state/console.jsx'
import { useBack } from './use-back.js'
import { harnessName } from './harness-names.js'
import './devices.css'
import './panels.css'

const AUTH_KINDS = [
  { id: 'bearer', name: 'Bearer token' },
  { id: 'api_key', name: 'API key' },
  { id: 'none', name: 'No key' },
]

const emptyForm = {
  id: null,
  name: '',
  baseUrl: '',
  modelsPath: '',
  defaultModel: '',
  authKind: 'bearer',
  key: '',
  enabled: true,
  isDefault: false,
}

function authLabel(kind) {
  return AUTH_KINDS.find((k) => k.id === kind)?.name ?? kind
}

export default function EndpointManager({ harness, deviceId = null, onChanged = null }) {
  const { api } = useConsole()
  const [endpoints, setEndpoints] = useState([])
  const [pending, setPending] = useState(true)
  const [form, setForm] = useState(emptyForm)
  const [editing, setEditing] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState(null)
  const [tested, setTested] = useState({}) // id -> { ok, count } | { ok: false, message }
  const [testing, setTesting] = useState(null)

  const load = useCallback(async () => {
    setPending(true)
    try {
      const list = (await api.device(deviceId).modelEndpoints({ harness })) ?? []
      setEndpoints(list)
    } catch {
      /* the poll heals */
    } finally {
      setPending(false)
    }
  }, [api, deviceId, harness])

  useEffect(() => {
    load()
  }, [load])

  const startAdd = () => {
    setForm(emptyForm)
    setEditing(true)
    setError(null)
  }

  const startEdit = (entry) => {
    setForm({
      id: entry.id,
      name: entry.name,
      baseUrl: entry.base_url,
      modelsPath: entry.models_path ?? '',
      defaultModel: entry.default_model ?? '',
      authKind: entry.auth_kind,
      key: '',
      enabled: entry.enabled,
      isDefault: entry.is_default,
    })
    setEditing(true)
    setError(null)
  }

  const save = async () => {
    setSaving(true)
    setError(null)
    try {
      await api.device(deviceId).saveEndpoint({
        ...(form.id ? { id: form.id } : {}),
        harness,
        name: form.name.trim(),
        baseUrl: form.baseUrl.trim(),
        ...(form.modelsPath.trim() ? { modelsPath: form.modelsPath.trim() } : {}),
        ...(form.defaultModel.trim() ? { defaultModel: form.defaultModel.trim() } : {}),
        authKind: form.authKind,
        ...(form.key ? { key: form.key } : {}),
        enabled: form.enabled,
        isDefault: form.isDefault,
      })
      setEditing(false)
      setForm(emptyForm)
      await load()
      onChanged?.()
    } catch (err) {
      setError(err.message ?? String(err))
    } finally {
      setSaving(false)
    }
  }

  const remove = async (id) => {
    setError(null)
    try {
      await api.device(deviceId).removeEndpoint(id)
      await load()
      onChanged?.()
    } catch (err) {
      setError(err.message ?? String(err))
    }
  }

  const setEnabled = async (id, enabled) => {
    try {
      await api.device(deviceId).setEndpointEnabled(id, enabled)
      await load()
      onChanged?.()
    } catch (err) {
      setError(err.message ?? String(err))
    }
  }

  const makeDefault = async (id) => {
    try {
      await api.device(deviceId).setDefaultEndpoint(harness, id)
      await load()
      onChanged?.()
    } catch (err) {
      setError(err.message ?? String(err))
    }
  }

  const clearDefault = async () => {
    try {
      await api.device(deviceId).setDefaultEndpoint(harness, null)
      await load()
      onChanged?.()
    } catch (err) {
      setError(err.message ?? String(err))
    }
  }

  const test = async (id) => {
    setTesting(id)
    try {
      const models = (await api.device(deviceId).endpointModels(id)) ?? []
      setTested((t) => ({ ...t, [id]: { ok: true, count: models.length } }))
    } catch (err) {
      setTested((t) => ({ ...t, [id]: { ok: false, message: err.message ?? String(err) } }))
    } finally {
      setTesting(null)
    }
  }

  const executable = harness === 'claude'

  return (
    <div>
      {!executable && (
        <p className="pn-note">
          {harnessName(harness)} endpoints can be stored, but chats can't run through them yet -
          only claude executes custom endpoints today.
        </p>
      )}
      {pending ? (
        <span className="nc-skeleton" aria-hidden="true" />
      ) : (
        <div className="pn-list pn-list--wide">
          {endpoints.length === 0 && !editing && (
            <p className="pn-empty">
              No custom endpoints yet - chats run through {harnessName(harness)}'s own provider.
            </p>
          )}
          {endpoints.map((entry) => (
            <div key={entry.id} className="pn-row pn-row--stack">
              <div className="pn-row-main">
                <div>
                  <div className="pn-name">
                    {entry.name}
                    {entry.is_default ? ' · default' : ''}
                    {entry.enabled ? '' : ' · off'}
                  </div>
                  <div className="pn-detail">
                    <span className="pv">{entry.base_url}</span> · {authLabel(entry.auth_kind)}
                    {entry.auth_kind !== 'none' && (entry.has_key ? ' · key saved' : ' · no key')}
                    {entry.default_model && ` · ${entry.default_model}`}
                  </div>
                  {tested[entry.id] && (
                    <div className="pn-detail">
                      {tested[entry.id].ok
                        ? `Lists ${tested[entry.id].count} model${tested[entry.id].count === 1 ? '' : 's'} today.`
                        : tested[entry.id].message}
                    </div>
                  )}
                </div>
                <div className="pn-actions">
                  <button type="button" className="pn-btn" onClick={() => test(entry.id)} disabled={testing === entry.id}>
                    {testing === entry.id ? 'Testing…' : 'Test'}
                  </button>
                  <button type="button" className="pn-btn" onClick={() => startEdit(entry)}>
                    Edit
                  </button>
                  {!entry.is_default && entry.enabled && (
                    <button type="button" className="pn-btn" onClick={() => makeDefault(entry.id)}>
                      Default
                    </button>
                  )}
                  <button type="button" className="pn-btn" onClick={() => setEnabled(entry.id, !entry.enabled)}>
                    {entry.enabled ? 'Turn off' : 'Turn on'}
                  </button>
                  <button type="button" className="pn-btn" onClick={() => remove(entry.id)}>
                    Remove
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
      {endpoints.some((e) => e.is_default) && !editing && (
        <p className="pn-note">
          New chats run through the default.{' '}
          <button type="button" className="pn-btn" onClick={clearDefault}>
            Clear default
          </button>
        </p>
      )}
      {!editing ? (
        <button type="button" className="pn-btn" onClick={startAdd}>
          Add endpoint
        </button>
      ) : (
        <div className="pn-list pn-list--tight">
          <label className="dv-host">
            Name
            <input
              value={form.name}
              onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
              placeholder="Office gateway"
              spellCheck={false}
              autoComplete="off"
            />
          </label>
          <label className="dv-host">
            Base URL
            <input
              value={form.baseUrl}
              onChange={(e) => setForm((f) => ({ ...f, baseUrl: e.target.value }))}
              placeholder="http://localhost:4000/v1"
              spellCheck={false}
              autoComplete="off"
            />
          </label>
          <label className="dv-host">
            Model-list path override (optional)
            <input
              value={form.modelsPath}
              onChange={(e) => setForm((f) => ({ ...f, modelsPath: e.target.value }))}
              placeholder="v1/models"
              spellCheck={false}
              autoComplete="off"
            />
          </label>
          <label className="dv-host">
            Default model (optional - the chat's pick when none is named)
            <input
              value={form.defaultModel}
              onChange={(e) => setForm((f) => ({ ...f, defaultModel: e.target.value }))}
              placeholder="my-model-id"
              spellCheck={false}
              autoComplete="off"
            />
          </label>
          <label className="dv-host">
            Credential
            <select value={form.authKind} onChange={(e) => setForm((f) => ({ ...f, authKind: e.target.value }))}>
              {AUTH_KINDS.map((k) => (
                <option key={k.id} value={k.id}>
                  {k.name}
                </option>
              ))}
            </select>
          </label>
          {form.authKind !== 'none' && (
            <label className="dv-host">
              Key{form.id ? ' (leave empty to keep the saved one)' : ''}
              <input
                type="password"
                value={form.key}
                onChange={(e) => setForm((f) => ({ ...f, key: e.target.value }))}
                placeholder={form.id ? 'Unchanged' : 'Endpoint key'}
                spellCheck={false}
                autoComplete="new-password"
              />
            </label>
          )}
          <label className="dv-check">
            <input
              type="checkbox"
              checked={form.enabled}
              onChange={(e) => setForm((f) => ({ ...f, enabled: e.target.checked }))}
            />
            Turned on
          </label>
          <label className="dv-check">
            <input
              type="checkbox"
              checked={form.isDefault}
              onChange={(e) => setForm((f) => ({ ...f, isDefault: e.target.checked }))}
            />
            The {harnessName(harness)} default - new chats run through it
          </label>
          {error && <p className="pn-note">{error}</p>}
          <div className="pn-row">
            <div className="pn-actions">
              <button
                type="button"
                className="pn-btn on"
                onClick={save}
                disabled={saving || !form.name.trim() || !form.baseUrl.trim()}
              >
                {saving ? 'Saving…' : form.id ? 'Save endpoint' : 'Add endpoint'}
              </button>
              <button
                type="button"
                className="pn-btn"
                onClick={() => {
                  setEditing(false)
                  setForm(emptyForm)
                  setError(null)
                }}
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}
      {error && !editing && <p className="pn-note">{error}</p>}
    </div>
  )
}

// The picker footer and Settings open the same manager in a modal: the
// harness's rows, live from the machine that would run the chats.
export function EndpointManagerModal({ harness, deviceId = null, where = null, onClose, onChanged = null }) {
  useBack(true, onClose)
  return (
    <div
      className="dv-modal-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div className="dv-modal dv-modal--form" role="dialog" aria-modal="true" aria-label={`Models for ${harnessName(harness)}`}>
        <div className="dv-modal-head">
          <h2 className="dv-modal-title">
            Models for {harnessName(harness)}
            {where ? <span className="pv"> · {where}</span> : ''}
          </h2>
          <button className="dv-modal-close" onClick={onClose} title="Close">
            <X size={14} weight="bold" />
          </button>
        </div>
        <p className="dv-modal-hint">
          A custom endpoint is a model server on this machine or network that speaks an
          OpenAI-compatible models API. New chats run through the default; a chat's own
          endpoint is its own choice.
        </p>
        <EndpointManager harness={harness} deviceId={deviceId} onChanged={onChanged} />
      </div>
    </div>
  )
}
