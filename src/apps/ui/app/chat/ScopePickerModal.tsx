"use client"

/**
 * ScopePickerModal
 *
 * Replaces the inline scope editor in the Context panel.
 * Opens as a full-screen overlay with:
 *   - A scope-type selector row (All / Single / Selected / Host / Page / Blank)
 *   - A filterable, paginated request table (same pattern as History page)
 *     shown only when scope requires request selection (single / selected)
 *   - Save / Cancel actions that call PATCH /api/chats/:id
 */

import React, { useState, useEffect, useCallback, useRef } from "react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Badge } from "@/components/ui/badge"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import {
  X, Loader2, ChevronLeft, ChevronRight,
  ChevronUp, ChevronDown, ChevronsUpDown,
} from "lucide-react"
import { SCOPE_LABELS, SCOPE_ICONS } from "./NewChatModal"

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface PickerRequest {
  id: string
  seq: number | null
  method: string
  url: string
  host: string
  path: string
  status_code: number | null
  response_time: number | null
  timestamp: string
}

export interface ScopePickerResult {
  scope: string
  scope_data: Record<string, unknown> | null
}

interface ScopePickerModalProps {
  activeProjectId: string
  /** Current scope of the session being edited */
  initialScope: string
  /** Current scope_data of the session being edited */
  initialScopeData: Record<string, unknown> | null
  onClose: () => void
  /** Called with the new scope + scope_data after a successful PATCH */
  onSaved: (result: ScopePickerResult) => void
  /** The chat session id to PATCH */
  sessionId: string
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getMethodColor(method: string): string {
  switch (method) {
    case "GET":    return "bg-blue-600"
    case "POST":   return "bg-green-600"
    case "PUT":    return "bg-yellow-600"
    case "PATCH":  return "bg-orange-600"
    case "DELETE": return "bg-red-600"
    default:       return "bg-neutral-600"
  }
}

function getStatusColor(sc: number): string {
  if (sc >= 500) return "bg-red-700"
  if (sc >= 400) return "bg-orange-700"
  if (sc >= 300) return "bg-yellow-700"
  if (sc >= 200) return "bg-green-700"
  return "bg-neutral-600"
}

function formatTime(ts: string): string {
  try {
    return new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })
  } catch {
    return ts
  }
}

// ---------------------------------------------------------------------------
// Scope type selector row
// ---------------------------------------------------------------------------

const SCOPE_ORDER = ["all", "single", "selected", "host", "page", "blank"] as const

