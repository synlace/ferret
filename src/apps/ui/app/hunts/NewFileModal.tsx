"use client"

import { apiFetch } from "@/lib/api-fetch"

import React, { useState } from "react"
import { X, Loader2 } from "lucide-react"

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000"

interface NewFileModalProps { sessionId: string; onCreated: (path: string) => void; onClose: () => void }

export function NewFileModal({ sessionId, onCreated, onClose }: NewFileModalProps) {
  const [subdir, setSubdir] = useState<"scripts" | "tests" | "notes">("scripts")
  const [name, setName] = useState("")
  const [saving, setSaving] = useState(false)

  const handleCreate = async () => {
    if (!name.trim()) return
    setSaving(true)
    try {
      const path = `${subdir}/${name.trim()}`
      await apiFetch(`${API_BASE}/api/workspaces/${sessionId}/files/${path}`, {
        method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ content: "" }),
      })
      onCreated(path)
    } finally { setSaving(false) }
  }

  return (
    <div className="fixed inset-0 bg-black/70 z-50 flex items-stretch justify-end" onClick={onClose}>
      <div className="w-72 bg-neutral-900 border-l border-neutral-700 flex flex-col overflow-hidden" onClick={e => e.stopPropagation()}>
        {/* Header */}
        <div className="flex items-center justify-between px-3 py-2 border-b border-neutral-700 flex-shrink-0 bg-neutral-800">
          <span className="text-xs font-semibold text-white uppercase tracking-wider">New File</span>
          <button onClick={onClose} className="text-neutral-400 hover:text-white p-0.5 transition-colors">
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Directory */}
        <div className="border-b border-neutral-800 px-3 py-2">
          <label className="text-[10px] font-semibold text-neutral-500 uppercase tracking-wider">Directory</label>
          <div className="flex gap-0 mt-1.5">
            {(["scripts", "tests", "notes"] as const).map(d => (
              <button key={d} onClick={() => setSubdir(d)}
                className={`flex-1 py-1.5 text-xs border transition-colors ${subdir === d ? "bg-brand-500/20 border-brand-500/60 text-brand-300" : "border-neutral-700 text-neutral-400 hover:border-neutral-600"}`}>
                {d}
              </button>
            ))}
          </div>
        </div>

        {/* Filename */}
        <div className="border-b border-neutral-800">
          <div className="px-3 pt-2 pb-0.5">
            <label className="text-[10px] font-semibold text-neutral-500 uppercase tracking-wider">Filename</label>
          </div>
          <input
            autoFocus value={name} onChange={e => setName(e.target.value)}
            onKeyDown={e => { if (e.key === "Enter") handleCreate() }}
            placeholder="e.g. recon.sh"
            className="w-full bg-transparent px-3 py-2 text-sm text-white placeholder:text-neutral-600 focus:outline-none focus:bg-neutral-800/40"
          />
        </div>

        {/* Actions */}
        <div className="flex border-t border-neutral-700 mt-auto">
          <button onClick={handleCreate} disabled={saving || !name.trim()}
            className="flex-1 py-2.5 text-xs font-semibold bg-brand-500 hover:bg-brand-600 text-neutral-900 transition-colors disabled:opacity-40 disabled:cursor-not-allowed">
            {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin mx-auto" /> : "Create"}
          </button>
          <button onClick={onClose}
            className="px-4 py-2.5 text-xs text-neutral-400 hover:text-white hover:bg-neutral-800 border-l border-neutral-700 transition-colors">
            Cancel
          </button>
        </div>
      </div>
    </div>
  )
}
