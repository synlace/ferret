"use client"

import { apiFetch } from "@/lib/api-fetch"

import React, { useState, useEffect, useCallback, useRef } from "react"
import { Key, Plus, Trash2, X, RefreshCw } from "lucide-react"
import { ApiKey, SpendData, API_BASE, fetchKeys, fetchSpend } from "./types"

// ---------------------------------------------------------------------------
// Create Key Modal
// ---------------------------------------------------------------------------

function CreateKeyModal({
  onClose,
  onCreate,
}: {
  onClose: () => void
  onCreate: (name: string, limitUsd: number | null) => Promise<{ key_value: string } | { error: string } | null>
}) {
  const [name, setName] = useState("")
  const [limitStr, setLimitStr] = useState("")
  const [loading, setLoading] = useState(false)
  const [createdKey, setCreatedKey] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const [errorMsg, setErrorMsg] = useState<string | null>(null)
  const modalRef = useRef<HTMLDivElement>(null)

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!name.trim()) return
    setLoading(true)
    setErrorMsg(null)
    const limitUsd = limitStr.trim() ? parseFloat(limitStr) : null
    const result = await onCreate(name.trim(), limitUsd)
    setLoading(false)
    if (result && "key_value" in result) {
      setCreatedKey(result.key_value)
    } else if (result && "error" in result) {
      setErrorMsg(result.error)
    } else {
      setErrorMsg("An unexpected error occurred. Please try again.")
    }
  }

  const handleCopy = () => {
    if (createdKey) {
      navigator.clipboard.writeText(createdKey)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    }
  }

  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === "Escape" && !createdKey) onClose() }
    document.addEventListener("keydown", handler)
    return () => document.removeEventListener("keydown", handler)
  }, [onClose, createdKey])

  useEffect(() => {
    if (createdKey) return
    const handler = (e: MouseEvent) => {
      if (modalRef.current && !modalRef.current.contains(e.target as Node)) onClose()
    }
    document.addEventListener("mousedown", handler)
    return () => document.removeEventListener("mousedown", handler)
  }, [onClose, createdKey])

  return (
    <div className="fixed inset-0 bg-black/70 z-[70] flex items-center justify-center">
      <div ref={modalRef} className="bg-neutral-900 border border-neutral-700 rounded-lg w-full max-w-sm shadow-2xl">
        <div className="flex items-center justify-between px-4 py-3 border-b border-neutral-800">
          <h2 className="text-sm font-semibold text-white flex items-center gap-2">
            <Key className="w-3.5 h-3.5 text-brand-400" />
            {createdKey ? "Key Created" : "New API Key"}
          </h2>
          {!createdKey && (
            <button onClick={onClose} className="text-neutral-500 hover:text-white transition-colors">
              <X className="w-4 h-4" />
            </button>
          )}
        </div>

        {createdKey ? (
          <div className="p-4 space-y-4">
            <div className="bg-amber-500/10 border border-amber-500/30 rounded p-3">
              <p className="text-amber-400 text-xs font-medium mb-2">⚠ Save this key now — it will not be shown again.</p>
              <div className="flex items-center gap-2">
                <code className="flex-1 text-xs text-green-400 bg-neutral-800 rounded px-2 py-1.5 break-all font-mono">{createdKey}</code>
                <button
                  onClick={handleCopy}
                  className="shrink-0 px-2 py-1.5 text-xs bg-neutral-700 hover:bg-neutral-600 text-white rounded transition-colors"
                >
                  {copied ? "Copied!" : "Copy"}
                </button>
              </div>
            </div>
            <button
              onClick={onClose}
              className="w-full py-2 text-xs font-semibold bg-brand-500 hover:bg-brand-600 text-neutral-900 rounded transition-colors"
            >
              Done
            </button>
          </div>
        ) : (
          <form onSubmit={handleSubmit} className="p-4 space-y-3">
            {errorMsg && (
              <div className="bg-red-500/10 border border-red-500/30 rounded p-3">
                <p className="text-red-400 text-xs">{errorMsg}</p>
              </div>
            )}
            <div>
              <label className="text-[10px] font-semibold text-neutral-500 uppercase tracking-wider block mb-1">Key Name *</label>
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. Production Key"
                autoFocus
                className="w-full h-8 px-3 bg-neutral-800 border border-neutral-700 rounded text-sm text-white placeholder-neutral-600 focus:outline-none focus:border-brand-500"
              />
            </div>
            <div>
              <label className="text-[10px] font-semibold text-neutral-500 uppercase tracking-wider block mb-1">
                Spend Limit (USD) <span className="text-neutral-600 normal-case font-normal">— blank for unlimited</span>
              </label>
              <input
                type="number"
                min="0"
                step="0.01"
                value={limitStr}
                onChange={(e) => setLimitStr(e.target.value)}
                placeholder="e.g. 10.00"
                className="w-full h-8 px-3 bg-neutral-800 border border-neutral-700 rounded text-sm text-white placeholder-neutral-600 focus:outline-none focus:border-brand-500"
              />
            </div>
            <div className="flex gap-2 pt-1">
              <button
                type="submit"
                disabled={loading || !name.trim()}
                className="flex-1 py-2 text-xs font-semibold bg-brand-500 hover:bg-brand-600 text-neutral-900 rounded transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
              >
                {loading ? "Creating..." : "Create Key"}
              </button>
              <button
                type="button"
                onClick={onClose}
                className="px-4 py-2 text-xs text-neutral-400 hover:text-white border border-neutral-700 rounded transition-colors"
              >
                Cancel
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Keys Sheet — bottom drawer with slide-up/down animation
// ---------------------------------------------------------------------------

export interface KeysSheetProps {
  /** Whether the sheet is visible (controls slide animation) */
  open: boolean
  projectId: string
  projectName: string
  /** Pre-fetched keys from page load — sheet will use these until refreshed */
  initialKeys?: ApiKey[]
  /** Pre-fetched spend from page load */
  initialSpend?: SpendData | null
  onClose: () => void
}

export function KeysSheet({ open, projectId, projectName, initialKeys, initialSpend, onClose }: KeysSheetProps) {
  const [keys, setKeys] = useState<ApiKey[]>(initialKeys ?? [])
  const [spend, setSpend] = useState<SpendData | null>(initialSpend ?? null)
  const [loading, setLoading] = useState(!initialKeys)
  const [refreshing, setRefreshing] = useState(false)
  const [showCreateModal, setShowCreateModal] = useState(false)

  // When the sheet opens and we have no pre-loaded data, fetch now
  useEffect(() => {
    if (!open) return
    if (initialKeys) {
      setKeys(initialKeys)
      setSpend(initialSpend ?? null)
      setLoading(false)
      return
    }
    let cancelled = false
    setLoading(true)
    Promise.all([fetchKeys(projectId), fetchSpend(projectId)]).then(([k, s]) => {
      if (!cancelled) { setKeys(k); setSpend(s); setLoading(false) }
    })
    return () => { cancelled = true }
  }, [open, projectId, initialKeys, initialSpend])

  // Sync when initialKeys prop changes (page refreshed keys externally)
  useEffect(() => {
    if (initialKeys) { setKeys(initialKeys); setLoading(false) }
  }, [initialKeys])

  useEffect(() => {
    if (initialSpend !== undefined) setSpend(initialSpend ?? null)
  }, [initialSpend])

  useEffect(() => {
    if (!open) return
    const handler = (e: KeyboardEvent) => { if (e.key === "Escape" && !showCreateModal) onClose() }
    document.addEventListener("keydown", handler)
    return () => document.removeEventListener("keydown", handler)
  }, [open, onClose, showCreateModal])

  const handleRefresh = useCallback(async () => {
    setRefreshing(true)
    const [k, s] = await Promise.all([fetchKeys(projectId), fetchSpend(projectId)])
    setKeys(k)
    setSpend(s)
    setRefreshing(false)
  }, [projectId])

  const handleCreate = async (name: string, limitUsd: number | null) => {
    try {
      const res = await apiFetch(`${API_BASE}/api/projects/${projectId}/keys`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, limit_usd: limitUsd }),
      })
      if (!res.ok) {
        let detail = `Server error (${res.status})`
        try { const body = await res.json(); if (body?.detail) detail = body.detail } catch { /* ignore */ }
        return { error: detail }
      }
      const data = await res.json()
      await handleRefresh()
      return data
    } catch {
      return { error: "Network error — could not reach the API." }
    }
  }

  const handleDelete = async (keyId: string, keyName: string) => {
    if (!window.confirm(`Delete key "${keyName}"? This cannot be undone.`)) return
    try {
      await apiFetch(`${API_BASE}/api/projects/${projectId}/keys/${keyId}`, { method: "DELETE" })
      await handleRefresh()
    } catch { /* ignore */ }
  }

  return (
    <>
      {/* Backdrop — only visible when open */}
      <div
        className={`fixed inset-0 bg-black/50 z-[50] transition-opacity duration-300 ${
          open ? "opacity-100 pointer-events-auto" : "opacity-0 pointer-events-none"
        }`}
        onClick={onClose}
      />

      {/* Sheet — always in DOM, slides up/down */}
      <div
        className={`fixed left-0 right-0 bottom-0 z-[51] bg-neutral-900 border-t border-neutral-800 shadow-2xl flex flex-col transition-transform duration-300 ease-in-out ${
          open ? "translate-y-0" : "translate-y-full"
        }`}
        style={{ maxHeight: "320px" }}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-4 h-10 border-b border-neutral-800 flex-shrink-0">
          <div className="flex items-center gap-2 text-sm font-semibold text-white">
            <Key className="w-3.5 h-3.5 text-brand-400" />
            API Keys
            <span className="text-xs font-normal text-neutral-500 bg-neutral-800 border border-neutral-700 rounded px-1.5 py-0.5">
              {projectName}
            </span>
          </div>
          <div className="flex items-center gap-2">
            {spend && (
              <span className="text-xs text-neutral-500">
                Total: <span className="text-green-400 font-mono">${spend.total_usd.toFixed(4)}</span>
              </span>
            )}
            <button
              onClick={handleRefresh}
              disabled={refreshing}
              className="p-1.5 rounded text-neutral-500 hover:text-neutral-300 hover:bg-neutral-800 transition-colors disabled:opacity-40"
              title="Refresh"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${refreshing ? "animate-spin" : ""}`} />
            </button>
            <button
              onClick={() => setShowCreateModal(true)}
              className="flex items-center gap-1 h-7 px-2.5 text-xs bg-brand-500 hover:bg-brand-600 text-neutral-900 rounded transition-colors"
            >
              <Plus className="w-3 h-3" /> New Key
            </button>
            <button
              onClick={onClose}
              className="p-1.5 rounded text-neutral-500 hover:text-white hover:bg-neutral-800 transition-colors"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto min-h-0">
          {loading ? (
            <div className="px-4 py-6 text-xs text-neutral-600">Loading keys...</div>
          ) : keys.length === 0 ? (
            <div className="px-4 py-8 text-center text-neutral-600 text-xs">
              <p className="font-medium text-neutral-500 mb-1">No API keys yet</p>
              <p>Create a key to authenticate requests for this project.</p>
            </div>
          ) : (
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-neutral-800">
                  <th className="px-4 py-2 text-left text-[10px] font-semibold text-neutral-600 uppercase tracking-wider">Name</th>
                  <th className="px-4 py-2 text-left text-[10px] font-semibold text-neutral-600 uppercase tracking-wider">Key</th>
                  <th className="px-4 py-2 text-right text-[10px] font-semibold text-neutral-600 uppercase tracking-wider">Limit</th>
                  <th className="px-4 py-2 text-right text-[10px] font-semibold text-neutral-600 uppercase tracking-wider">Usage</th>
                  <th className="px-4 py-2 text-left text-[10px] font-semibold text-neutral-600 uppercase tracking-wider">Created</th>
                  <th className="px-4 py-2 w-10"></th>
                </tr>
              </thead>
              <tbody>
                {keys.map((k) => {
                  const pct = k.limit_usd && k.usage_usd != null
                    ? Math.min(100, (k.usage_usd / k.limit_usd) * 100)
                    : 0
                  const barColor = pct > 90 ? "bg-red-500" : pct > 70 ? "bg-brand-500" : "bg-green-500"
                  return (
                    <tr key={k.id} className="border-b border-neutral-800/50 hover:bg-neutral-800/30 transition-colors">
                      <td className="px-4 py-2.5 font-medium text-neutral-200">{k.name}</td>
                      <td className="px-4 py-2.5">
                        <code className="text-[10px] text-neutral-500 font-mono bg-neutral-800 border border-neutral-700/50 rounded px-1.5 py-0.5">
                          {k.key_preview}
                        </code>
                      </td>
                      <td className="px-4 py-2.5 text-right font-mono text-neutral-500">
                        {k.limit_usd != null ? `$${k.limit_usd.toFixed(2)}` : "∞"}
                      </td>
                      <td className="px-4 py-2.5 text-right">
                        <div className="flex items-center justify-end gap-2">
                          {k.limit_usd != null && (
                            <div className="w-12 h-1.5 bg-neutral-800 rounded-full overflow-hidden">
                              <div className={`h-full rounded-full ${barColor}`} style={{ width: `${pct}%` }} />
                            </div>
                          )}
                          <span className={`font-mono ${k.usage_usd ? "text-green-400" : "text-neutral-600"}`}>
                            ${(k.usage_usd ?? 0).toFixed(4)}
                          </span>
                        </div>
                      </td>
                      <td className="px-4 py-2.5 text-neutral-600">
                        {new Date(k.created_at).toLocaleDateString()}
                      </td>
                      <td className="px-4 py-2.5">
                        <button
                          onClick={() => handleDelete(k.id, k.name)}
                          className="p-1 rounded text-neutral-600 hover:text-red-400 hover:bg-neutral-800 transition-colors"
                          title="Delete key"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          )}
        </div>
      </div>

      {showCreateModal && (
        <CreateKeyModal
          onClose={() => setShowCreateModal(false)}
          onCreate={handleCreate}
        />
      )}
    </>
  )
}
