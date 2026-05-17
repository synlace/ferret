"use client"

import { apiFetch } from "@/lib/api-fetch"

import React, { useState, useEffect, useCallback, useRef } from "react"
import { Key, Plus, Trash2, DollarSign, RefreshCw, X } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
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
    <div className="fixed inset-0 bg-black/60 z-50 flex items-center justify-center">
      <div ref={modalRef} className="bg-neutral-900 border border-neutral-700 rounded-lg p-6 w-full max-w-md shadow-2xl">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-white font-semibold text-lg flex items-center gap-2">
            <Key className="w-4 h-4 text-orange-400" />
            {createdKey ? "Key Created" : "Create API Key"}
          </h2>
          {!createdKey && (
            <button onClick={onClose} className="text-neutral-400 hover:text-white"><X className="w-4 h-4" /></button>
          )}
        </div>
        {createdKey ? (
          <div className="space-y-4">
            <div className="bg-amber-500/10 border border-amber-500/40 rounded p-3">
              <p className="text-amber-400 text-xs font-medium mb-2">⚠ Save this key now — it will not be shown again.</p>
              <div className="flex items-center gap-2">
                <code className="flex-1 text-xs text-green-400 bg-neutral-800 rounded px-2 py-1.5 break-all font-mono">{createdKey}</code>
                <button onClick={handleCopy}
                  className="shrink-0 px-2 py-1.5 text-xs bg-neutral-700 hover:bg-neutral-600 text-white rounded transition-colors">
                  {copied ? "Copied!" : "Copy"}
                </button>
              </div>
            </div>
            <Button onClick={onClose} className="w-full bg-orange-500 hover:bg-orange-600 text-white">Done</Button>
          </div>
        ) : (
          <form onSubmit={handleSubmit} className="space-y-4">
            {errorMsg && (
              <div className="bg-red-500/10 border border-red-500/40 rounded p-3">
                <p className="text-red-400 text-xs">{errorMsg}</p>
              </div>
            )}
            <div>
              <label className="text-xs text-neutral-400 block mb-1">Key Name *</label>
              <Input value={name} onChange={(e: React.ChangeEvent<HTMLInputElement>) => setName(e.target.value)}
                placeholder="e.g. Production Key"
                className="bg-neutral-800 border-neutral-600 text-white placeholder-neutral-500 focus:border-orange-500" autoFocus />
            </div>
            <div>
              <label className="text-xs text-neutral-400 block mb-1">
                Spend Limit (USD) <span className="text-neutral-600">— leave blank for unlimited</span>
              </label>
              <Input type="number" min="0" step="0.01" value={limitStr}
                onChange={(e: React.ChangeEvent<HTMLInputElement>) => setLimitStr(e.target.value)}
                placeholder="e.g. 10.00"
                className="bg-neutral-800 border-neutral-600 text-white placeholder-neutral-500 focus:border-orange-500" />
            </div>
            <div className="flex gap-2 pt-2">
              <Button type="submit" disabled={loading || !name.trim()}
                className="flex-1 bg-orange-500 hover:bg-orange-600 text-white disabled:opacity-50">
                {loading ? "Creating..." : "Create Key"}
              </Button>
              <Button type="button" variant="outline" onClick={onClose}
                className="border-neutral-600 text-neutral-300 hover:bg-neutral-800">Cancel</Button>
            </div>
          </form>
        )}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Keys Panel (expandable section per project row)
// ---------------------------------------------------------------------------

export function KeysPanel({ projectId }: { projectId: string }) {
  const [keys, setKeys] = useState<ApiKey[]>([])
  const [spend, setSpend] = useState<SpendData | null>(null)
  const [loading, setLoading] = useState(true)
  const [showCreateModal, setShowCreateModal] = useState(false)
  const [refreshing, setRefreshing] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    const [k, s] = await Promise.all([fetchKeys(projectId), fetchSpend(projectId)])
    setKeys(k); setSpend(s); setLoading(false)
  }, [projectId])

  useEffect(() => { load() }, [load])

  const handleRefreshSpend = async () => {
    setRefreshing(true)
    const [s, k] = await Promise.all([fetchSpend(projectId), fetchKeys(projectId)])
    setSpend(s); setKeys(k); setRefreshing(false)
  }

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
      await load()
      return data
    } catch {
      return { error: "Network error — could not reach the API." }
    }
  }

  const handleDelete = async (keyId: string, keyName: string) => {
    if (!window.confirm(`Delete key "${keyName}"? This cannot be undone.`)) return
    try {
      await apiFetch(`${API_BASE}/api/projects/${projectId}/keys/${keyId}`, { method: "DELETE" })
      await load()
    } catch { /* ignore */ }
  }

  if (loading) return <div className="px-4 py-3 text-xs text-neutral-500">Loading keys...</div>

  return (
    <div className="border-t border-neutral-800 bg-neutral-900/50">
      {spend && (
        <div className="px-4 py-2 flex items-center gap-3 border-b border-neutral-800/50">
          <DollarSign className="w-3.5 h-3.5 text-green-400 shrink-0" />
          <span className="text-xs text-neutral-300">
            Total spend: <span className="text-green-400 font-mono">${spend.total_usd.toFixed(4)}</span>
          </span>
          <button onClick={handleRefreshSpend} disabled={refreshing}
            className="ml-auto p-1 text-neutral-500 hover:text-neutral-300 transition-colors disabled:opacity-50" title="Refresh spend">
            <RefreshCw className={`w-3 h-3 ${refreshing ? "animate-spin" : ""}`} />
          </button>
        </div>
      )}
      <div className="px-4 py-2">
        <div className="flex items-center justify-between mb-2">
          <span className="text-xs font-medium text-neutral-400 uppercase tracking-wider">API Keys ({keys.length})</span>
          <button onClick={() => setShowCreateModal(true)}
            className="flex items-center gap-1 text-xs text-orange-400 hover:text-orange-300 transition-colors">
            <Plus className="w-3 h-3" /> Create Key
          </button>
        </div>
        {keys.length === 0 ? (
          <p className="text-xs text-neutral-600 py-2">No provisioned keys. Create one to use project-specific billing.</p>
        ) : (
          <div className="space-y-1">
            {keys.map((k: ApiKey) => (
              <div key={k.id}
                className="flex items-center gap-3 py-1.5 px-2 rounded bg-neutral-800/40 hover:bg-neutral-800/70 transition-colors">
                <Key className="w-3 h-3 text-neutral-500 shrink-0" />
                <span className="text-xs text-white font-medium truncate flex-1">{k.name}</span>
                <code className="text-[10px] text-neutral-500 font-mono">{k.key_preview}</code>
                <span className="text-[10px] text-neutral-500 whitespace-nowrap">
                  {k.limit_usd != null ? `$${k.limit_usd.toFixed(2)} limit` : "Unlimited"}
                </span>
                {k.usage_usd != null && (
                  <span className="text-[10px] text-green-400 font-mono whitespace-nowrap">${k.usage_usd.toFixed(4)} used</span>
                )}
                <span className="text-[10px] text-neutral-600 whitespace-nowrap">
                  {new Date(k.created_at).toLocaleDateString()}
                </span>
                <button onClick={() => handleDelete(k.id, k.name)}
                  className="p-1 text-neutral-600 hover:text-red-400 transition-colors" title="Delete key">
                  <Trash2 className="w-3 h-3" />
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
      {showCreateModal && (
        <CreateKeyModal onClose={() => setShowCreateModal(false)} onCreate={handleCreate} />
      )}
    </div>
  )
}
