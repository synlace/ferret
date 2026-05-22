"use client"

import { apiFetch } from "@/lib/api-fetch"

import React, { useState } from "react"
import { X, Loader2 } from "lucide-react"

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000"

type Subdir = "workspace" | "scripts" | "tests" | "notes" | "credentials" | "source" | "docs"

const SUBDIR_OPTIONS: { value: Subdir; label: string; description: string }[] = [
  { value: "workspace",   label: "Workspace",   description: "AI scratch area" },
  { value: "scripts",     label: "Scripts",     description: "Polished scripts" },
  { value: "tests",       label: "Tests",       description: "Polished tests" },
  { value: "notes",       label: "Notes",       description: "Findings & notes" },
  { value: "credentials", label: "Credentials", description: "Target credentials" },
  { value: "source",      label: "Source",      description: "Target source code" },
  { value: "docs",        label: "Docs",        description: "Target documentation" },
]

interface NewFileModalProps { sessionId: string; onCreated: (path: string) => void; onClose: () => void }

export function NewFileModal({ sessionId, onCreated, onClose }: NewFileModalProps) {
  const [subdir, setSubdir] = useState<Subdir>("workspace")
  const [name, setName] = useState("")
  const [saving, setSaving] = useState(false)

  const handleCreate = async () => {
    if (!name.trim()) return
    setSaving(true)
    try {
      const path = `${subdir}/${name.trim()}`
      await apiFetch(`${API_BASE}/api/hunts/${sessionId}/files/${path}`, {
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

        {/* Directory — 2-column grid for 7 options */}
        <div className="border-b border-neutral-800 px-3 py-2">
          <label className="text-[10px] font-semibold text-neutral-500 uppercase tracking-wider">Directory</label>
          <div className="grid grid-cols-2 gap-1 mt-1.5">
            {SUBDIR_OPTIONS.map(opt => (
              <button
                key={opt.value}
                onClick={() => setSubdir(opt.value)}
                title={opt.description}
                className={`flex flex-col items-start px-2 py-1.5 text-xs border transition-colors rounded-sm ${
                  subdir === opt.value
                    ? "bg-brand-500/20 border-brand-500/60 text-brand-300"
                    : "border-neutral-700 text-neutral-400 hover:border-neutral-600 hover:text-neutral-300"
                }`}
              >
                <span className="font-medium">{opt.label}</span>
                <span className="text-[9px] text-neutral-600 leading-tight">{opt.description}</span>
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
