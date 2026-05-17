"use client"

import { apiFetch } from "@/lib/api-fetch"

import React, { useState, useEffect, useCallback, useMemo, useRef } from "react"
import { useRouter } from "next/navigation"
import {
  useReactTable,
  getCoreRowModel,
  getFilteredRowModel,
  flexRender,
  createColumnHelper,
  type SortingState,
  type ColumnFiltersState,
} from "@tanstack/react-table"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Badge } from "@/components/ui/badge"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import {
  Download, Copy, RefreshCw, Loader2, Sparkles, Trash2,
  ChevronUp, ChevronDown, ChevronsUpDown,
  ChevronLeft, ChevronRight, SlidersHorizontal,
  Eye, Maximize2, MessageSquare, Zap, Terminal, Code2, Link, Filter, Highlighter, X, Clock,
} from "lucide-react"
import { useProject } from "../context/project-context"
import {
  ApiRequest, DetailPanel,
  getStatusColor, getMethodColor, formatTime,
} from "./DetailPanel"
import { parseQuery, matchesQuery } from "./parseQuery"
import { upsertToken, isTokenActive } from "./upsertToken"
import { useSearchHistory } from "./useSearchHistory"

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000"
const WS_BASE = API_BASE.replace(/^http/, "ws")

const columnHelper = createColumnHelper<ApiRequest>()

// ---------------------------------------------------------------------------
// Main page
// ---------------------------------------------------------------------------

