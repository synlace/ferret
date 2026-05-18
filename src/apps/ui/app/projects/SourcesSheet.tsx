"use client"

import { apiFetch } from "@/lib/api-fetch"

import React, { useState, useEffect, useCallback, useRef } from "react"
import { BookOpen, Upload, Trash2, X, RefreshCw, FileText, Code2, FileJson, StickyNote, File } from "lucide-react"
import { API_BASE } from "./types"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type SourceKind = "documentation" | "source_code" | "openapi" | "note" | "other"

interface SourceMeta {
  filename: string
  name: string
  kind: SourceKind
  size: number
  created_at: string
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function kindIcon(kind: SourceKind) {
  switch (kind) {
    case "documentation": return <FileText className="w-3.5 h-3.5 text-blue-400 flex-shrink-0" />
    case "source_code":   return <Code2    className="w-3.5 h-3.5 text-green-400 flex-shrink-0" />
    case "openapi":       return <FileJson className="w-3.5 h-3.5 text-yellow-400 flex-shrink-0" />
    case "note":          return <StickyNote className="w-3.5 h-3.5 text-purple-400 flex-shrink-0" />
    default:              return <File     className="w-3.5 h-3.5 text-neutral-400 flex-shrink-0" />
  }
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

// ---------------------------------------------------------------------------
// SourcesSheet
// ---------------------------------------------------------------------------

interface SourcesSheetProps {
  open: boolean
  projectId: string
  projectName: string
  onClose: () => void
}

export function SourcesSheet({ open, projectId, projectName, onClose }: SourcesSheetProps) {
  const [sources, setSources] = useState<SourceMeta[]>([])
  const [loading, setLoading] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const sheetRef = useRef<HTMLDivElement>(null)

  // ── Fetch ────────────────────────────────────────────────────────────────

  const fetchSources = useCallback(async () => {
    if (!projectId) return
    setLoading(true)
    setError(null)
    try {
      const res = await apiFetch(`${API_BASE}/api/projects/${projectId}/sources`)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      setSources(await res.json())
    } catch (e) {
      setError("Failed to load sources.")
    } finally {
      setLoading(false)
    }
  }, [projectId])

  useEffect(() => {
    if (open && projectId) fetchSources()
  }, [open, projectId, fetchSources])

  // ── Close on Escape / outside click ─────────────────────────────────────

  useEffect(() => {
    if (!open) return
    const handler = (e: KeyboardEvent) => { if (e.key === "Escape") onClose() }
    document.addEventListener("keydown", handler)
    return () => document.removeEventListener("keydown", handler)
  }, [open, onClose])

  useEffect(() => {
    if (!open) return
    const handler = (e: MouseEvent) => {
      if (sheetRef.current && !sheetRef.current.contains(e.target as Node)) onClose()
    }
    document.addEventListener("mousedown", handler)
    return () => document.removeEventListener("mousedown", handler)
  }, [open, onClose])

  // ── Upload ───────────────────────────────────────────────────────────────

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files
    if (!files || files.length === 0) return
    setUploading(true)
    setError(null)
    try {
      for (const file of Array.from(files)) {
        const form = new FormData()
        form.append("file", file)
        const res = await apiFetch(`${API_BASE}/api/projects/${projectId}/sources/upload`, {
          method: "POST",
          body: form,
        })
        if (!res.ok) {
          const body = await res.json().catch(() => ({}))
          throw new Error(body?.detail ?? `Upload failed (${res.status})`)
        }
      }
      await fetchSources()
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Upload failed.")
    } finally {
      setUploading(false)
      if (fileInputRef.current) fileInputRef.current.value = ""
    }
  }

  // ── Delete ───────────────────────────────────────────────────────────────

  const handleDelete = async (filename: string) => {
    if (!window.confirm(`Delete source "${filename}"? This cannot be undone.`)) return
    try {
      const res = await apiFetch(
        `${API_BASE}/api/projects/${projectId}/sources/${encodeURIComponent(filename)}`,
        { method: "DELETE" },
      )
      if (!res.ok && res.status !== 204) {
        const body = await res.json().catch(() => ({}))
        setError(body?.detail ?? "Delete failed.")
        return
      }
      setSources((prev) => prev.filter((s) => s.filename !== filename))
    } catch {
      setError("Delete failed.")
    }
  }

  // ── Render ───────────────────────────────────────────────────────────────

  if (!open) return null

  return (
    <div className="fixed inset-0 bg-black/60 z-50 flex items-end justify-center sm:items-center">
      <div
        ref={sheetRef}
        className="bg-neutral-900 border border-neutral-700 rounded-t-xl sm:rounded-xl w-full max-w-lg shadow-2xl flex flex-col max-h-[80vh]"
      >
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-neutral-800 flex-shrink-0">
          <div className="flex items-center gap-2">
            <BookOpen className="w-4 h-4 text-brand-400" />
            <h2 className="text-white font-semibold text-sm">Sources</h2>
            <span className="text-neutral-500 text-xs truncate max-w-[160px]">{projectName}</span>
          </div>
          <div className="flex items-center gap-1">
            <button
              onClick={fetchSources}
              disabled={loading}
              title="Refresh"
              className="p-1.5 rounded text-neutral-500 hover:text-white hover:bg-neutral-800 transition-colors disabled:opacity-40"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${loading ? "animate-spin" : ""}`} />
            </button>
            <button
              onClick={onClose}
              className="p-1.5 rounded text-neutral-500 hover:text-white hover:bg-neutral-800 transition-colors"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>

        {/* Upload bar */}
        <div className="px-4 py-2.5 border-b border-neutral-800 flex-shrink-0">
          <input
            ref={fileInputRef}
            type="file"
            multiple
            accept=".md,.txt,.rst,.yaml,.yml,.json,.py,.js,.ts,.go,.rb,.java,.cs,.php,.c,.cpp,.h"
            className="hidden"
            onChange={handleFileChange}
          />
          <button
            onClick={() => fileInputRef.current?.click()}
            disabled={uploading}
            className="flex items-center gap-1.5 h-7 px-3 text-xs font-medium bg-brand-500 hover:bg-brand-600 text-neutral-900 rounded transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <Upload className="w-3 h-3" />
            {uploading ? "Uploading…" : "Upload Files"}
          </button>
          <p className="text-[10px] text-neutral-600 mt-1.5">
            Accepts .md, .txt, .yaml, .json, .py, .js, .ts, .go and more · Max 512 KB per file · UTF-8 text only
          </p>
        </div>

        {/* Error */}
        {error && (
          <div className="mx-4 mt-2 px-3 py-2 bg-red-900/30 border border-red-700/50 rounded text-xs text-red-300 flex-shrink-0">
            {error}
          </div>
        )}

        {/* Source list */}
        <div className="flex-1 overflow-y-auto min-h-0">
          {loading && sources.length === 0 ? (
            <div className="px-4 py-10 text-center text-neutral-600 text-xs">Loading…</div>
          ) : sources.length === 0 ? (
            <div className="px-4 py-10 text-center text-neutral-600 text-xs">
              <BookOpen className="w-6 h-6 mx-auto mb-2 opacity-30" />
              No sources yet. Upload files above, or drop them directly into{" "}
              <code className="text-neutral-500 font-mono">data/sources/{projectId}/</code> on the host.
            </div>
          ) : (
            <ul className="divide-y divide-neutral-800">
              {sources.map((s) => (
                <li key={s.filename} className="flex items-center gap-3 px-4 py-2.5 hover:bg-neutral-800/40 transition-colors group">
                  {kindIcon(s.kind)}
                  <div className="flex-1 min-w-0">
                    <p className="text-xs font-medium text-neutral-200 truncate">{s.filename}</p>
                    <p className="text-[10px] text-neutral-600 mt-0.5">
                      {s.kind} · {formatSize(s.size)} · {new Date(s.created_at).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" })}
                    </p>
                  </div>
                  <button
                    onClick={() => handleDelete(s.filename)}
                    title="Delete source"
                    className="p-1.5 rounded text-neutral-700 hover:text-red-400 hover:bg-neutral-800 transition-colors opacity-0 group-hover:opacity-100"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  )
}
