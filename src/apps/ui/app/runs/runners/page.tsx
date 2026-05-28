"use client"

import { apiFetch } from "@/lib/api-fetch"
import React, { useState, useEffect, useCallback, useRef } from "react"
import {
  Key, Plus, Trash2, Cpu, Check, Copy, RefreshCw, Loader2, X, AlertCircle, History, Download, Search, Terminal, ChevronDown, ChevronRight, Folder
} from "lucide-react"
import { useProject } from "../../context/project-context"

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000"

const LIST_WIDTH_KEY = "ferret_runners_list_width"
const DEFAULT_LIST_WIDTH = 240
const MIN_LIST_WIDTH = 160
const MAX_LIST_WIDTH = 400

interface RunnerKey {
  key: string
  name: string
  status: string
}

interface ActiveRunner {
  id: string
  url: string | null
  status: string
  last_heartbeat: string
  logs: string | null
}

interface Run {
  id: string
  workspace_id: string
  project_id: string
  plan_id: string
  target_url: string
  status: "pending" | "running" | "done" | "error"
  exit_code: number | null
  run_log_path: string | null
  started_at: string | null
  finished_at: string | null
  created_at: string
  runner_id: string | null
}

interface Den {
  id: string
  name: string
  den_type: string
}

function formatDuration(startedAt: string | null, finishedAt: string | null): string {
  if (!startedAt) return "—"
  const start = new Date(startedAt).getTime()
  const end = finishedAt ? new Date(finishedAt).getTime() : Date.now()
  const ms = end - start
  if (ms < 1000) return `${ms}ms`
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`
  return `${Math.floor(ms / 60000)}m ${Math.floor((ms % 60000) / 1000)}s`
}

function getRunnerDenId(runnerId: string): string {
  if (runnerId.startsWith("runner-fargate-")) {
    const parts = runnerId.split("-");
    if (parts.length >= 4) {
      return parts[2];
    }
  }
  return "local";
}

function parseUtcDate(ts: string): Date {
  if (!ts.endsWith("Z") && !ts.includes("+")) {
    return new Date(ts + "Z")
  }
  return new Date(ts)
}

// ---------------------------------------------------------------------------
// Deep Hook Module: useRunnersSync (Encapsulates Data Synchronization)
// ---------------------------------------------------------------------------
function useRunnersSync(activeProjectId: string | undefined) {
  const [keys, setKeys] = useState<RunnerKey[]>([])
  const [runners, setRunners] = useState<ActiveRunner[]>([])
  const [runs, setRuns] = useState<Run[]>([])
  const [dens, setDens] = useState<Den[]>([])

  const [loadingKeys, setLoadingKeys] = useState(true)
  const [loadingRunners, setLoadingRunners] = useState(true)
  const [refreshing, setRefreshing] = useState(false)

  const [keysError, setKeysError] = useState<string | null>(null)
  const [runnersError, setRunnersError] = useState<string | null>(null)

  const fetchKeys = useCallback(async () => {
    setKeysError(null)
    try {
      const res = await apiFetch(`${API_BASE}/api/runners/keys`)
      if (res.ok) {
        setKeys(await res.json())
      } else {
        const errBody = await res.json().catch(() => ({}))
        setKeysError(errBody.detail ?? "Failed to load security keys")
      }
    } catch (e: any) {
      console.error("Failed to fetch runner keys", e)
      setKeysError("Failed to connect to keys API")
    } finally {
      setLoadingKeys(false)
    }
  }, [])

  const fetchRunners = useCallback(async () => {
    setRunnersError(null)
    try {
      const res = await apiFetch(`${API_BASE}/api/runners`)
      if (res.ok) {
        setRunners(await res.json())
      } else {
        const errBody = await res.json().catch(() => ({}))
        setRunnersError(errBody.detail ?? "Failed to load active agents")
      }
    } catch (e: any) {
      console.error("Failed to fetch runners", e)
      setRunnersError("Failed to connect to agents API")
    } finally {
      setLoadingRunners(false)
    }
  }, [])

  const fetchRuns = useCallback(async () => {
    if (!activeProjectId) return
    try {
      const res = await apiFetch(`${API_BASE}/api/runs?project_id=${activeProjectId}`)
      if (res.ok) {
        const data = await res.json()
        setRuns(Array.isArray(data) ? data : [])
      }
    } catch (e) {
      console.error("Failed to fetch runs", e)
    }
  }, [activeProjectId])

  const fetchDens = useCallback(async () => {
    try {
      const res = await apiFetch(`${API_BASE}/api/settings/dens`)
      if (res.ok) {
        setDens(await res.json())
      }
    } catch (e) {
      console.error("Failed to fetch dens", e)
    }
  }, [])

  const handleRefresh = async () => {
    setRefreshing(true)
    await Promise.all([fetchKeys(), fetchRunners(), fetchRuns(), fetchDens()])
    setRefreshing(false)
  }

  // Handle Visibility API to pause polling when tab is inactive
  useEffect(() => {
    fetchKeys()
    fetchRunners()
    fetchRuns()
    fetchDens()

    let intervalId: NodeJS.Timeout | null = null

    const startPolling = () => {
      if (intervalId) return
      intervalId = setInterval(fetchRunners, 4000)
    }

    const stopPolling = () => {
      if (intervalId) {
        clearInterval(intervalId)
        intervalId = null
      }
    }

    const handleVisibilityChange = () => {
      if (document.hidden) {
        stopPolling()
      } else {
        startPolling()
      }
    }

    // Start polling by default if visible
    if (!document.hidden) {
      startPolling()
    }

    document.addEventListener("visibilitychange", handleVisibilityChange)

    return () => {
      stopPolling()
      document.removeEventListener("visibilitychange", handleVisibilityChange)
    }
  }, [fetchKeys, fetchRunners, fetchRuns, fetchDens])

  // Prevent race conditions when activeProjectId changes
  useEffect(() => {
    let active = true
    const loadRuns = async () => {
      if (!activeProjectId) return
      try {
        const res = await apiFetch(`${API_BASE}/api/runs?project_id=${activeProjectId}`)
        if (res.ok && active) {
          const data = await res.json()
          setRuns(Array.isArray(data) ? data : [])
        }
      } catch (e) {
        console.error("Failed to fetch runs on project change", e)
      }
    }
    loadRuns()
    return () => {
      active = false
    }
  }, [activeProjectId])

  return {
    keys,
    setKeys,
    runners,
    runs,
    dens,
    loadingKeys,
    loadingRunners,
    refreshing,
    keysError,
    runnersError,
    fetchKeys,
    handleRefresh,
  }
}

export default function RunnersPage() {
  const { activeProjectId } = useProject()
  const {
    keys,
    setKeys,
    runners,
    runs,
    dens,
    loadingKeys,
    loadingRunners,
    refreshing,
    keysError,
    runnersError,
    fetchKeys,
    handleRefresh,
  } = useRunnersSync(activeProjectId)

  const [searchQuery, setSearchQuery] = useState("")
  const [expandedDens, setExpandedDens] = useState<Record<string, boolean>>({})

  const toggleDen = (denId: string) => {
    setExpandedDens(prev => {
      const current = prev[denId] ?? true
      return {
        ...prev,
        [denId]: !current
      }
    })
  }

  // Sidebar selection: either "keys" or a runner ID
  const [selectedItem, setSelectedItem] = useState<string | "keys">("keys")

  const [showCreateModal, setShowCreateModal] = useState(false)
  const [newKeyName, setNewName] = useState("")
  const [createdKey, setCreatedKey] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const [createError, setCreateError] = useState<string | null>(null)
  const [copiedKey, setCopiedKey] = useState(false)
  const [copiedLogs, setCopiedLogs] = useState(false)
  const [copiedAwsCmd, setCopiedAwsCmd] = useState(false)
  const [copiedJustCmd, setCopiedJustCmd] = useState(false)
  const [activeExecTab, setActiveExecTab] = useState<'A' | 'B'>('A')

  // ── Resizable list panel ──────────────────────────────────────────────────
  const [listWidth, setListWidth] = useState(DEFAULT_LIST_WIDTH)
  const [isDragging, setIsDragging] = useState(false)
  const listWidthRef = useRef(DEFAULT_LIST_WIDTH)
  const dragging = useRef(false)
  const dragStartX = useRef(0)
  const dragStartWidth = useRef(DEFAULT_LIST_WIDTH)

  useEffect(() => {
    const saved = parseInt(localStorage.getItem(LIST_WIDTH_KEY) ?? "", 10)
    if (!isNaN(saved) && saved >= MIN_LIST_WIDTH && saved <= MAX_LIST_WIDTH) {
      listWidthRef.current = saved; setListWidth(saved)
    }
  }, [])

  const handleDragStart = (e: React.MouseEvent) => {
    dragging.current = true; dragStartX.current = e.clientX
    dragStartWidth.current = listWidthRef.current; setIsDragging(true); e.preventDefault()
  }

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (!dragging.current) return
      const next = Math.max(MIN_LIST_WIDTH, Math.min(MAX_LIST_WIDTH, dragStartWidth.current + (e.clientX - dragStartX.current)))
      listWidthRef.current = next; setListWidth(next)
    }
    const onUp = () => {
      if (!dragging.current) return
      dragging.current = false; setIsDragging(false)
      localStorage.setItem(LIST_WIDTH_KEY, String(listWidthRef.current))
    }
    document.addEventListener("mousemove", onMove)
    document.addEventListener("mouseup", onUp)
    return () => { document.removeEventListener("mousemove", onMove); document.removeEventListener("mouseup", onUp) }
  }, [])

  const handleCreateKey = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!newKeyName.trim()) return
    setCreating(true)
    setCreateError(null)
    try {
      const res = await apiFetch(`${API_BASE}/api/runners/keys`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: newKeyName.trim() }),
      })
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error(body.detail ?? "Failed to generate key")
      }
      const data = await res.json()
      setCreatedKey(data.key)
      await fetchKeys()
    } catch (err: any) {
      setCreateError(err.message ?? "An unexpected error occurred.")
    } finally {
      setCreating(false)
    }
  }

  const handleDeleteKey = async (key: string, name: string) => {
    if (!window.confirm(`Revoke runner key "${name}"? Runners using this key will immediately fail authentication.`)) return
    try {
      const res = await apiFetch(`${API_BASE}/api/runners/keys/${key}`, { method: "DELETE" })
      if (res.ok) {
        await fetchKeys()
      } else {
        alert("Failed to revoke key.")
      }
    } catch (e) {
      console.error(e)
    }
  }

  const handleCopyKey = () => {
    if (createdKey) {
      navigator.clipboard.writeText(createdKey)
      setCopiedKey(true)
      setTimeout(() => setCopiedKey(false), 2000)
    }
  }

  const handleCopyLogs = (logs: string) => {
    navigator.clipboard.writeText(logs)
    setCopiedLogs(true)
    setTimeout(() => setCopiedLogs(false), 2000)
  }

  const handleDownloadLogs = (runnerId: string, logs: string) => {
    const blob = new Blob([logs], { type: "text/plain;charset=utf-8" })
    const url = URL.createObjectURL(blob)
    const link = document.createElement("a")
    link.href = url
    link.download = `runner_${runnerId}_diagnostics.log`
    document.body.appendChild(link)
    link.click()
    document.body.removeChild(link)
    URL.revokeObjectURL(url)
  }

  const handleCloseModal = () => {
    setShowCreateModal(false)
    setNewName("")
    setCreatedKey(null)
    setCreateError(null)
  }

  // Filter runners list based on query
  const filteredRunners = runners.filter(r => 
    r.id.toLowerCase().includes(searchQuery.toLowerCase())
  )

  const selectedRunner = selectedItem !== "keys" ? (runners.find(r => r.id === selectedItem) ?? null) : null
  const runnerRuns = selectedRunner ? runs.filter(r => r.runner_id === selectedRunner.id) : []

  // Helper to render the agents tree
  const renderAgentsTree = () => {
    if (loadingRunners) {
      return (
        <div className="flex items-center gap-2 text-[11px] text-neutral-500 px-2 py-3">
          <Loader2 className="w-3 h-3 animate-spin text-brand-400" />
          Loading agents...
        </div>
      )
    }

    if (runnersError) {
      return (
        <div className="flex items-start gap-1.5 text-[10px] text-red-400 px-2 py-3 bg-red-950/10 rounded border border-red-950/20">
          <AlertCircle className="w-3 h-3 shrink-0 mt-0.5" />
          <span>{runnersError}</span>
        </div>
      )
    }

    const allDenIdsInRunners = Array.from(new Set(runners.map(r => getRunnerDenId(r.id))))
    const extraDens = allDenIdsInRunners
      .filter(id => !dens.some(d => d.id === id))
      .map(id => ({ id, name: id.charAt(0).toUpperCase() + id.slice(1), den_type: "fargate" }))
    
    const allDens = [...dens, ...extraDens]

    // If filtering and no matches anywhere
    const totalFilteredCount = runners.filter(r => r.id.toLowerCase().includes(searchQuery.toLowerCase())).length
    if (totalFilteredCount === 0 && searchQuery) {
      return <p className="text-[11px] text-neutral-600 px-2 py-3 italic">No agents match criteria.</p>
    }

    if (runners.length === 0) {
      return <p className="text-[11px] text-neutral-600 px-2 py-3 italic">No agents connected.</p>
    }

    return allDens.map(den => {
      const denRunners = runners
        .filter(r => getRunnerDenId(r.id) === den.id)
        .filter(r => r.id.toLowerCase().includes(searchQuery.toLowerCase()))

      if (searchQuery && denRunners.length === 0) {
        return null
      }

      const isExpanded = searchQuery ? true : (expandedDens[den.id] ?? true)
      const onlineCount = denRunners.filter(r => {
        const lastHb = parseUtcDate(r.last_heartbeat).getTime()
        return Date.now() - lastHb < 30000
      }).length

      return (
        <div key={den.id} className="space-y-1 select-none">
          {/* Folder Header Row */}
          <div 
            onClick={() => toggleDen(den.id)}
            className="flex items-center gap-1.5 px-2 py-1.5 rounded text-neutral-400 hover:text-white hover:bg-neutral-800/40 transition-colors text-[11px] font-semibold cursor-pointer"
          >
            <span className="text-neutral-500 hover:text-white shrink-0">
              {isExpanded ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
            </span>
            <Folder className="w-3.5 h-3.5 text-neutral-500 shrink-0" />
            <span className="truncate flex-1 uppercase tracking-wider text-[10px]">{den.name}</span>
            <span className="text-[9px] bg-neutral-900 border border-neutral-800/60 px-1 py-0.5 rounded text-neutral-500 font-mono">
              {onlineCount}/{denRunners.length}
            </span>
          </div>

          {/* Folder Children List */}
          {isExpanded && (
            <div className="pl-3 border-l border-neutral-800/60 ml-3.5 space-y-1">
              {denRunners.length === 0 ? (
                <div className="text-[10px] text-neutral-600 italic px-2 py-1">No agents.</div>
              ) : (
                denRunners.map(r => {
                  const lastHb = parseUtcDate(r.last_heartbeat).getTime()
                  const isOnline = Date.now() - lastHb < 30000
                  const active = selectedItem === r.id

                  return (
                    <button
                      key={r.id}
                      onClick={() => setSelectedItem(r.id)}
                      className={`w-full flex items-center gap-2 px-2 py-1.5 rounded text-left transition-colors text-[11px] ${
                        active
                          ? "bg-neutral-800 text-white font-medium"
                          : "text-neutral-400 hover:text-white hover:bg-neutral-800/20"
                      }`}
                    >
                      <Cpu className="w-3.5 h-3.5 shrink-0" />
                      <span className="truncate flex-1 font-mono">{r.id}</span>
                      <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${isOnline ? "bg-green-500 animate-pulse" : "bg-neutral-600"}`} />
                    </button>
                  )
                })
              )}
            </div>
          )}
        </div>
      )
    })
  }

  return (
    <div className={`flex h-full bg-neutral-950 text-white overflow-hidden${isDragging ? " select-none" : ""}`}>
      {/* ── Left Navigation Column ── */}
      <div
        className="flex-shrink-0 border-r border-neutral-800 flex flex-col h-full overflow-hidden"
        style={{ width: `${listWidth}px` }}
      >
        {/* Left nav header - aligned with Runs page */}
        <div className="flex items-center justify-between h-9 px-3 border-b border-neutral-800 bg-neutral-900/60 flex-shrink-0">
          <span className="text-xs font-semibold text-white">Runners</span>
          <button
            onClick={handleRefresh}
            disabled={refreshing}
            className="text-neutral-500 hover:text-white transition-colors disabled:opacity-50"
            title="Refresh All"
          >
            <RefreshCw className={`w-3 h-3 ${refreshing ? "animate-spin" : ""}`} />
          </button>
        </div>

        {/* Filter input */}
        <div className="p-2 border-b border-neutral-800/60 flex-shrink-0">
          <div className="relative">
            <Search className="absolute left-2.5 top-2 w-3 h-3 text-neutral-500" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Filter runners..."
              className="w-full bg-neutral-950 border border-neutral-800 rounded px-2 py-1 pl-7 text-[11px] text-white placeholder-neutral-500 focus:outline-none focus:border-brand-500"
            />
          </div>
        </div>

        {/* List scrollable */}
        <div className="flex-1 overflow-y-auto p-1.5 space-y-1">
          {/* Subscription Keys Nav Option */}
          <button
            onClick={() => setSelectedItem("keys")}
            className={`w-full flex items-center gap-2 px-2.5 py-1.5 rounded text-left transition-colors text-[11px] ${
              selectedItem === "keys"
                ? "bg-neutral-800 text-white font-medium"
                : "text-neutral-400 hover:text-white hover:bg-neutral-800/40"
            }`}
          >
            <Key className="w-3.5 h-3.5 shrink-0" />
            <span>Subscription Keys</span>
            <span className="ml-auto text-[10px] bg-neutral-900 text-neutral-400 px-1.5 py-0.5 rounded-full font-mono font-normal border border-neutral-800/60">
              {keys.length}
            </span>
          </button>

          <div className="pt-2 pb-0.5 px-2">
            <span className="text-[9px] font-bold text-neutral-600 uppercase tracking-wider">Connected Agents</span>
          </div>

          {renderAgentsTree()}
        </div>
      </div>

      {/* Drag handle */}
      <div
        onMouseDown={handleDragStart}
        className="w-1 flex-shrink-0 bg-neutral-800 hover:bg-brand-500 transition-colors cursor-col-resize z-10"
      />

      {/* ── Right Content/Detail Column ── */}
      <div className="flex-1 flex flex-col h-full overflow-hidden bg-neutral-950">
        {/* Detail view based on selection */}
        {selectedItem === "keys" ? (
          /* KEY MANAGEMENT VIEW */
          <div className="flex-1 flex flex-col h-full overflow-hidden">
            {/* Header row — exact same h-9, borders and colors as /runs */}
            <div className="h-9 px-4 border-b border-neutral-800 bg-neutral-900/60 flex items-center justify-between sticky top-0 z-10 backdrop-blur-md flex-shrink-0">
              <div className="flex items-center gap-2">
                <Key className="w-3.5 h-3.5 text-brand-400" />
                <span className="text-xs font-semibold text-white">Subscription Keys</span>
              </div>
              <button
                onClick={() => setShowCreateModal(true)}
                className="flex items-center gap-1 bg-brand-500 hover:bg-brand-600 text-neutral-950 px-2 py-1 rounded text-[10px] font-semibold transition-colors"
              >
                <Plus className="w-3 h-3" /> Generate Key
              </button>
            </div>

            <div className="flex-1 overflow-y-auto p-6 space-y-6">
              <div className="max-w-4xl w-full mx-auto space-y-6">
                {keysError && (
                  <div className="bg-red-500/10 border border-red-500/30 rounded-lg p-4 flex items-start gap-3 text-red-400 text-xs">
                    <AlertCircle className="w-4 h-4 shrink-0" />
                    <div>
                      <p className="font-semibold">Failed to retrieve subscription keys</p>
                      <p className="text-neutral-400 mt-1">{keysError}</p>
                    </div>
                  </div>
                )}

                <div className="border border-neutral-800 rounded-lg bg-neutral-900/10 overflow-hidden">
                  <div className="px-4 py-3 bg-neutral-900/30 border-b border-neutral-800">
                    <h3 className="text-xs font-semibold uppercase tracking-wider text-neutral-300">Available Security Keys</h3>
                  </div>
                  <div className="p-4">
                    {loadingKeys ? (
                      <div className="flex items-center gap-2 text-xs text-neutral-500 py-6 justify-center">
                        <Loader2 className="w-4 h-4 animate-spin text-brand-400" />
                        Loading keys...
                      </div>
                    ) : keys.length === 0 ? (
                      <p className="text-xs text-neutral-500 text-center py-6">No keys generated yet.</p>
                    ) : (
                      <div className="space-y-2">
                        {keys.map((k) => (
                          <div
                            key={k.key}
                            className="flex items-center justify-between p-3 rounded-lg border border-neutral-800 bg-neutral-900/30 hover:bg-neutral-800/20 transition-all"
                          >
                            <div className="flex items-start gap-3">
                              <Key className="w-4 h-4 text-neutral-500 mt-0.5" />
                              <div>
                                <p className="text-xs text-white font-medium">{k.name}</p>
                                <code className="text-[10px] text-neutral-500 font-mono">
                                  {k.key.substring(0, 10)}...{k.key.substring(k.key.length - 4)}
                                </code>
                              </div>
                            </div>
                            <div className="flex items-center gap-3">
                              <span className="px-2 py-0.5 rounded text-[10px] bg-emerald-500/10 text-emerald-400 font-medium">
                                {k.status}
                              </span>
                              {k.key !== "fr_local_dev_key_default_33794b" ? (
                                <button
                                  onClick={() => handleDeleteKey(k.key, k.name)}
                                  className="p-1.5 rounded text-neutral-500 hover:text-red-400 hover:bg-red-500/10 transition-colors"
                                  title="Revoke Key"
                                >
                                  <Trash2 className="w-3.5 h-3.5" />
                                </button>
                              ) : (
                                <span className="text-[10px] text-neutral-600 px-1.5" title="System Key cannot be deleted">
                                  System Key
                                </span>
                              )}
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              </div>
            </div>
          </div>
        ) : selectedRunner ? (
          /* RUNNER AGENT DETAIL VIEW */
          <div className="flex-1 flex flex-col h-full overflow-hidden">
            {/* Header row — exact same h-9, borders and colors as /runs */}
            <div className="h-9 px-4 border-b border-neutral-800 bg-neutral-900/60 flex items-center justify-between sticky top-0 z-10 backdrop-blur-md flex-shrink-0">
              <div className="flex items-center gap-2 min-w-0 flex-1">
                <Cpu className="w-3.5 h-3.5 text-brand-400 flex-shrink-0" />
                <span className="text-xs font-semibold text-white truncate font-mono">{selectedRunner.id}</span>
                <span className={`px-1.5 py-0.5 rounded-full text-[9px] font-medium flex items-center gap-1 ${
                  Date.now() - parseUtcDate(selectedRunner.last_heartbeat).getTime() < 30000
                    ? "bg-green-500/10 text-green-400 border border-green-500/20"
                    : "bg-neutral-800 text-neutral-400 border border-neutral-700/60"
                }`}>
                  <span className={`w-1 h-1 rounded-full ${
                    Date.now() - parseUtcDate(selectedRunner.last_heartbeat).getTime() < 30000 ? "bg-green-500 animate-pulse" : "bg-neutral-600"
                  }`} />
                  {Date.now() - parseUtcDate(selectedRunner.last_heartbeat).getTime() < 30000 ? "Online" : "Offline"}
                </span>
                <span className="text-[10px] text-neutral-500 truncate hidden sm:inline">
                  Last HB: {parseUtcDate(selectedRunner.last_heartbeat).toLocaleTimeString()}
                </span>
              </div>
            </div>

            <div className="flex-1 overflow-y-auto p-6 space-y-6">
              {/* Stats Overview cards */}
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                <div className="p-4 rounded-lg border border-neutral-800 bg-neutral-900/20">
                  <p className="text-[10px] text-neutral-500 uppercase tracking-wider font-semibold">Runner Connection</p>
                  <p className="text-xs text-white mt-1 font-mono truncate">
                    {selectedRunner.url || "Outbound Polling Only"}
                  </p>
                </div>
                <div className="p-4 rounded-lg border border-neutral-800 bg-neutral-900/20">
                  <p className="text-[10px] text-neutral-500 uppercase tracking-wider font-semibold">Associated Den</p>
                  <p className="text-xs text-brand-400 mt-1 font-bold uppercase tracking-wider">
                    {getRunnerDenId(selectedRunner.id)}
                  </p>
                </div>
                <div className="p-4 rounded-lg border border-neutral-800 bg-neutral-900/20">
                  <p className="text-[10px] text-neutral-500 uppercase tracking-wider font-semibold">Leased Jobs</p>
                  <p className="text-xs text-white mt-1 font-medium">
                    {runnerRuns.length} total runs
                  </p>
                </div>
              </div>

              {/* AWS Fargate CLI Exec & Logs Side by Side (or full width if not Fargate) */}
              {selectedRunner.id.startsWith("runner-fargate-") ? (
                <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                  {/* Left: AWS Fargate CLI Exec Command Box */}
                  <div className="border border-neutral-800 rounded-lg overflow-hidden flex flex-col bg-neutral-900/10 gap-px h-[354px]">
                    <div className="px-4 py-3 bg-neutral-900/40 border-b border-neutral-800 flex items-center justify-between flex-shrink-0">
                      <span className="text-xs font-semibold text-brand-400 uppercase tracking-wider flex items-center gap-1.5">
                        <Terminal className="w-3.5 h-3.5" />
                        AWS ECS EXEC / INTERACTIVE SHELL CONNECT
                      </span>
                    </div>
                    <div className="flex border-b border-neutral-800 bg-neutral-900/20 text-[10px] font-bold uppercase tracking-wider flex-shrink-0">
                      <button
                        onClick={() => setActiveExecTab("A")}
                        className={`flex-1 py-2 text-center transition-colors border-r border-neutral-800 ${
                          activeExecTab === "A"
                            ? "bg-neutral-950 text-brand-400 border-b-2 border-brand-500"
                            : "text-neutral-500 hover:text-neutral-300 hover:bg-neutral-900/40"
                        }`}
                      >
                        Justfile (Recommended)
                      </button>
                      <button
                        onClick={() => setActiveExecTab("B")}
                        className={`flex-1 py-2 text-center transition-colors ${
                          activeExecTab === "B"
                            ? "bg-neutral-950 text-brand-400 border-b-2 border-brand-500"
                            : "text-neutral-500 hover:text-neutral-300 hover:bg-neutral-900/40"
                        }`}
                      >
                        Native AWS CLI
                      </button>
                    </div>
                    <div className="p-4 flex-1 overflow-y-auto">
                      {activeExecTab === "A" ? (
                        /* Option A: Justfile Shell (Recommended) */
                        <div className="space-y-2">
                          <div className="flex justify-end">
                            <button
                              onClick={() => {
                                const cmd = `just den shell ${selectedRunner.id}`;
                                navigator.clipboard.writeText(cmd);
                                setCopiedJustCmd(true);
                                setTimeout(() => setCopiedJustCmd(false), 2000);
                              }}
                              className="flex items-center gap-1 px-2 py-0.5 rounded bg-neutral-800 hover:bg-neutral-700 text-[10px] text-neutral-300 font-semibold transition-colors"
                              title="Copy Justfile CLI command to clipboard"
                            >
                              {copiedJustCmd ? <Check className="w-3 h-3 text-green-400" /> : <Copy className="w-3 h-3" />}
                              {copiedJustCmd ? "Copied!" : "Copy Command"}
                            </button>
                          </div>
                          <div className="bg-neutral-950 p-2.5 rounded border border-neutral-800 relative">
                            <code className="text-[10px] text-emerald-400 font-mono block whitespace-pre-wrap leading-relaxed select-all">
                              {`just den shell ${selectedRunner.id}`}
                            </code>
                          </div>
                          <p className="text-[11px] text-neutral-400 leading-relaxed">
                            Tunnels securely via your local Docker API container. <strong>Does not require local AWS CLI, credentials, or Session Manager plugins installed on your host.</strong>
                          </p>
                        </div>
                      ) : (
                        /* Option B: Native AWS CLI */
                        <div className="space-y-2">
                          <div className="flex justify-end">
                            <button
                              onClick={() => {
                                const cmd = `TASK_ARN=$(aws ecs describe-tasks --region eu-west-1 --cluster ferret-runners --tasks $(aws ecs list-tasks --region eu-west-1 --cluster ferret-runners --query "taskArns" --output text) | jq -r --arg rid "${selectedRunner.id}" '.tasks[] | select(any(.overrides?.containerOverrides[]?.environment[]?; .name == "FERRET_RUNNER_ID" and .value == \$rid)) | .taskArn') && aws ecs execute-command --region eu-west-1 --cluster ferret-runners --task \${TASK_ARN##*/} --container runner --command "/bin/bash" --interactive`;
                                navigator.clipboard.writeText(cmd);
                                setCopiedAwsCmd(true);
                                setTimeout(() => setCopiedAwsCmd(false), 2000);
                              }}
                              className="flex items-center gap-1 px-2 py-0.5 rounded bg-neutral-800 hover:bg-neutral-700 text-[10px] text-neutral-300 font-semibold transition-colors"
                              title="Copy AWS CLI query to clipboard"
                            >
                              {copiedAwsCmd ? <Check className="w-3 h-3 text-green-400" /> : <Copy className="w-3 h-3" />}
                              {copiedAwsCmd ? "Copied!" : "Copy Command"}
                            </button>
                          </div>
                          <div className="bg-neutral-950 p-2.5 rounded border border-neutral-800 relative">
                            <code className="text-[10px] text-neutral-500 font-mono block whitespace-pre-wrap leading-relaxed select-all">
                              {`TASK_ARN=$(aws ecs describe-tasks --region eu-west-1 --cluster ferret-runners --tasks $(aws ecs list-tasks --region eu-west-1 --cluster ferret-runners --query "taskArns" --output text) | jq -r --arg rid "${selectedRunner.id}" '.tasks[] | select(any(.overrides?.containerOverrides[]?.environment[]?; .name == "FERRET_RUNNER_ID" and .value == $rid)) | .taskArn') && aws ecs execute-command --region eu-west-1 --cluster ferret-runners --task \n\${TASK_ARN##*/} --container runner --command "/bin/bash" --interactive`}
                            </code>
                          </div>
                          <p className="text-[11px] text-neutral-400 leading-relaxed">
                            Requires AWS CLI, <code>session-manager-plugin</code>, and authorized local AWS credentials configured on your host machine.
                          </p>
                        </div>
                      )}
                    </div>
                  </div>

                  {/* Right: Terminal Logs Block */}
                  {selectedRunner.logs ? (
                    <div className="border border-neutral-800 rounded-lg overflow-hidden flex flex-col bg-neutral-950 h-[354px]">
                      <div className="px-4 py-3 bg-neutral-900/40 border-b border-neutral-800 flex items-center justify-between flex-shrink-0">
                        <span className="text-xs font-semibold text-neutral-300 uppercase tracking-wider flex items-center gap-1.5">
                          <Terminal className="w-3.5 h-3.5 text-brand-400" />
                          Rolling Process Logs
                        </span>
                        <div className="flex items-center gap-1.5 flex-shrink-0">
                          <button
                            onClick={() => handleCopyLogs(selectedRunner.logs ?? "")}
                            className="flex items-center gap-1 px-2.5 py-1 rounded bg-neutral-800 hover:bg-neutral-700 text-[10px] text-neutral-300 font-semibold transition-colors"
                            title="Copy logs to clipboard"
                          >
                            {copiedLogs ? <Check className="w-3 h-3 text-green-400" /> : <Copy className="w-3 h-3" />}
                            Copy
                          </button>
                          <button
                            onClick={() => handleDownloadLogs(selectedRunner.id, selectedRunner.logs ?? "")}
                            className="flex items-center gap-1 px-2.5 py-1 rounded bg-neutral-800 hover:bg-neutral-700 text-[10px] text-neutral-300 font-semibold transition-colors"
                            title="Download log file"
                          >
                            <Download className="w-3 h-3" />
                            Download
                          </button>
                        </div>
                      </div>
                      <pre className="p-4 text-[11px] font-mono text-neutral-400 bg-neutral-950 flex-1 overflow-y-auto leading-relaxed border-0 focus:outline-none whitespace-pre-wrap">
                        {selectedRunner.logs}
                      </pre>
                    </div>
                  ) : (
                    <div className="border border-neutral-800 rounded-lg overflow-hidden flex flex-col bg-neutral-900/10 justify-center items-center h-[354px] p-6 text-center">
                      <Terminal className="w-8 h-8 text-neutral-600 mb-2 animate-pulse" />
                      <p className="text-xs font-semibold text-neutral-400 uppercase tracking-wider">No Rolling Logs Available</p>
                      <p className="text-[11px] text-neutral-500 mt-1 max-w-xs leading-relaxed">
                        This Fargate runner hasn't produced any log output yet.
                      </p>
                    </div>
                  )}
                </div>
              ) : (
                /* Non-Fargate: Terminal Logs Block full-width */
                selectedRunner.logs && (
                  <div className="border border-neutral-800 rounded-lg overflow-hidden flex flex-col bg-neutral-950">
                    <div className="px-4 py-3 bg-neutral-900/40 border-b border-neutral-800 flex items-center justify-between">
                      <span className="text-xs font-semibold text-neutral-300 uppercase tracking-wider flex items-center gap-1.5">
                        <Terminal className="w-3.5 h-3.5 text-brand-400" />
                        Rolling Process Logs
                      </span>
                      <div className="flex items-center gap-1.5">
                        <button
                          onClick={() => handleCopyLogs(selectedRunner.logs ?? "")}
                          className="flex items-center gap-1 px-2.5 py-1 rounded bg-neutral-800 hover:bg-neutral-700 text-[10px] text-neutral-300 font-semibold transition-colors"
                          title="Copy logs to clipboard"
                        >
                          {copiedLogs ? <Check className="w-3 h-3 text-green-400" /> : <Copy className="w-3 h-3" />}
                          Copy
                        </button>
                        <button
                          onClick={() => handleDownloadLogs(selectedRunner.id, selectedRunner.logs ?? "")}
                          className="flex items-center gap-1 px-2.5 py-1 rounded bg-neutral-800 hover:bg-neutral-700 text-[10px] text-neutral-300 font-semibold transition-colors"
                          title="Download log file"
                        >
                          <Download className="w-3 h-3" />
                          Download
                        </button>
                      </div>
                    </div>
                    <pre className="p-4 text-[11px] font-mono text-neutral-400 bg-neutral-950 h-64 overflow-y-auto leading-relaxed border-0 focus:outline-none whitespace-pre-wrap">
                      {selectedRunner.logs}
                    </pre>
                  </div>
                )
              )}

              {/* Runner Runs history table */}
              <div className="border border-neutral-800 rounded-lg bg-neutral-900/10 overflow-hidden">
                <div className="px-4 py-3 bg-neutral-900/30 border-b border-neutral-800 flex items-center justify-between">
                  <h3 className="text-xs font-semibold uppercase tracking-wider text-neutral-300 flex items-center gap-1.5">
                    <History className="w-3.5 h-3.5 text-neutral-500" />
                    Runner Execution History ({runnerRuns.length})
                  </h3>
                </div>
                <div className="p-4">
                  {runnerRuns.length === 0 ? (
                    <p className="text-xs text-neutral-500 py-4 text-center">
                      This runner has not leased or completed any jobs yet.
                    </p>
                  ) : (
                    <div className="overflow-x-auto">
                      <table className="w-full text-left border-collapse">
                        <thead>
                          <tr className="border-b border-neutral-800 text-[10px] font-semibold text-neutral-500 uppercase tracking-wider">
                            <th className="py-2 px-3">Run ID</th>
                            <th className="py-2 px-3">Plan ID</th>
                            <th className="py-2 px-3">Target URL</th>
                            <th className="py-2 px-3">Status</th>
                            <th className="py-2 px-3 text-right">Duration</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-neutral-800/30">
                          {runnerRuns.map((run) => (
                            <tr key={run.id} className="text-[11px] text-neutral-300 hover:bg-neutral-800/10 transition-colors">
                              <td className="py-2 px-3 font-mono font-medium text-white">
                                {run.id.substring(0, 8)}
                              </td>
                              <td className="py-2 px-3 text-neutral-400 font-mono">{run.plan_id}</td>
                              <td className="py-2 px-3 text-neutral-400 truncate max-w-[150px]">{run.target_url}</td>
                              <td className="py-2 px-3">
                                <span className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[9px] font-semibold ${
                                  run.status === "done" ? "bg-green-500/10 text-green-400" :
                                  run.status === "running" ? "bg-brand-500/10 text-brand-400" :
                                  run.status === "error" ? "bg-red-500/10 text-red-400" :
                                  "bg-neutral-800 text-neutral-500"
                                }`}>
                                  {run.status}
                                </span>
                              </td>
                              <td className="py-2 px-3 text-right text-neutral-400">
                                {formatDuration(run.started_at, run.finished_at)}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>
              </div>
            </div>
          </div>
        ) : (
          <div className="flex-1 flex flex-col items-center justify-center p-6 text-neutral-500">
            <Cpu className="w-8 h-8 text-neutral-700 mb-2" />
            <p className="text-xs">Select an item from the left navigation pane to begin.</p>
          </div>
        )}
      </div>

      {/* ── Generate Key Modal ── */}
      {showCreateModal && (
        <div className="fixed inset-0 bg-black/75 z-50 flex items-center justify-center p-4 backdrop-blur-sm">
          <div className="bg-neutral-900 border border-neutral-700 rounded-lg p-6 w-full max-w-md shadow-2xl">
            <div className="flex items-center justify-between mb-4 border-b border-neutral-800 pb-3">
              <h2 className="text-white font-semibold text-sm flex items-center gap-2">
                <Key className="w-4 h-4 text-brand-400" />
                {createdKey ? "Key Generated Successfully" : "Generate Runner Subscription Key"}
              </h2>
              {!createdKey && (
                <button onClick={handleCloseModal} className="text-neutral-400 hover:text-white transition-colors">
                  <X className="w-4 h-4" />
                </button>
              )}
            </div>

            {createdKey ? (
              <div className="space-y-4">
                <div className="bg-amber-500/10 border border-amber-500/30 rounded-lg p-4">
                  <p className="text-amber-400 text-xs font-semibold mb-2">⚠️ Copy this key now!</p>
                  <p className="text-[11px] text-neutral-400 mb-3">
                    For security reasons, this key will not be displayed again.
                  </p>
                  <div className="flex items-center gap-2 bg-neutral-950 p-2.5 rounded border border-neutral-800">
                    <code className="flex-1 text-xs text-green-400 break-all font-mono tracking-wider">{createdKey}</code>
                    <button
                      onClick={handleCopyKey}
                      className="shrink-0 p-1.5 bg-neutral-800 hover:bg-neutral-700 text-neutral-300 rounded transition-colors"
                      title="Copy key"
                    >
                      {copiedKey ? <Check className="w-3.5 h-3.5 text-green-400" /> : <Copy className="w-3.5 h-3.5" />}
                    </button>
                  </div>
                </div>
                <button
                  onClick={handleCloseModal}
                  className="w-full bg-brand-500 hover:bg-brand-600 text-neutral-955 text-xs font-semibold py-2 rounded-lg transition-colors"
                >
                  Close & Done
                </button>
              </div>
            ) : (
              <form onSubmit={handleCreateKey} className="space-y-4">
                {createError && (
                  <div className="bg-red-500/10 border border-red-500/30 rounded p-3 flex items-start gap-2 text-red-400 text-xs">
                    <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
                    <p>{createError}</p>
                  </div>
                )}
                <div>
                  <label className="text-xs text-neutral-400 block mb-1.5 font-medium">
                    Runner Description / Name <span className="text-neutral-600">*</span>
                  </label>
                  <input
                    type="text"
                    required
                    value={newKeyName}
                    onChange={(e) => setNewName(e.target.value)}
                    placeholder="e.g. AWS Auto-Scaling Remote Runner"
                    className="w-full bg-neutral-950 border border-neutral-700 text-white placeholder-neutral-500 rounded-lg px-3 py-2 text-xs focus:border-brand-500 focus:outline-none transition-colors"
                    autoFocus
                  />
                  <p className="text-[11px] text-neutral-500 mt-1.5 leading-relaxed">
                    Choose a descriptive name to help you identify which physical runner or execution cluster is utilizing this key.
                  </p>
                </div>
                <div className="flex gap-2 pt-2">
                  <button
                    type="submit"
                    disabled={creating || !newKeyName.trim()}
                    className="flex-1 bg-brand-500 hover:bg-brand-600 disabled:opacity-50 text-neutral-950 text-xs font-semibold py-2 rounded-lg transition-colors"
                  >
                    {creating ? "Generating..." : "Generate Key"}
                  </button>
                  <button
                    type="button"
                    onClick={handleCloseModal}
                    className="border border-neutral-700 text-neutral-300 hover:bg-neutral-800 text-xs font-semibold px-4 py-2 rounded-lg transition-colors"
                  >
                    Cancel
                  </button>
                </div>
              </form>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
