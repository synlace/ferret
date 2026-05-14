"use client"

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
} from "lucide-react"
import { useProject } from "../context/project-context"
import {
  ApiRequest, DetailPanel,
  getStatusColor, getMethodColor, formatTime,
} from "./DetailPanel"

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
  const [globalFilter, setGlobalFilter] = useState("")
  const [methodFilters, setMethodFilters] = useState<Set<string>>(new Set())
  const [statusFilters, setStatusFilters] = useState<Set<string>>(new Set())
  const [sourceFilters, setSourceFilters] = useState<Set<string>>(new Set())
  const [filterOpen, setFilterOpen] = useState(false)
  const filterRef = useRef<HTMLDivElement>(null)

  // Close filter popup on outside click
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (filterRef.current && !filterRef.current.contains(e.target as Node)) {
        setFilterOpen(false)
      }
    }
    document.addEventListener("mousedown", handler)
    return () => document.removeEventListener("mousedown", handler)
  }, [])

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

  // Close context menu on outside click
  useEffect(() => {
    const close = () => setContextMenu(null)
    document.addEventListener("click", close)
    return () => document.removeEventListener("click", close)
  }, [])

  // Fetch test files to know which hosts have tests
  useEffect(() => {
    fetch(`${API_BASE}/api/tests/files?project_id=${activeProjectId}`)
      .then(r => r.ok ? r.json() : { files: [] })
      .then((data: { files?: Array<{ host: string }> }) => {
        const files = data.files ?? (Array.isArray(data) ? data : [])
        setHostsWithTests(new Set((files as Array<{ host: string }>).map(f => f.host)))
      })
      .catch(() => {})
  }, [activeProjectId])

  // ------------------------------------------------------------------
  // Data fetching
  // ------------------------------------------------------------------

  const fetchRequests = useCallback(async () => {
    try {
      const params = new URLSearchParams({ limit: "10000", offset: "0" })
      if (globalFilter.trim()) params.set("search", globalFilter.trim())
      params.set("project_id", activeProjectId)

      const res = await fetch(`${API_BASE}/api/requests?${params}`)
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
  }, [globalFilter, activeProjectId])

  // Reset to page 1 whenever filters or page size change
  useEffect(() => {
    setPage(1)
  }, [methodFilters, globalFilter, statusFilters, sourceFilters, pageSize, activeProjectId])

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
          // Only show requests belonging to the active project.
          // The backend broadcasts all requests; filter client-side.
          setRequests((prev) => {
            const exists = prev.some((r) => r.id === msg.data.id)
            if (exists) {
              // Update existing row (e.g. response arrived after request was stored)
              return prev.map((r) => r.id === msg.data.id ? msg.data : r)
            }
            // Prepend new row and keep the page-size cap so the table doesn't grow unbounded
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
  // Re-connect when the active project or page size changes so the filter stays correct
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
      const res = await fetch(`${API_BASE}/api/requests/${req.id}/annotate`, { method: "POST" })
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
      const res = await fetch(`${API_BASE}/api/requests`, { method: "DELETE" })
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
  // Client-side status filter
  // ------------------------------------------------------------------

  const statusFilteredData = useMemo(() => {
    return requests.filter((req) => {
      if (methodFilters.size > 0 && !methodFilters.has(req.method)) return false
      if (sourceFilters.size > 0 && !sourceFilters.has(req.source)) return false
      if (statusFilters.size > 0) {
        const sc = req.status_code ?? 0
        const inRange = (
          (statusFilters.has("2xx") && sc >= 200 && sc < 300) ||
          (statusFilters.has("3xx") && sc >= 300 && sc < 400) ||
          (statusFilters.has("4xx") && sc >= 400 && sc < 500) ||
          (statusFilters.has("5xx") && sc >= 500)
        )
        if (!inRange) return false
      }
      return true
    })
  }, [requests, methodFilters, sourceFilters, statusFilters])

  // ------------------------------------------------------------------
  // Sorting + pagination (fully client-side, against filtered data)
  // ------------------------------------------------------------------

  // Sort the full filtered dataset so pagination is consistent across pages
  const sortedFilteredData = useMemo(() => {
    if (sorting.length === 0) return statusFilteredData
    const [{ id, desc }] = sorting

    // Derived value extractors for display columns that have no direct field
    const derivedValue = (req: ApiRequest): unknown => {
      if (id === "annotated") return req.annotation ? 1 : 0
      if (id === "params") {
        const hasQuery = (() => { try { return new URL(req.url).search.length > 1 } catch { return false } })()
        return (hasQuery || !!(req.body && req.body.trim().length > 0)) ? 1 : 0
      }
      if (id === "has_tests") return hostsWithTests.has(req.host) ? 1 : 0
      return (req as unknown as Record<string, unknown>)[id]
    }

    return [...statusFilteredData].sort((a, b) => {
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
  }, [statusFilteredData, sorting, hostsWithTests])

  const filteredTotal = sortedFilteredData.length
  const totalPages = Math.max(1, Math.ceil(filteredTotal / pageSize))
  const canPrev = page > 1
  const canNext = page < totalPages

  // Slice for the current page
  const pagedData = useMemo(() => {
    const start = (page - 1) * pageSize
    return sortedFilteredData.slice(start, start + pageSize)
  }, [sortedFilteredData, page, pageSize])

  const table = useReactTable({
    data: pagedData,
    columns,
    state: { sorting, columnFilters, globalFilter },
    onSortingChange: (updater) => {
      setSorting(updater)
      setPage(1)
    },
    onColumnFiltersChange: setColumnFilters,
    onGlobalFilterChange: setGlobalFilter,
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
              const res = await fetch(`${API_BASE}/api/gnaw/tabs`, {
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
          <Button variant="ghost" size="sm" className="h-7 text-xs text-neutral-400 hover:text-white" onClick={fetchRequests} disabled={loading}>
            {loading ? <Loader2 className="w-3 h-3 mr-1 animate-spin" /> : <RefreshCw className="w-3 h-3 mr-1" />}
            Refresh
          </Button>
          <Button variant="ghost" size="sm" className="h-7 text-xs text-neutral-400 hover:text-white">
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

      {/* Search and Filters */}
      <div className="flex border-b border-neutral-800 flex-shrink-0 relative" ref={filterRef}>
        <Input
          placeholder="Search…"
          value={globalFilter}
          onChange={(e) => setGlobalFilter(e.target.value)}
          className="h-8 text-xs bg-neutral-900 border-0 border-r border-neutral-800 text-white flex-1 rounded-none focus-visible:ring-0"
        />
        <button
          onClick={() => setFilterOpen(v => !v)}
          className={`h-8 px-3 text-xs flex items-center gap-1.5 border-l border-neutral-800 transition-colors ${
            filterOpen || methodFilters.size > 0 || statusFilters.size > 0 || sourceFilters.size > 0
              ? "bg-orange-500/20 text-orange-400"
              : "bg-neutral-900 text-neutral-400 hover:text-white"
          }`}
        >
          <SlidersHorizontal className="w-3 h-3" />
          Filter
          {(methodFilters.size > 0 || statusFilters.size > 0 || sourceFilters.size > 0) && (
            <span className="w-1.5 h-1.5 rounded-full bg-orange-400 ml-0.5" />
          )}
        </button>

        {/* Filter popup */}
        {filterOpen && (
          <div className="absolute top-full right-0 z-30 bg-neutral-900 border border-neutral-700 shadow-2xl w-[480px]">
            <div className="flex items-center justify-between px-3 py-2 border-b border-neutral-800">
              <span className="text-xs font-semibold text-neutral-300">Filters</span>
              <button
                onClick={() => { setMethodFilters(new Set()); setStatusFilters(new Set()); setSourceFilters(new Set()) }}
                className="text-xs text-neutral-500 hover:text-orange-400"
              >
                Reset all
              </button>
            </div>
            <div className="grid grid-cols-3 divide-x divide-neutral-800">
              {/* Method */}
              <div className="p-3">
                <div className="text-[10px] font-semibold text-neutral-500 uppercase tracking-wider mb-2">Method</div>
                {["GET", "POST", "PUT", "DELETE", "PATCH"].map(m => (
                  <label key={m} className="flex items-center gap-2 py-0.5 cursor-pointer group">
                    <input
                      type="checkbox"
                      checked={methodFilters.has(m)}
                      onChange={() => setMethodFilters(prev => {
                        const next = new Set(prev)
                        next.has(m) ? next.delete(m) : next.add(m)
                        return next
                      })}
                      className="accent-orange-500"
                    />
                    <span className={`text-xs ${methodFilters.has(m) ? "text-orange-400" : "text-neutral-300 group-hover:text-white"}`}>{m}</span>
                  </label>
                ))}
              </div>
              {/* Status */}
              <div className="p-3">
                <div className="text-[10px] font-semibold text-neutral-500 uppercase tracking-wider mb-2">Status</div>
                {[
                  { value: "2xx", label: "2xx  [success]" },
                  { value: "3xx", label: "3xx  [redirect]" },
                  { value: "4xx", label: "4xx  [client error]" },
                  { value: "5xx", label: "5xx  [server error]" },
                ].map(s => (
                  <label key={s.value} className="flex items-center gap-2 py-0.5 cursor-pointer group">
                    <input
                      type="checkbox"
                      checked={statusFilters.has(s.value)}
                      onChange={() => setStatusFilters(prev => {
                        const next = new Set(prev)
                        next.has(s.value) ? next.delete(s.value) : next.add(s.value)
                        return next
                      })}
                      className="accent-orange-500"
                    />
                    <span className={`text-xs font-mono ${statusFilters.has(s.value) ? "text-orange-400" : "text-neutral-300 group-hover:text-white"}`}>{s.label}</span>
                  </label>
                ))}
              </div>
              {/* Source */}
              <div className="p-3">
                <div className="text-[10px] font-semibold text-neutral-500 uppercase tracking-wider mb-2">Source</div>
                {[
                  { value: "proxy", label: "👤 Human" },
                  { value: "test", label: "🧪 Test" },
                ].map(s => (
                  <label key={s.value} className="flex items-center gap-2 py-0.5 cursor-pointer group">
                    <input
                      type="checkbox"
                      checked={sourceFilters.has(s.value)}
                      onChange={() => setSourceFilters(prev => {
                        const next = new Set(prev)
                        next.has(s.value) ? next.delete(s.value) : next.add(s.value)
                        return next
                      })}
                      className="accent-orange-500"
                    />
                    <span className={`text-xs ${sourceFilters.has(s.value) ? "text-orange-400" : "text-neutral-300 group-hover:text-white"}`}>{s.label}</span>
                  </label>
                ))}
              </div>
            </div>
          </div>
        )}
      </div>

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
              Loading requests…
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
                      const res = await fetch(`${API_BASE}/api/gnaw/tabs`, {
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
      {contextMenu && (
        <div
          className="fixed z-50 bg-neutral-800 border border-neutral-700 rounded-lg shadow-2xl py-1 min-w-[200px] text-sm"
          style={{ top: contextMenu.y, left: contextMenu.x }}
          onClick={(e) => e.stopPropagation()}
        >
          {[
            {
              icon: "👁",
              label: "View Details",
              action: () => { toggleExpanded(contextMenu.req.id); setContextMenu(null) }
            },
            {
              icon: "🔁",
              label: "Send to Gnaw",
              action: async () => {
                const req = contextMenu.req
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
                const res = await fetch(`${API_BASE}/api/gnaw/tabs`, {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ raw_request: rawRequest, label }),
                }).catch(() => null)
                if (res?.ok) {
                  const tab = await res.json()
                  router.push(`/gnaw?tab=${tab.id}`)
                } else {
                  router.push("/gnaw")
                }
                setContextMenu(null)
              }
            },
            {
              icon: "💬",
              label: "Send to Chat",
              action: () => { router.push(`/chat?requestId=${contextMenu.req.id}&method=${contextMenu.req.method}&url=${encodeURIComponent(contextMenu.req.url)}`); setContextMenu(null) }
            },
            {
              icon: "📋",
              label: "Copy as cURL",
              action: () => {
                const req = contextMenu.req
                const headers = Object.entries(req.headers ?? {}).map(([k, v]) => `-H '${k}: ${v}'`).join(" ")
                const body = req.body ? `--data '${req.body}'` : ""
                navigator.clipboard.writeText(`curl -X ${req.method} '${req.url}' ${headers} ${body}`.trim()).catch(() => {})
                setContextMenu(null)
              }
            },
            {
              icon: "🐍",
              label: "Copy as httpx",
              action: () => {
                const req = contextMenu.req
                const headers = JSON.stringify(req.headers ?? {})
                const body = req.body ? `, content=b'${req.body}'` : ""
                navigator.clipboard.writeText(`httpx.request('${req.method}', '${req.url}', headers=${headers}${body})`).catch(() => {})
                setContextMenu(null)
              }
            },
            {
              icon: "🎨",
              label: highlightedIds.has(contextMenu.req.id) ? "Remove Highlight" : "Highlight Row",
              action: () => {
                setHighlightedIds(prev => {
                  const next = new Map(prev)
                  if (next.has(contextMenu.req.id)) next.delete(contextMenu.req.id)
                  else next.set(contextMenu.req.id, "bg-yellow-900/30")
                  return next
                })
                setContextMenu(null)
              }
            },
          ].map((item) => (
            <button
              key={item.label}
              onClick={item.action}
              className="w-full text-left px-4 py-2 hover:bg-neutral-700 flex items-center gap-3 text-neutral-200"
            >
              <span>{item.icon}</span>
              <span>{item.label}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