function ScopeTypeRow({
  value,
  onChange,
}: {
  value: string
  onChange: (s: string) => void
}) {
  return (
    <div className="flex flex-wrap gap-2">
      {SCOPE_ORDER.map((s) => (
        <button
          key={s}
          onClick={() => onChange(s)}
          className={`flex items-center gap-1.5 px-3 py-1.5 rounded text-xs border transition-colors ${
            value === s
              ? "bg-orange-500/20 border-orange-500/50 text-orange-400"
              : "bg-neutral-800 border-neutral-700 text-neutral-300 hover:border-neutral-500"
          }`}
        >
          <span>{SCOPE_ICONS[s]}</span>
          <span>{SCOPE_LABELS[s]}</span>
        </button>
      ))}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export function ScopePickerModal({
  activeProjectId,
  initialScope,
  initialScopeData,
  onClose,
  onSaved,
  sessionId,
}: ScopePickerModalProps) {
  const modalRef = useRef<HTMLDivElement>(null)

  // ── Scope state ──────────────────────────────────────────────────────────
  const [scope, setScope] = useState(initialScope)
  const [selectedIds, setSelectedIds] = useState<string[]>(() => {
    if (!initialScopeData) return []
    if (initialScopeData.request_id) return [initialScopeData.request_id as string]
    if (Array.isArray(initialScopeData.request_ids)) return initialScopeData.request_ids as string[]
    return []
  })

  // Reset selection when scope type changes
  useEffect(() => { setSelectedIds([]) }, [scope])

  // ── Request table state ───────────────────────────────────────────────────
  const [requests, setRequests] = useState<PickerRequest[]>([])
  const [loading, setLoading] = useState(false)
  const [totalCount, setTotalCount] = useState(0)
  const [page, setPage] = useState(1)
  const [pageSize] = useState(50)
  const [search, setSearch] = useState("")
  const [methodFilter, setMethodFilter] = useState("all")
  const [statusFilter, setStatusFilter] = useState("all")
  const [sortCol, setSortCol] = useState<"timestamp" | "method" | "status_code" | "response_time">("timestamp")
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc")

  // ── Save state ────────────────────────────────────────────────────────────
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)

  // ── Fetch requests ────────────────────────────────────────────────────────
  const needsTable = scope === "single" || scope === "selected"

  const fetchRequests = useCallback(async () => {
    if (!needsTable) return
    setLoading(true)
    try {
      const offset = (page - 1) * pageSize
      const params = new URLSearchParams({
        limit: String(pageSize),
        offset: String(offset),
        project_id: activeProjectId,
      })
      if (methodFilter !== "all") params.set("method", methodFilter)
      if (search.trim()) params.set("search", search.trim())
      const res = await fetch(`${API_BASE}/api/requests?${params}`)
      if (!res.ok) throw new Error(`API ${res.status}`)
      const data: PickerRequest[] = await res.json()
      const total = parseInt(res.headers.get("X-Total-Count") ?? "0", 10)
      setRequests(data)
      setTotalCount(total)
    } catch {
      // silently ignore — table will show empty
    } finally {
      setLoading(false)
    }
  }, [needsTable, page, pageSize, methodFilter, search, activeProjectId])

  useEffect(() => { setPage(1) }, [methodFilter, search, scope])
  useEffect(() => { fetchRequests() }, [fetchRequests])

  // ── Keyboard: Escape closes ───────────────────────────────────────────────
  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === "Escape") onClose() }
    document.addEventListener("keydown", handler)
    return () => document.removeEventListener("keydown", handler)
  }, [onClose])

  // ── Outside click closes ──────────────────────────────────────────────────
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (modalRef.current && !modalRef.current.contains(e.target as Node)) onClose()
    }
    document.addEventListener("mousedown", handler)
    return () => document.removeEventListener("mousedown", handler)
  }, [onClose])

  // ── Client-side status filter + sort ─────────────────────────────────────
  const filtered = requests.filter((r) => {
    const sc = r.status_code ?? 0
    if (statusFilter === "2xx" && !(sc >= 200 && sc < 300)) return false
    if (statusFilter === "3xx" && !(sc >= 300 && sc < 400)) return false
    if (statusFilter === "4xx" && !(sc >= 400 && sc < 500)) return false
    if (statusFilter === "5xx" && !(sc >= 500)) return false
    return true
  })

  const sorted = [...filtered].sort((a, b) => {
    let av: string | number | null = null
    let bv: string | number | null = null
    if (sortCol === "timestamp") { av = a.timestamp; bv = b.timestamp }
    else if (sortCol === "method") { av = a.method; bv = b.method }
    else if (sortCol === "status_code") { av = a.status_code; bv = b.status_code }
    else if (sortCol === "response_time") { av = a.response_time; bv = b.response_time }
    if (av == null && bv == null) return 0
    if (av == null) return 1
    if (bv == null) return -1
    if (av < bv) return sortDir === "asc" ? -1 : 1
    if (av > bv) return sortDir === "asc" ? 1 : -1
    return 0
  })

  function toggleSort(col: typeof sortCol) {
    if (sortCol === col) setSortDir(d => d === "asc" ? "desc" : "asc")
    else { setSortCol(col); setSortDir("asc") }
  }

  function SortIcon({ col }: { col: typeof sortCol }) {
    if (sortCol !== col) return <ChevronsUpDown className="w-3 h-3 opacity-40" />
    return sortDir === "asc" ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />
  }

  // ── Row selection ─────────────────────────────────────────────────────────
  function toggleRow(id: string) {
    if (scope === "single") {
      setSelectedIds([id])
    } else {
      setSelectedIds(prev =>
        prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]
      )
    }
  }

  function toggleAll() {
    if (scope !== "selected") return
    const pageIds = sorted.map(r => r.id)
    const allSelected = pageIds.every(id => selectedIds.includes(id))
    if (allSelected) {
      setSelectedIds(prev => prev.filter(id => !pageIds.includes(id)))
    } else {
      setSelectedIds(prev => Array.from(new Set([...prev, ...pageIds])))
    }
  }

  // ── Save ──────────────────────────────────────────────────────────────────
  async function handleSave() {
    setSaving(true)
    setSaveError(null)
    const scopeData: Record<string, unknown> | null =
      scope === "single" && selectedIds.length > 0
        ? { request_id: selectedIds[0] }
        : scope === "selected" && selectedIds.length > 0
        ? { request_ids: selectedIds }
        : null

    try {
      const res = await fetch(`${API_BASE}/api/chats/${sessionId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ scope, scope_data: scopeData }),
      })
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error((body as { detail?: string }).detail ?? `HTTP ${res.status}`)
      }
      onSaved({ scope, scope_data: scopeData })
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : "Save failed")
    } finally {
      setSaving(false)
    }
  }

  // ── Pagination ────────────────────────────────────────────────────────────
  const totalPages = Math.max(1, Math.ceil(totalCount / pageSize))
  const canPrev = page > 1
  const canNext = page < totalPages

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4">
      <div
        ref={modalRef}
        className="bg-neutral-900 border border-neutral-700 rounded-lg shadow-2xl flex flex-col"
        style={{ width: "min(900px, 95vw)", maxHeight: "90vh" }}
      >
        {/* ── Header ── */}
        <div className="flex items-center justify-between px-5 py-3 border-b border-neutral-700 flex-shrink-0">
          <h2 className="text-sm font-semibold text-white">Edit Scope</h2>
          <Button variant="ghost" size="icon" className="h-6 w-6 text-neutral-400 hover:text-white" onClick={onClose}>
            <X className="w-3 h-3" />
          </Button>
        </div>

        {/* ── Scope type selector ── */}
        <div className="px-5 py-3 border-b border-neutral-700 flex-shrink-0">
          <p className="text-xs text-neutral-400 mb-2">Scope type</p>
          <ScopeTypeRow value={scope} onChange={setScope} />
        </div>

        {/* ── Request table (only for single / selected) ── */}
        {needsTable && (
          <>
            {/* Filters */}
            <div className="px-5 py-3 border-b border-neutral-700 flex-shrink-0">
              <div className="flex gap-3 items-center">
                <Input
                  placeholder="Search by URL, host, path…"
                  value={search}
                  onChange={e => setSearch(e.target.value)}
                  className="flex-1 bg-neutral-800 border-neutral-600 text-white text-xs h-8"
                />
                <Select value={methodFilter} onValueChange={setMethodFilter}>
                  <SelectTrigger className="w-32 bg-neutral-800 border-neutral-600 text-white text-xs h-8">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent className="bg-neutral-800 border-neutral-600">
                    <SelectItem value="all">All Methods</SelectItem>
                    <SelectItem value="GET">GET</SelectItem>
                    <SelectItem value="POST">POST</SelectItem>
                    <SelectItem value="PUT">PUT</SelectItem>
                    <SelectItem value="DELETE">DELETE</SelectItem>
                    <SelectItem value="PATCH">PATCH</SelectItem>
                  </SelectContent>
                </Select>
                <Select value={statusFilter} onValueChange={setStatusFilter}>
                  <SelectTrigger className="w-32 bg-neutral-800 border-neutral-600 text-white text-xs h-8">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent className="bg-neutral-800 border-neutral-600">
                    <SelectItem value="all">All Status</SelectItem>
                    <SelectItem value="2xx">2xx</SelectItem>
                    <SelectItem value="3xx">3xx</SelectItem>
                    <SelectItem value="4xx">4xx</SelectItem>
                    <SelectItem value="5xx">5xx</SelectItem>
                  </SelectContent>
                </Select>
                {scope === "selected" && selectedIds.length > 0 && (
                  <span className="text-xs text-orange-400 whitespace-nowrap">
                    {selectedIds.length} selected
                  </span>
                )}
              </div>
            </div>

            {/* Table */}
            <div className="flex-1 overflow-auto min-h-0">
              {loading ? (
                <div className="flex items-center justify-center py-16 text-neutral-500">
                  <Loader2 className="w-5 h-5 animate-spin mr-2" />
                  Loading…
                </div>
              ) : sorted.length === 0 ? (
                <div className="flex items-center justify-center py-16 text-neutral-500 text-sm">
                  No requests found
                </div>
              ) : (
                <table className="w-full text-xs">
                  <thead className="sticky top-0 z-10 bg-neutral-800">
                    <tr className="border-b border-neutral-700">
                      {/* Select-all checkbox (selected mode only) */}
                      <th className="w-8 px-3 py-2">
                        {scope === "selected" && (
                          <div
                            onClick={toggleAll}
                            className={`w-3.5 h-3.5 rounded border cursor-pointer mx-auto ${
                              sorted.every(r => selectedIds.includes(r.id))
                                ? "bg-orange-500 border-orange-500"
                                : "border-neutral-500"
                            }`}
                          />
                        )}
                      </th>
                      <th className="px-3 py-2 text-left text-neutral-400 font-medium w-12">#</th>
                      <th
                        className="px-3 py-2 text-left text-neutral-400 font-medium cursor-pointer hover:text-white w-20"
                        onClick={() => toggleSort("method")}
                      >
                        <div className="flex items-center gap-1">Method <SortIcon col="method" /></div>
                      </th>
                      <th className="px-3 py-2 text-left text-neutral-400 font-medium">URL</th>
                      <th
                        className="px-3 py-2 text-left text-neutral-400 font-medium cursor-pointer hover:text-white w-20"
                        onClick={() => toggleSort("status_code")}
                      >
                        <div className="flex items-center gap-1">Status <SortIcon col="status_code" /></div>
                      </th>
                      <th
                        className="px-3 py-2 text-left text-neutral-400 font-medium cursor-pointer hover:text-white w-24"
                        onClick={() => toggleSort("response_time")}
                      >
                        <div className="flex items-center gap-1">Time <SortIcon col="response_time" /></div>
                      </th>
                      <th
                        className="px-3 py-2 text-left text-neutral-400 font-medium cursor-pointer hover:text-white w-28"
                        onClick={() => toggleSort("timestamp")}
                      >
                        <div className="flex items-center gap-1">Captured <SortIcon col="timestamp" /></div>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {sorted.map((req) => {
                      const isSelected = selectedIds.includes(req.id)
                      return (
                        <tr
                          key={req.id}
                          onClick={() => toggleRow(req.id)}
                          className={`border-b border-neutral-700/50 cursor-pointer transition-colors hover:bg-neutral-700/40 ${
                            isSelected ? "bg-orange-500/10" : ""
                          }`}
                        >
                          {/* Checkbox / radio */}
                          <td className="px-3 py-2 text-center">
                            {scope === "single" ? (
                              <div className={`w-3.5 h-3.5 rounded-full border mx-auto ${
                                isSelected ? "bg-orange-500 border-orange-500" : "border-neutral-500"
                              }`} />
                            ) : (
                              <div className={`w-3.5 h-3.5 rounded border mx-auto ${
                                isSelected ? "bg-orange-500 border-orange-500" : "border-neutral-500"
                              }`} />
                            )}
                          </td>
                          <td className="px-3 py-2 text-neutral-500 font-mono tabular-nums">
                            {req.seq ?? "—"}
                          </td>
                          <td className="px-3 py-2">
                            <Badge className={`${getMethodColor(req.method)} text-white border-0 text-xs`}>
                              {req.method}
                            </Badge>
                          </td>
                          <td className="px-3 py-2 min-w-0">
                            <div className="truncate max-w-xs">
                              <span className="text-neutral-400">{req.host}</span>
                              <span className="text-white">{req.path}</span>
                            </div>
                          </td>
                          <td className="px-3 py-2">
                            {req.status_code != null ? (
                              <Badge className={`${getStatusColor(req.status_code)} text-white border-0 text-xs`}>
                                {req.status_code}
                              </Badge>
                            ) : (
                              <span className="text-neutral-600">—</span>
                            )}
                          </td>
                          <td className="px-3 py-2 text-neutral-300 font-mono">
                            {req.response_time != null ? `${Math.round(req.response_time)}ms` : "—"}
                          </td>
                          <td className="px-3 py-2 text-neutral-400 font-mono">
                            {formatTime(req.timestamp)}
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              )}
            </div>

            {/* Pagination */}
            {totalCount > 0 && (
              <div className="flex items-center justify-between px-5 py-2 border-t border-neutral-700 flex-shrink-0 text-xs text-neutral-400">
                <span>
                  {((page - 1) * pageSize) + 1}–{Math.min(page * pageSize, totalCount)} of {totalCount}
                </span>
                <div className="flex items-center gap-1">
                  <Button
                    variant="ghost" size="icon"
                    className="h-7 w-7 text-neutral-400 hover:text-white disabled:opacity-30"
                    disabled={!canPrev}
                    onClick={() => setPage(p => p - 1)}
                  >
                    <ChevronLeft className="w-3 h-3" />
                  </Button>
                  <span className="px-2">Page {page} of {totalPages}</span>
                  <Button
                    variant="ghost" size="icon"
                    className="h-7 w-7 text-neutral-400 hover:text-white disabled:opacity-30"
                    disabled={!canNext}
                    onClick={() => setPage(p => p + 1)}
                  >
                    <ChevronRight className="w-3 h-3" />
                  </Button>
                </div>
              </div>
            )}
          </>
        )}

        {/* ── Non-table scope description ── */}
        {!needsTable && (
          <div className="flex-1 flex items-center justify-center text-neutral-500 text-sm px-5">
            <div className="text-center space-y-2">
              <div className="text-3xl">{SCOPE_ICONS[scope]}</div>
              <div className="font-medium text-white">{SCOPE_LABELS[scope]}</div>
              <div className="text-xs max-w-xs">
                {scope === "all" && "The AI will have access to all captured proxy history for this project."}
                {scope === "host" && "The AI will have access to all requests from a specific host. The host is inferred from the current request context."}
                {scope === "page" && "The AI will have access to the currently visible page of requests in History."}
                {scope === "blank" && "No request context — the AI will answer general questions only."}
              </div>
            </div>
          </div>
        )}

        {/* ── Footer ── */}
        <div className="flex items-center justify-between px-5 py-3 border-t border-neutral-700 flex-shrink-0">
          {saveError ? (
            <span className="text-xs text-red-400">{saveError}</span>
          ) : (
            <span className="text-xs text-neutral-500">
              {needsTable && scope === "single" && selectedIds.length === 0 && "Select one request"}
              {needsTable && scope === "selected" && selectedIds.length === 0 && "Select one or more requests"}
              {needsTable && selectedIds.length > 0 && `${selectedIds.length} request${selectedIds.length > 1 ? "s" : ""} selected`}
              {!needsTable && `Scope: ${SCOPE_LABELS[scope]}`}
            </span>
          )}
          <div className="flex gap-2">
            <Button
              variant="outline"
              size="sm"
              className="border-neutral-600 text-neutral-300 text-xs"
              onClick={onClose}
            >
              Cancel
            </Button>
            <Button
              size="sm"
              className="bg-orange-500 hover:bg-orange-600 text-white text-xs"
              disabled={
                saving ||
                (scope === "single" && selectedIds.length === 0) ||
                (scope === "selected" && selectedIds.length === 0)
              }
              onClick={handleSave}
            >
              {saving ? <Loader2 className="w-3 h-3 animate-spin mr-1" /> : null}
              Save Scope
            </Button>
          </div>
        </div>
      </div>
    </div>
  )
}