export default function HistoryPage() {
  const { activeProjectId, activeProject } = useProject()
  const router = useRouter()

  const [requests, setRequests] = useState<ApiRequest[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  // TanStack Table state
  const [sorting, setSorting] = useState<SortingState>([{ id: "timestamp", desc: true }])
  const [columnFilters, setColumnFilters] = useState<ColumnFiltersState>([])

  // ── Single source of truth for all filtering ──────────────────────────────
  const [searchQuery, setSearchQuery] = useState("")
  const [filterOpen, setFilterOpen] = useState(false)

  // Pagination state
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(50)
  const [totalCount, setTotalCount] = useState(0)

  // Expanded rows (multi-expand)
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set())
  const [maximizedId, setMaximizedId] = useState<string | null>(null)

  const toggleExpanded = (id: string) => setExpandedIds(prev => {
    const next = new Set(prev)
    next.has(id) ? next.delete(id) : next.add(id)
    return next
  })

  // AI annotation state — keyed by request id
  const [annotating, setAnnotating] = useState<string | null>(null)
  const [annotateError, setAnnotateError] = useState<string | null>(null)

  // Clear history state
  const [clearing, setClearing] = useState(false)

  // Hosts with test files
  const [hostsWithTests, setHostsWithTests] = useState<Set<string>>(new Set())

  // Context menu state
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; req: ApiRequest } | null>(null)
  const [highlightedIds, setHighlightedIds] = useState<Map<string, string>>(new Map())

  // Search history
  const { history: searchHistory, push: pushHistory, remove: removeHistory } = useSearchHistory()
  const [historyOpen, setHistoryOpen] = useState(false)
  const [historyIndex, setHistoryIndex] = useState(-1)
  const historyPanelRef = useRef<HTMLDivElement>(null)

  // Filtered suggestions: when query is non-empty, show matching history; when empty show all
  const historySuggestions = useMemo(() => {
    const q = searchQuery.trim().toLowerCase()
    if (!q) return searchHistory
    return searchHistory.filter(h => h.toLowerCase().includes(q))
  }, [searchQuery, searchHistory])

  // Close history dropdown on outside click
  useEffect(() => {
    const close = () => setContextMenu(null)
    document.addEventListener("click", close)
    return () => document.removeEventListener("click", close)
  }, [])

  // Fetch test files to know which hosts have tests
  useEffect(() => {
    apiFetch(`${API_BASE}/api/tests/files?project_id=${activeProjectId}`)
      .then(r => r.ok ? r.json() : { files: [] })
      .then((data: { files?: Array<{ host: string }> }) => {
        const files = data.files ?? (Array.isArray(data) ? data : [])
        setHostsWithTests(new Set((files as Array<{ host: string }>).map(f => f.host)))
      })
      .catch(() => {})
  }, [activeProjectId])

  // ------------------------------------------------------------------
  // Parsed query (derived from searchQuery)
  // ------------------------------------------------------------------

  const parsedQuery = useMemo(() => parseQuery(searchQuery), [searchQuery])

  // ------------------------------------------------------------------
  // Data fetching
  // ------------------------------------------------------------------

  const fetchRequests = useCallback(async () => {
    try {
      const params = new URLSearchParams({ limit: "10000", offset: "0" })
      // Only pass free-text terms to the backend search param
      const freeText = parsedQuery.text.join(" ").trim()
      if (freeText) params.set("search", freeText)
      params.set("project_id", activeProjectId)

      const res = await apiFetch(`${API_BASE}/api/requests?${params}`)
      if (!res.ok) throw new Error(`API returned ${res.status}`)
      const data: ApiRequest[] = await res.json()
      const total = parseInt(res.headers.get("X-Total-Count") ?? "0", 10)
      setRequests(data)
      setTotalCount(total)
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to fetch requests")
    } finally {
      setLoading(false)
    }
  }, [parsedQuery.text, activeProjectId])

  // Reset to page 1 whenever filters or page size change
  useEffect(() => {
    setPage(1)
  }, [searchQuery, pageSize, activeProjectId])

  // Initial fetch on mount / filter change
  useEffect(() => {
    fetchRequests()
  }, [fetchRequests])

  // WebSocket — receive new requests in real-time
  useEffect(() => {
    const ws = new WebSocket(`${WS_BASE}/ws`)
    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data) as { type: string; data: ApiRequest }
        if (msg.type === "new_request") {
          setRequests((prev) => {
            const exists = prev.some((r) => r.id === msg.data.id)
            if (exists) {
              return prev.map((r) => r.id === msg.data.id ? msg.data : r)
            }
            return [msg.data, ...prev].slice(0, pageSize)
          })
          setTotalCount((c) => c + 1)
        }
      } catch {
        // ignore malformed messages
      }
    }
    ws.onerror = () => ws.close()
    return () => ws.close()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeProjectId, pageSize])

  // ------------------------------------------------------------------
  // AI annotation
  // ------------------------------------------------------------------

  const handleAnnotate = useCallback(async (req: ApiRequest, e: React.MouseEvent) => {
    e.stopPropagation()
    setAnnotating(req.id)
    setAnnotateError(null)
    try {
      const res = await apiFetch(`${API_BASE}/api/requests/${req.id}/annotate`, { method: "POST" })
      if (!res.ok) {
        const body = await res.json().catch(() => ({ detail: res.statusText }))
        throw new Error(body.detail ?? `HTTP ${res.status}`)
      }
      const { annotation } = await res.json()
      setRequests((prev) => prev.map((r) => r.id === req.id ? { ...r, annotation } : r))
    } catch (err) {
      setAnnotateError(err instanceof Error ? err.message : "Annotation failed")
    } finally {
      setAnnotating(null)
    }
  }, [])

  // ------------------------------------------------------------------
  // Clear history
  // ------------------------------------------------------------------

  const handleClearHistory = async () => {
    if (!window.confirm(`Delete all ${totalCount} captured requests? This cannot be undone.`)) return
    setClearing(true)
    try {
      const res = await apiFetch(`${API_BASE}/api/requests`, { method: "DELETE" })
      if (!res.ok) throw new Error(`API returned ${res.status}`)
      setRequests([])
      setTotalCount(0)
      setExpandedIds(new Set())
      setPage(1)
    } catch (err) {
      setAnnotateError(err instanceof Error ? err.message : "Failed to clear history")
    } finally {
      setClearing(false)
    }
  }

  // ------------------------------------------------------------------
  // TanStack Table columns
  // ------------------------------------------------------------------

  const columns = useMemo(() => [
    columnHelper.accessor("seq", {
      header: "#",
      size: 56,
      cell: (info) => (
        <span className="text-neutral-500 font-mono text-xs tabular-nums">{info.getValue() ?? "—"}</span>
      ),
    }),
    columnHelper.accessor("timestamp", {
      header: "Time",
      size: 128,
      cell: (info) => (
        <span className="text-neutral-300 font-mono text-sm">{formatTime(info.getValue())}</span>
      ),
      sortingFn: "datetime",
    }),
    columnHelper.accessor("method", {
      size: 96,
      header: "Method",
      cell: (info) => (
        <Badge className={`${getMethodColor(info.getValue())} text-white border-0 text-xs`}>
          {info.getValue()}
        </Badge>
      ),
      filterFn: "equalsString",
    }),
    columnHelper.accessor("url", {
      header: "URL",
      enableResizing: false,
      cell: (info) => {
        const req = info.row.original
        return (
          <div className="truncate" title={info.getValue()}>
            <span className="mr-1 text-xs" title={req.source === "test" ? "Automated test traffic" : "Human/proxy traffic"}>
              {req.source === "test" ? "🧪" : "👤"}
            </span>
            <span className="text-neutral-500">{req.host}</span>
            <span className="text-white">{req.path}</span>
          </div>
        )
      },
    }),
    columnHelper.accessor(row => row.annotation ? 1 : 0, {
      id: "annotated",
      header: "AI",
      size: 56,
      enableSorting: true,
      cell: (info) => {
        return info.row.original.annotation ? (
          <span className="text-xs text-yellow-400 font-mono" title="Has AI annotation">✦</span>
        ) : null
      },
    }),
    columnHelper.accessor(row => ((() => { try { return new URL(row.url).search.length > 1 } catch { return false } })() || !!(row.body && row.body.trim())) ? 1 : 0, {
      id: "params",
      header: "Params",
      size: 96,
      enableSorting: true,
      cell: (info) => {
        const req = info.row.original
        const hasQuery = (() => { try { return new URL(req.url).search.length > 1 } catch { return false } })()
        const hasBody = !!(req.body && req.body.trim().length > 0)
        return (hasQuery || hasBody) ? (
          <span className="text-xs text-orange-400 font-mono">✓</span>
        ) : null
      },
    }),
    columnHelper.accessor("status_code", {
      header: "Status",
      size: 96,
      cell: (info) => {
        const sc = info.getValue()
        return sc ? (
          <Badge className={`${getStatusColor(sc)} text-white border-0 text-xs`}>{sc}</Badge>
        ) : (
          <span className="text-neutral-600 text-xs">pending</span>
        )
      },
    }),
    columnHelper.accessor("response_time", {
      header: "ms",
      size: 72,
      cell: (info) => {
        const v = info.getValue()
        return <span className="text-neutral-300">{v != null ? `${Math.round(v)}ms` : "—"}</span>
      },
    }),
    columnHelper.accessor("response_size", {
      header: "Size",
      size: 96,
      cell: (info) => {
        const v = info.getValue()
        return <span className="text-neutral-300">{v != null ? `${v}B` : "—"}</span>
      },
    }),
    columnHelper.accessor(row => hostsWithTests.has(row.host) ? 1 : 0, {
      id: "has_tests",
      header: "Tests",
      size: 80,
      enableSorting: true,
      cell: (info) => {
        const host = info.row.original.host
        return hostsWithTests.has(host) ? (
          <span className="text-xs text-green-400 font-mono">✓</span>
        ) : null
      },
    }),
  // eslint-disable-next-line react-hooks/exhaustive-deps
  ], [annotating, handleAnnotate, hostsWithTests])

  // ------------------------------------------------------------------
  // Client-side filtering — driven entirely by parsedQuery
  // ------------------------------------------------------------------

  const filteredData = useMemo(() => {
    return requests.filter(req => matchesQuery(req, parsedQuery))
  }, [requests, parsedQuery])

  // ------------------------------------------------------------------
  // Sorting + pagination (fully client-side, against filtered data)
  // ------------------------------------------------------------------

  const sortedFilteredData = useMemo(() => {
    if (sorting.length === 0) return filteredData
    const [{ id, desc }] = sorting

    const derivedValue = (req: ApiRequest): unknown => {
      if (id === "annotated") return req.annotation ? 1 : 0
      if (id === "params") {
        const hasQuery = (() => { try { return new URL(req.url).search.length > 1 } catch { return false } })()
        return (hasQuery || !!(req.body && req.body.trim().length > 0)) ? 1 : 0
      }
      if (id === "has_tests") return hostsWithTests.has(req.host) ? 1 : 0
      return (req as unknown as Record<string, unknown>)[id]
    }

    return [...filteredData].sort((a, b) => {
      const av = derivedValue(a)
      const bv = derivedValue(b)
      if (av == null && bv == null) return 0
      if (av == null) return desc ? 1 : -1
      if (bv == null) return desc ? -1 : 1
      if (typeof av === "number" && typeof bv === "number") return desc ? bv - av : av - bv
      return desc
        ? String(bv).localeCompare(String(av))
        : String(av).localeCompare(String(bv))
    })
  }, [filteredData, sorting, hostsWithTests])

  const filteredTotal = sortedFilteredData.length
  const totalPages = Math.max(1, Math.ceil(filteredTotal / pageSize))
  const canPrev = page > 1
  const canNext = page < totalPages

  const pagedData = useMemo(() => {
    const start = (page - 1) * pageSize
    return sortedFilteredData.slice(start, start + pageSize)
  }, [sortedFilteredData, page, pageSize])

  const table = useReactTable({
    data: pagedData,
    columns,
    state: { sorting, columnFilters },
    onSortingChange: (updater) => {
      setSorting(updater)
      setPage(1)
    },
    onColumnFiltersChange: setColumnFilters,
    enableColumnResizing: false,
    manualSorting: true,
    getCoreRowModel: getCoreRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
  })

  // ------------------------------------------------------------------
  // Stats
  // ------------------------------------------------------------------

  const totalRequests = totalCount
  const completed = requests.filter((r) => r.status_code !== null)
  const successRate =
    completed.length > 0
      ? Math.round((completed.filter((r) => (r.status_code ?? 0) >= 200 && (r.status_code ?? 0) < 300).length / completed.length) * 100)
      : 0
  const avgResponseTime =
    completed.length > 0
      ? Math.round(completed.reduce((acc, r) => acc + (r.response_time ?? 0), 0) / completed.length)
      : 0
  const totalDataKB = Math.round(requests.reduce((acc, r) => acc + (r.response_size ?? 0), 0) / 1024)

  // ------------------------------------------------------------------
  // Filter panel helpers
  // ------------------------------------------------------------------

  /** Toggle a qualifier value in the search bar */
  const toggleFilter = (qualifier: string, value: string) => {
    setSearchQuery(q => upsertToken(q, qualifier, value))
  }

  /** Whether a filter button should appear active */
  const filterActive = (qualifier: string, value: string) =>
    isTokenActive(searchQuery, qualifier, value)

  /** Whether any qualifier token is present (for the Filter button indicator) */
  const hasActiveFilters = /(?:^|\s)-?(?:method|status|mime|ext|source|has|size|time|host|path):/i.test(searchQuery)

  // ------------------------------------------------------------------
  // Render
  // ------------------------------------------------------------------

  const maximizedRequest = maximizedId ? requests.find(r => r.id === maximizedId) ?? null : null

  return (
    <div className="flex flex-col h-full overflow-hidden relative">
      {/* Maximized detail overlay */}
      {maximizedRequest && (
        <div className="absolute inset-0 z-20 bg-neutral-950 flex flex-col">
          <DetailPanel
            request={maximizedRequest}
            onAnnotate={handleAnnotate}
            annotating={annotating}
            maximized={true}
            onMaximize={() => setMaximizedId(null)}
            onSendToGnaw={async () => {
              const req = maximizedRequest
              const hdrs = req.headers ?? {}
              const headerLines = Object.entries(hdrs)
                .filter(([k]) => k.toLowerCase() !== "host")
                .map(([k, v]) => `${k}: ${v}`)
                .join("\n")
              const rawRequest = [
                `${req.method} ${req.path} HTTP/1.1`,
                `Host: ${req.host}`,
                ...(headerLines ? [headerLines] : []),
                "",
                req.body ?? "",
              ].join("\n")
              const label = `${req.method} ${req.host}`
              const res = await apiFetch(`${API_BASE}/api/gnaw/tabs`, {
                method: "POST", headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ raw_request: rawRequest, label }),
              }).catch(() => null)
              if (res?.ok) { const tab = await res.json(); router.push(`/gnaw?tab=${tab.id}`) }
              else router.push("/gnaw")
            }}
          />
        </div>
      )}

      {/* Page header */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-neutral-800 flex-shrink-0 bg-neutral-900">
        <div className="flex items-center gap-3">
          <h1 className="text-sm font-bold text-white">Request History</h1>
          {activeProject && (
            <div className="flex items-center gap-1.5 px-2 py-0.5 bg-neutral-800 border border-neutral-700 text-xs">
              <div className="w-2 h-2 flex-shrink-0" style={{ backgroundColor: activeProject.color }} />
              <span className="text-neutral-300">{activeProject.name}</span>
            </div>
          )}
        </div>
        <div className="flex items-center gap-1">
          <Button variant="ghost" size="sm" className="h-7 text-xs text-neutral-400 hover:text-orange-400 hover:bg-transparent" onClick={fetchRequests} disabled={loading}>
            {loading ? <Loader2 className="w-3 h-3 mr-1 animate-spin" /> : <RefreshCw className="w-3 h-3 mr-1" />}
            Refresh
          </Button>
          <Button variant="ghost" size="sm" className="h-7 text-xs text-neutral-400 hover:text-orange-400 hover:bg-transparent">
            <Download className="w-3 h-3 mr-1" />
            Export
          </Button>
          <Button
            variant="ghost" size="sm"
            className="h-7 text-xs text-red-400 hover:text-red-300 hover:bg-red-900/20"
            onClick={handleClearHistory}
            disabled={clearing || totalCount === 0}
          >
            {clearing ? <Loader2 className="w-3 h-3 mr-1 animate-spin" /> : <Trash2 className="w-3 h-3 mr-1" />}
            Clear
          </Button>
        </div>
      </div>

      {/* Error banners */}
      {error && (
        <div className="bg-red-900/40 border-b border-red-700 text-red-300 px-4 py-1.5 text-xs flex-shrink-0">
          ⚠ {error}
        </div>
      )}
      {annotateError && (
        <div className="bg-yellow-900/40 border-b border-yellow-700 text-yellow-300 px-4 py-1.5 text-xs flex items-center gap-2 flex-shrink-0">
          <Sparkles className="w-3 h-3 shrink-0" />
          {annotateError}
          <button className="ml-auto text-yellow-500 hover:text-white" onClick={() => setAnnotateError(null)}>✕</button>
        </div>
      )}

      {/* Search bar */}
      <div className="flex border-b border-neutral-800 flex-shrink-0">
        <div className="relative flex-1">
          <Input
            placeholder='Search... or use qualifiers: method:GET status:4xx host:*api* mime:json -ext:js'
            value={searchQuery}
            onChange={(e) => { setSearchQuery(e.target.value); setHistoryIndex(-1) }}
            onKeyDown={(e) => {
              if (historyOpen && historySuggestions.length > 0) {
                if (e.key === "ArrowDown") { e.preventDefault(); setHistoryIndex(i => Math.min(i + 1, historySuggestions.length - 1)); return }
                if (e.key === "ArrowUp")   { e.preventDefault(); setHistoryIndex(i => Math.max(i - 1, -1)); return }
                if (e.key === "Enter") {
                  e.preventDefault()
                  if (historyIndex >= 0 && historySuggestions[historyIndex]) setSearchQuery(historySuggestions[historyIndex])
                  else if (searchQuery.trim()) pushHistory(searchQuery)
                  setHistoryOpen(false); setHistoryIndex(-1); return
                }
                if (e.key === "Escape") { setHistoryOpen(false); setHistoryIndex(-1); return }
              } else if (e.key === "Enter" && searchQuery.trim()) {
                pushHistory(searchQuery)
              }
            }}
            className="h-8 text-xs bg-neutral-900 border-0 text-white w-full rounded-none focus-visible:ring-0 font-mono placeholder:font-sans placeholder:text-neutral-600 pr-7"
          />
          {searchQuery && (
            <button
              onClick={() => { setSearchQuery(""); setHistoryOpen(false) }}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-neutral-500 hover:text-white transition-colors"
              title="Clear search"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          )}
        </div>
        <button
          onClick={() => { setHistoryOpen(v => !v); setHistoryIndex(-1) }}
          className={`h-8 px-2.5 flex items-center border-l border-neutral-800 transition-colors flex-shrink-0 ${
            historyOpen ? "bg-orange-500/20 text-orange-400" : "bg-neutral-900 text-neutral-400 hover:text-orange-400"
          }`}
          title="Search history"
        >
          <Clock className="w-3.5 h-3.5" />
        </button>
        <button
          onClick={() => setFilterOpen(v => !v)}
          className={`h-8 px-3 text-xs flex items-center gap-1.5 border-l border-neutral-800 transition-colors flex-shrink-0 ${
            filterOpen || hasActiveFilters
              ? "bg-orange-500/20 text-orange-400"
              : "bg-neutral-900 text-neutral-400 hover:text-orange-400"
          }`}
        >
          <SlidersHorizontal className="w-3 h-3" />
          Filter
          <span className={`w-1.5 h-1.5 rounded-full bg-orange-400 ml-0.5 transition-opacity ${hasActiveFilters ? "opacity-100" : "opacity-0"}`} />
        </button>
      </div>

      {/* Combined history + filter panel — capped at 45vh so table always gets ≥55% */}
      {(historyOpen || filterOpen) && (
      <div className="border-b border-neutral-800 bg-neutral-950 flex-shrink-0 overflow-y-auto" style={{ maxHeight: "45vh" }}>

          {/* ── History section ── */}
          {historyOpen && (
            <div className={filterOpen ? "border-b border-neutral-800" : ""}>
              <div className="flex items-center justify-between px-3 pt-2 pb-1">
                <div className="text-[10px] font-semibold text-neutral-500 uppercase tracking-wider">Search History</div>
                {searchHistory.length > 0 && (
                  <button
                    onClick={() => { searchHistory.forEach(e => removeHistory(e)); setHistoryOpen(false) }}
                    className="text-[10px] text-neutral-600 hover:text-orange-400 transition-colors"
                  >
                    Clear all
                  </button>
                )}
              </div>
              {historySuggestions.length === 0 ? (
                <div className="px-3 pb-2.5 text-[10px] text-neutral-600 italic">No history yet — press Enter after a search to save it</div>
              ) : (
                <div ref={historyPanelRef} className="flex flex-wrap pb-2">
                  {(() => {
                    const ROWS = 4
                    const cols: string[][] = []
                    for (let i = 0; i < historySuggestions.length; i += ROWS) cols.push(historySuggestions.slice(i, i + ROWS))
                    return cols.map((col, ci) => (
                      <div key={ci} className={`px-3 py-0.5 flex-shrink-0 ${ci < cols.length - 1 ? "border-r border-neutral-800" : ""}`}>
                        {col.map((entry, rowIdx) => {
                          const globalIdx = ci * ROWS + rowIdx
                          return (
                            <div
                              key={entry}
                              className={`flex items-center gap-2 py-0.5 cursor-pointer group rounded transition-colors ${globalIdx === historyIndex ? "bg-neutral-700/60" : ""}`}
                              onClick={() => { setSearchQuery(entry); setHistoryOpen(false); setHistoryIndex(-1) }}
                            >
                              <Clock className="w-3 h-3 flex-shrink-0 text-neutral-600" />
                              <span className="text-[11px] font-mono text-neutral-300 group-hover:text-white transition-colors truncate max-w-[200px]">{entry}</span>
                              <button
                                className="opacity-0 group-hover:opacity-100 text-neutral-500 hover:text-white transition-all ml-auto p-0.5"
                                title="Remove"
                                onClick={(e) => { e.stopPropagation(); removeHistory(entry) }}
                              >
                                <X className="w-2.5 h-2.5" />
                              </button>
                            </div>
                          )
                        })}
                      </div>
                    ))
                  })()}
                </div>
              )}
            </div>
          )}

          {/* ── Filter section ── */}
          {filterOpen && (
          <div className="flex overflow-x-auto">

          {/* ── Method col A: GET POST PUT ── */}
          <div className="px-3 py-2.5 flex-shrink-0">
            <div className="text-[10px] font-semibold text-neutral-500 uppercase tracking-wider mb-2">Method</div>
            <div className="">
              {["GET", "POST", "PUT"].map(m => (
                <button key={m} onClick={() => toggleFilter("method", m)}
                  className={`block w-full text-left text-xs font-mono px-2 py-0.5 rounded transition-colors ${filterActive("method", m) ? "bg-orange-500/20 text-orange-400" : "text-neutral-400 hover:text-orange-400 hover:bg-neutral-800"}`}>
                  {m}
                </button>
              ))}
            </div>
          </div>

          {/* ── Method col B: DELETE PATCH ── */}
          <div className="px-3 py-2.5 flex-shrink-0 border-r border-neutral-800">
            <div className="text-[10px] font-semibold text-neutral-500 uppercase tracking-wider mb-2 invisible select-none">·</div>
            <div className="">
              {["DELETE", "PATCH"].map(m => (
                <button key={m} onClick={() => toggleFilter("method", m)}
                  className={`block w-full text-left text-xs font-mono px-2 py-0.5 rounded transition-colors ${filterActive("method", m) ? "bg-orange-500/20 text-orange-400" : "text-neutral-400 hover:text-orange-400 hover:bg-neutral-800"}`}>
                  {m}
                </button>
              ))}
            </div>
          </div>

          {/* ── Status ── */}
          <div className="px-3 py-2.5 flex-shrink-0 border-r border-neutral-800">
            <div className="text-[10px] font-semibold text-neutral-500 uppercase tracking-wider mb-2">Status</div>
            <div className="">
              {[
                { value: "2xx", label: "2xx success" },
                { value: "3xx", label: "3xx redirect" },
                { value: "4xx", label: "4xx client" },
                { value: "5xx", label: "5xx server" },
              ].map(s => (
                <button key={s.value} onClick={() => toggleFilter("status", s.value)}
                  className={`block w-full text-left text-xs font-mono px-2 py-0.5 rounded transition-colors ${filterActive("status", s.value) ? "bg-orange-500/20 text-orange-400" : "text-neutral-400 hover:text-orange-400 hover:bg-neutral-800"}`}>
                  {s.label}
                </button>
              ))}
            </div>
          </div>

          {/* ── MIME col A: JSON HTML XML CSS ── */}
          <div className="px-3 py-2.5 flex-shrink-0">
            <div className="text-[10px] font-semibold text-neutral-500 uppercase tracking-wider mb-2">MIME</div>
            <div className="">
              {[
                { value: "json", label: "JSON" },
                { value: "html", label: "HTML" },
                { value: "xml",  label: "XML" },
                { value: "css",  label: "CSS" },
              ].map(m => (
                <button key={m.value} onClick={() => toggleFilter("mime", m.value)}
                  className={`block w-full text-left text-xs font-mono px-2 py-0.5 rounded transition-colors ${filterActive("mime", m.value) ? "bg-orange-500/20 text-orange-400" : "text-neutral-400 hover:text-orange-400 hover:bg-neutral-800"}`}>
                  {m.label}
                </button>
              ))}
            </div>
          </div>

          {/* ── MIME col B: JS Image Plain ── */}
          <div className="px-3 py-2.5 flex-shrink-0 border-r border-neutral-800">
            <div className="text-[10px] font-semibold text-neutral-500 uppercase tracking-wider mb-2 invisible select-none">·</div>
            <div className="">
              {[
                { value: "js",    label: "JS" },
                { value: "image", label: "Image" },
                { value: "plain", label: "Plain" },
              ].map(m => (
                <button key={m.value} onClick={() => toggleFilter("mime", m.value)}
                  className={`block w-full text-left text-xs font-mono px-2 py-0.5 rounded transition-colors ${filterActive("mime", m.value) ? "bg-orange-500/20 text-orange-400" : "text-neutral-400 hover:text-orange-400 hover:bg-neutral-800"}`}>
                  {m.label}
                </button>
              ))}
            </div>
          </div>

          {/* ── Extension col A: .js .css .html ── */}
          <div className="px-3 py-2.5 flex-shrink-0">
            <div className="text-[10px] font-semibold text-neutral-500 uppercase tracking-wider mb-2">Ext</div>
            <div className="">
              {[
                { value: "js",   label: ".js" },
                { value: "css",  label: ".css" },
                { value: "html", label: ".html" },
              ].map(e => (
                <button key={e.value} onClick={() => toggleFilter("ext", e.value)}
                  className={`block w-full text-left text-xs font-mono px-2 py-0.5 rounded transition-colors ${filterActive("ext", e.value) ? "bg-orange-500/20 text-orange-400" : "text-neutral-400 hover:text-orange-400 hover:bg-neutral-800"}`}>
                  {e.label}
                </button>
              ))}
            </div>
          </div>

          {/* ── Extension col B: .json .php .png ── */}
          <div className="px-3 py-2.5 flex-shrink-0">
            <div className="text-[10px] font-semibold text-neutral-500 uppercase tracking-wider mb-2 invisible select-none">·</div>
            <div className="">
              {[
                { value: "json", label: ".json" },
                { value: "php",  label: ".php" },
                { value: "png",  label: ".png" },
              ].map(e => (
                <button key={e.value} onClick={() => toggleFilter("ext", e.value)}
                  className={`block w-full text-left text-xs font-mono px-2 py-0.5 rounded transition-colors ${filterActive("ext", e.value) ? "bg-orange-500/20 text-orange-400" : "text-neutral-400 hover:text-orange-400 hover:bg-neutral-800"}`}>
                  {e.label}
                </button>
              ))}
            </div>
          </div>

          {/* ── Extension col C: .jpg .svg (none) ── */}
          <div className="px-3 py-2.5 flex-shrink-0 border-r border-neutral-800">
            <div className="text-[10px] font-semibold text-neutral-500 uppercase tracking-wider mb-2 invisible select-none">·</div>
            <div className="">
              {[
                { value: "jpg",  label: ".jpg" },
                { value: "svg",  label: ".svg" },
                { value: "none", label: "(none)" },
              ].map(e => (
                <button key={e.value} onClick={() => toggleFilter("ext", e.value)}
                  className={`block w-full text-left text-xs font-mono px-2 py-0.5 rounded transition-colors ${filterActive("ext", e.value) ? "bg-orange-500/20 text-orange-400" : "text-neutral-400 hover:text-orange-400 hover:bg-neutral-800"}`}>
                  {e.label}
                </button>
              ))}
            </div>
          </div>

          {/* ── Source ── */}
          <div className="px-3 py-2.5 flex-shrink-0 border-r border-neutral-800">
            <div className="text-[10px] font-semibold text-neutral-500 uppercase tracking-wider mb-2">Source</div>
            <div className="">
              {[
                { value: "proxy", label: "👤 Human" },
                { value: "test",  label: "🧪 Test" },
              ].map(s => (
                <button key={s.value} onClick={() => toggleFilter("source", s.value)}
                  className={`block w-full text-left text-xs px-2 py-0.5 rounded transition-colors ${filterActive("source", s.value) ? "bg-orange-500/20 text-orange-400" : "text-neutral-400 hover:text-orange-400 hover:bg-neutral-800"}`}>
                  {s.label}
                </button>
              ))}
            </div>
          </div>

          {/* ── Reset + Query Reference ── */}
          <div className="flex-1 flex flex-col px-3 py-2.5 min-w-[220px] border-l border-neutral-800">
            <div className="flex items-center justify-between mb-2">
              <div className="text-[10px] font-semibold text-neutral-500 uppercase tracking-wider">Query Reference</div>
              <button
                onClick={() => setSearchQuery(q => q.replace(/(-?(?:method|status|mime|ext|source|has|size|time|host|path):[^\s]*\s*)/gi, "").trim())}
                className="text-[10px] text-neutral-600 hover:text-orange-400 transition-colors"
              >
                Reset filters
              </button>
            </div>
            {(() => {
              const rows: [string, string][] = [
                ["method:GET,POST",  "HTTP method"],
                ["status:4xx,5xx",   "Status range"],
                ["host:*api*",       "Host glob"],
                ["path:/v2/*",       "Path glob"],
                ["mime:json",        "MIME type"],
                ["ext:js,css",       "File ext"],
                ["source:human",     "Traffic source"],
                ["has:annotation",   "Has AI note"],
                ["has:body",         "Has body"],
                ["size:>10kb",       "Response size"],
                ["time:>500",        "Response ms"],
                ["-ext:js,css",      "Negate with -"],
              ]
              const half = Math.ceil(rows.length / 2)
              const col1 = rows.slice(0, half)
              const col2 = rows.slice(half)
              // Check if all values in an example token are active in the current query
              const isRefActive = (example: string): boolean => {
                const stripped = example.startsWith("-") ? example.slice(1) : example
                const colonIdx = stripped.indexOf(":")
                if (colonIdx === -1) return searchQuery.includes(stripped)
                const qualifier = stripped.slice(0, colonIdx)
                const values = stripped.slice(colonIdx + 1).split(",").map(v => v.trim()).filter(Boolean)
                return values.every(v => isTokenActive(searchQuery, qualifier, v))
              }

              const renderCol = (items: [string, string][], onClick: (example: string) => void) => (
                <div className="flex flex-col gap-0.5">
                  {items.map(([example, desc]) => {
                    const active = isRefActive(example)
                    return (
                      <button
                        key={example}
                        onClick={() => onClick(example)}
                        className="flex items-baseline gap-0 text-left group"
                        title={`Toggle: ${example}`}
                      >
                        <span className={`font-mono text-[10px] transition-colors whitespace-nowrap w-36 shrink-0 ${active ? "text-orange-400" : "text-orange-400/50 group-hover:text-orange-400"}`}>{example}</span>
                        <span className={`text-[10px] whitespace-nowrap ${active ? "text-neutral-400" : "text-neutral-600"}`}>{desc}</span>
                      </button>
                    )
                  })}
                </div>
              )
              // Click handler: parse "qualifier:value" from the example string and toggle it
              const handleRefClick = (example: string) => {
                // Strip leading - for negation detection
                const negated = example.startsWith("-")
                const stripped = negated ? example.slice(1) : example
                const colonIdx = stripped.indexOf(":")
                if (colonIdx === -1) {
                  // No qualifier — treat as free text toggle
                  setSearchQuery(q => {
                    const term = stripped.trim()
                    if (q.includes(term)) return q.replace(term, "").replace(/\s{2,}/g, " ").trim()
                    return q.trim() ? `${q.trim()} ${term}` : term
                  })
                  return
                }
                const qualifier = stripped.slice(0, colonIdx)
                const values = stripped.slice(colonIdx + 1).split(",").map(v => v.trim()).filter(Boolean)
                setSearchQuery(q => {
                  let next = q
                  for (const v of values) next = upsertToken(next, qualifier, v, negated)
                  return next
                })
              }

              return (
                <div className="flex gap-4">
                  {renderCol(col1, handleRefClick)}
                  {renderCol(col2, handleRefClick)}
                </div>
              )
            })()}
          </div>

          </div>
          )}

      </div>
      )}

      {/* Stats + pagination bar */}
      <div className="flex items-center border-b border-neutral-800 text-xs flex-shrink-0 bg-neutral-900">
        <div className="flex items-center flex-1">
          {[
            { label: "Requests", value: totalRequests, color: "text-white" },
            { label: "Success", value: `${successRate}%`, color: "text-green-400" },
            { label: "Avg", value: `${avgResponseTime}ms`, color: "text-blue-400" },
            { label: "Data", value: `${totalDataKB}KB`, color: "text-purple-400" },
          ].map((stat, i) => (
            <div key={i} className={`flex items-center gap-1.5 px-3 py-1.5 ${i > 0 ? "border-l border-neutral-800" : ""}`}>
              <span className="text-neutral-500">{stat.label}:</span>
              <span className={`font-mono font-semibold ${stat.color}`}>{stat.value}</span>
            </div>
          ))}
        </div>
        {filteredTotal > 0 && (
          <div className="flex items-center gap-1.5 px-3 py-1 border-l border-neutral-800 flex-shrink-0">
            <span className="text-neutral-400 whitespace-nowrap">
              {((page - 1) * pageSize) + 1}–{Math.min(page * pageSize, filteredTotal)} of {filteredTotal}{filteredTotal < totalCount ? ` (${totalCount} total)` : ""}
            </span>
            <span className="text-neutral-700">|</span>
            <Select value={String(pageSize)} onValueChange={(v) => setPageSize(Number(v))}>
              <SelectTrigger className="h-6 w-16 bg-neutral-800 border-neutral-700 text-white text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent className="bg-neutral-800 border-neutral-600">
                <SelectItem value="25">25</SelectItem>
                <SelectItem value="50">50</SelectItem>
                <SelectItem value="100">100</SelectItem>
                <SelectItem value="200">200</SelectItem>
              </SelectContent>
            </Select>
            <Button variant="ghost" size="icon" className="h-6 w-6 text-neutral-400 hover:text-white disabled:opacity-30" disabled={!canPrev} onClick={() => setPage((p) => p - 1)}>
              <ChevronLeft className="w-3 h-3" />
            </Button>
            <span className="text-neutral-400 whitespace-nowrap">p{page}/{totalPages}</span>
            <Button variant="ghost" size="icon" className="h-6 w-6 text-neutral-400 hover:text-white disabled:opacity-30" disabled={!canNext} onClick={() => setPage((p) => p + 1)}>
              <ChevronRight className="w-3 h-3" />
            </Button>
          </div>
        )}
      </div>

      {/* Request Table */}
      <div className="flex flex-col flex-1 min-h-0">
        <div className="flex flex-col flex-1 overflow-hidden">
          {loading && requests.length === 0 ? (
            <div className="flex items-center justify-center py-16 text-neutral-500">
              <Loader2 className="w-6 h-6 animate-spin mr-2" />
              Loading requests...
            </div>
          ) : table.getRowModel().rows.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-16 text-neutral-500 space-y-4">
              <div className="text-center">
                No requests captured yet. Configure your browser to use proxy{" "}
                <span className="font-mono text-orange-400 mx-1">127.0.0.1:1337</span>.
              </div>
              <div className="flex gap-2">
                <Button
                  variant="outline" size="sm"
                  className="text-xs font-mono border-neutral-700 hover:bg-neutral-700"
                  onClick={() => {
                    navigator.clipboard.writeText("curl -x http://127.0.0.1:1337 http://ifconfig.me").catch(() => {})
                  }}
                >
                  <Copy className="w-3 h-3 mr-2" /> Copy curl test
                </Button>
                <Button
                  variant="outline" size="sm"
                  className="text-xs font-mono border-neutral-700 hover:bg-neutral-700"
                  onClick={() => {
                    navigator.clipboard.writeText("import httpx\nproxies = {'http://': 'http://127.0.0.1:1337', 'https://': 'http://127.0.0.1:1337'}\nresp = httpx.get('http://ifconfig.me', proxies=proxies)\nprint(resp.text)").catch(() => {})
                  }}
                >
                  <Copy className="w-3 h-3 mr-2" /> Copy httpx test
                </Button>
              </div>
            </div>
          ) : (
            <div className="overflow-y-auto flex-1 min-w-0">
              <table className="w-full table-fixed text-sm">
                <colgroup>
                  {table.getAllColumns().map((col) => (
                    col.id === "url"
                      ? <col key={col.id} />
                      : <col key={col.id} style={{ width: col.getSize() }} />
                  ))}
                </colgroup>
                <thead className="sticky top-0 z-10 bg-neutral-800">
                  {table.getHeaderGroups().map((headerGroup) => (
                    <tr key={headerGroup.id} className="border-b border-neutral-700">
                      {headerGroup.headers.map((header) => (
                        <th
                          key={header.id}
                          className="text-left px-3 py-2 text-neutral-400 font-medium select-none"
                        >
                          {header.isPlaceholder ? null : (
                            <div
                              className={`flex items-center gap-1 ${header.column.getCanSort() ? "cursor-pointer hover:text-white" : ""}`}
                              onClick={header.column.getToggleSortingHandler()}
                            >
                              {flexRender(header.column.columnDef.header, header.getContext())}
                              {header.column.getCanSort() && (
                                header.column.getIsSorted() === "asc" ? <ChevronUp className="w-3 h-3" /> :
                                header.column.getIsSorted() === "desc" ? <ChevronDown className="w-3 h-3" /> :
                                <ChevronsUpDown className="w-3 h-3 opacity-40" />
                              )}
                            </div>
                          )}
                        </th>
                      ))}
                    </tr>
                  ))}
                </thead>
                <tbody>
                  {table.getRowModel().rows.map((row) => {
                    const isExpanded = expandedIds.has(row.original.id)
                    const req = row.original
                    const sendReqToGnaw = async () => {
                      const hdrs = req.headers ?? {}
                      const headerLines = Object.entries(hdrs)
                        .filter(([k]) => k.toLowerCase() !== "host")
                        .map(([k, v]) => `${k}: ${v}`)
                        .join("\n")
                      const rawRequest = [
                        `${req.method} ${req.path} HTTP/1.1`,
                        `Host: ${req.host}`,
                        ...(headerLines ? [headerLines] : []),
                        "",
                        req.body ?? "",
                      ].join("\n")
                      const label = `${req.method} ${req.host}`
                      const res = await apiFetch(`${API_BASE}/api/gnaw/tabs`, {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({ raw_request: rawRequest, label }),
                      }).catch(() => null)
                      if (res?.ok) { const tab = await res.json(); router.push(`/gnaw?tab=${tab.id}`) }
                      else router.push("/gnaw")
                    }
                    return (
                      <React.Fragment key={row.id}>
                        <tr
                          className={`border-b border-neutral-700 hover:bg-neutral-700/50 cursor-pointer transition-colors ${isExpanded ? "bg-neutral-700/70" : ""} ${highlightedIds.get(req.id) ?? ""}`}
                          onClick={() => toggleExpanded(req.id)}
                          onContextMenu={(e) => {
                            e.preventDefault()
                            setContextMenu({ x: e.clientX, y: e.clientY, req })
                          }}
                        >
                          {row.getVisibleCells().map((cell) => (
                            <td key={cell.id} className="px-3 py-2 overflow-hidden">
                              {flexRender(cell.column.columnDef.cell, cell.getContext())}
                            </td>
                          ))}
                        </tr>
                        {isExpanded && (
                          <DetailPanel
                            request={req}
                            onAnnotate={handleAnnotate}
                            annotating={annotating}
                            maximized={false}
                            onMaximize={() => { setMaximizedId(req.id) }}
                            onSendToGnaw={sendReqToGnaw}
                          />
                        )}
                      </React.Fragment>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>

      {/* Right-click context menu */}
      {contextMenu && (() => {
        const req = contextMenu.req
        const isHighlighted = highlightedIds.has(req.id)

        const buildRawRequest = (r: ApiRequest) => {
          const hdrs = r.headers ?? {}
          const headerLines = Object.entries(hdrs)
            .filter(([k]) => k.toLowerCase() !== "host")
            .map(([k, v]) => `${k}: ${v}`)
            .join("\n")
          return [
            `${r.method} ${r.path} HTTP/1.1`,
            `Host: ${r.host}`,
            ...(headerLines ? [headerLines] : []),
            "",
            r.body ?? "",
          ].join("\n")
        }

        const sendToGnaw = async (r: ApiRequest) => {
          const res = await apiFetch(`${API_BASE}/api/gnaw/tabs`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ raw_request: buildRawRequest(r), label: `${r.method} ${r.host}` }),
          }).catch(() => null)
          if (res?.ok) { const tab = await res.json(); router.push(`/gnaw?tab=${tab.id}`) }
          else router.push("/gnaw")
        }

        type MenuItem =
          | { type: "item"; Icon: React.ElementType; label: string; action: () => void; danger?: boolean }
          | { type: "separator" }

        const groups: MenuItem[][] = [
          // Group 1 — Inspect
          [
            {
              type: "item",
              Icon: Eye,
              label: "View Details",
              action: () => { toggleExpanded(req.id); setContextMenu(null) },
            },
            {
              type: "item",
              Icon: Maximize2,
              label: "Open Maximized",
              action: () => { setMaximizedId(req.id); setContextMenu(null) },
            },
          ],
          // Group 2 — Send / Replay
          [
            {
              type: "item",
              Icon: RefreshCw,
              label: "Send to Gnaw",
              action: async () => { await sendToGnaw(req); setContextMenu(null) },
            },
            {
              type: "item",
              Icon: MessageSquare,
              label: "Send to Chat",
              action: () => { router.push(`/chat?requestId=${req.id}&method=${req.method}&url=${encodeURIComponent(req.url)}`); setContextMenu(null) },
            },
            {
              type: "item",
              Icon: Zap,
              label: "Send to Snare",
              action: () => { router.push(`/snare?url=${encodeURIComponent(req.url)}&method=${req.method}`); setContextMenu(null) },
            },
          ],
          // Group 3 — Copy
          [
            {
              type: "item",
              Icon: Link,
              label: "Copy URL",
              action: () => { navigator.clipboard.writeText(req.url).catch(() => {}); setContextMenu(null) },
            },
            {
              type: "item",
              Icon: Terminal,
              label: "Copy as cURL",
              action: () => {
                const headers = Object.entries(req.headers ?? {}).map(([k, v]) => `-H '${k}: ${v}'`).join(" ")
                const body = req.body ? `--data '${req.body}'` : ""
                navigator.clipboard.writeText(`curl -X ${req.method} '${req.url}' ${headers} ${body}`.trim()).catch(() => {})
                setContextMenu(null)
              },
            },
            {
              type: "item",
              Icon: Code2,
              label: "Copy as Python (httpx)",
              action: () => {
                const headers = JSON.stringify(req.headers ?? {})
                const body = req.body ? `, content=b'${req.body}'` : ""
                navigator.clipboard.writeText(`httpx.request('${req.method}', '${req.url}', headers=${headers}${body})`).catch(() => {})
                setContextMenu(null)
              },
            },
          ],
          // Group 4 — Filter / Highlight
          [
            {
              type: "item",
              Icon: Filter,
              label: `Filter by Host: ${req.host}`,
              action: () => { setSearchQuery(q => upsertToken(q, "host", req.host)); setContextMenu(null) },
            },
            {
              type: "item",
              Icon: isHighlighted ? X : Highlighter,
              label: isHighlighted ? "Remove Highlight" : "Highlight Row",
              action: () => {
                setHighlightedIds(prev => {
                  const next = new Map(prev)
                  if (next.has(req.id)) next.delete(req.id)
                  else next.set(req.id, "bg-yellow-900/30")
                  return next
                })
                setContextMenu(null)
              },
            },
          ],
        ]

        const allItems: MenuItem[] = groups.reduce<MenuItem[]>((acc, group, i) => {
          if (i > 0) acc.push({ type: "separator" })
          return acc.concat(group)
        }, [])

        return (
          <div
            className="fixed z-50 bg-neutral-800 border border-neutral-700 rounded-lg shadow-2xl py-1 min-w-[220px]"
            style={{ top: contextMenu.y, left: contextMenu.x }}
            onClick={(e) => e.stopPropagation()}
          >
            {allItems.map((item, i) =>
              item.type === "separator" ? (
                <div key={`sep-${i}`} className="my-1 border-t border-neutral-700" />
              ) : (
                <button
                  key={item.label}
                  onClick={item.action}
                  className="w-full text-left px-3 py-2 flex items-center gap-3 text-neutral-400 hover:text-white hover:bg-neutral-700 transition-colors text-sm"
                >
                  <item.Icon className="w-4 h-4 flex-shrink-0" />
                  <span className="font-medium">{item.label}</span>
                </button>
              )
            )}
          </div>
        )
      })()}
    </div>
  )
}
