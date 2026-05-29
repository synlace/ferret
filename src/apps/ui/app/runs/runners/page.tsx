"use client"

import { apiFetch } from "@/lib/api-fetch"
import React, { useState, useEffect, useCallback, useRef } from "react"
import {
  Key, Plus, Trash2, Cpu, Check, Copy, RefreshCw, Loader2, X, AlertCircle, History, Download, Search, Terminal, ChevronDown, ChevronRight, Folder, Maximize2, Minimize2, HelpCircle
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

interface LiveShellTerminalProps {
  runnerId: string
  visible: boolean
  isMaximized?: boolean
  onRestart?: () => void
}

function LiveShellTerminal({ runnerId, visible, isMaximized = false, onRestart }: LiveShellTerminalProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const terminalRef = useRef<any>(null)
  const wsRef = useRef<WebSocket | null>(null)
  const fitAddonRef = useRef<any>(null)

  const connect = useCallback(() => {
    // Close any existing connection
    if (wsRef.current) {
      wsRef.current.onclose = null
      wsRef.current.close()
      wsRef.current = null
    }

    const terminal = terminalRef.current
    if (!terminal) return

    terminal.write("\r\n\x1b[33m=== Connecting... ===\x1b[0m\r\n")

    const isHttps = API_BASE.startsWith("https://")
    const proto = isHttps ? "wss:" : "ws:"
    const apiHost = API_BASE.replace(/^https?:\/\//, "")
    const wsUrl = `${proto}//${apiHost}/api/runners/${runnerId}/shell`

    const ws = new WebSocket(wsUrl)
    wsRef.current = ws

    ws.onopen = () => {
      terminal.write("\r\n\x1b[32m=== Connected to Fargate Live Shell ===\x1b[0m\r\n")
      if (terminal.cols > 0 && terminal.rows > 0) {
        const dims = { type: "resize", cols: terminal.cols, rows: terminal.rows }
        ws.send(JSON.stringify(dims))
      }
    }

    ws.onmessage = (event) => {
      if (event.data instanceof Blob) {
        const reader = new FileReader()
        reader.onload = () => {
          if (reader.result) terminal.write(new Uint8Array(reader.result as ArrayBuffer))
        }
        reader.readAsArrayBuffer(event.data)
      } else if (typeof event.data === "string") {
        terminal.write(event.data)
      }
    }

    ws.onerror = () => {
      terminal.write("\r\n\x1b[31m=== Connection Error ===\x1b[0m\r\n")
    }

    ws.onclose = () => {
      terminal.write("\r\n\x1b[31m=== Connection Closed ===\x1b[0m\r\n")
    }

    terminal.onData((data: string) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(data)
    })
  }, [runnerId])

  // Init terminal once on mount
  useEffect(() => {
    let active = true
    let cleanupResize: (() => void) | undefined

    async function initTerminal() {
      if (!containerRef.current) return

      const { Terminal } = await import("@xterm/xterm")
      const { FitAddon } = await import("@xterm/addon-fit")

      if (!active) return

      // Clear the container to avoid duplicate terminal mounts
      if (containerRef.current) {
        containerRef.current.innerHTML = ""
      }

      const terminal = new Terminal({
        cursorBlink: true,
        fontSize: 11,
        fontFamily: "Menlo, Monaco, 'Courier New', monospace",
        theme: { background: "#0a0a0a", foreground: "#e5e5e5", cursor: "#10b981" },
      })

      const fitAddon = new FitAddon()
      terminal.loadAddon(fitAddon)
      terminal.open(containerRef.current)
      
      try {
        fitAddon.fit()
      } catch (e) {}

      terminalRef.current = terminal
      fitAddonRef.current = fitAddon

      connect()

      terminal.focus()

      const handleResize = () => {
        try {
          fitAddon.fit()
          if (terminal.cols > 0 && terminal.rows > 0 && wsRef.current?.readyState === WebSocket.OPEN) {
            wsRef.current.send(JSON.stringify({ type: "resize", cols: terminal.cols, rows: terminal.rows }))
          }
        } catch (e) {}
      }

      window.addEventListener("resize", handleResize)
      cleanupResize = () => window.removeEventListener("resize", handleResize)
    }

    initTerminal()

    return () => {
      active = false
      cleanupResize?.()
      if (wsRef.current) { wsRef.current.onclose = null; wsRef.current.close() }
      terminalRef.current?.dispose()
    }
  }, [runnerId]) // only remount if runner changes

  // Refit when visibility is restored or maximized state changes
  useEffect(() => {
    if (visible && fitAddonRef.current && terminalRef.current) {
      const timer = setTimeout(() => {
        try {
          fitAddonRef.current.fit()
          if (terminalRef.current.cols > 0 && terminalRef.current.rows > 0 && wsRef.current?.readyState === WebSocket.OPEN) {
            wsRef.current.send(JSON.stringify({ type: "resize", cols: terminalRef.current.cols, rows: terminalRef.current.rows }))
          }
          terminalRef.current.focus()
        } catch (e) {}
      }, 50)
      return () => clearTimeout(timer)
    }
  }, [visible, isMaximized])

  return (
    <div className={`w-full h-full bg-neutral-950 overflow-hidden flex flex-col${visible ? "" : " hidden"}`}>
      <style dangerouslySetInnerHTML={{ __html: `
        .xterm-viewport::-webkit-scrollbar {
          display: none !important;
        }
        .xterm-viewport {
          scrollbar-width: none !important;
          -ms-overflow-style: none !important;
          overflow-y: hidden !important;
        }
      `}} />
      <div ref={containerRef} className="flex-1 w-full h-full" />
    </div>
  )
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
  const [hideOffline, setHideOffline] = useState(false)

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
  const [openedShellRunnerIds, setOpenedShellRunnerIds] = useState<string[]>([])

  useEffect(() => {
    if (selectedItem && selectedItem !== "keys") {
      setOpenedShellRunnerIds(prev => {
        if (prev.includes(selectedItem)) return prev
        return [...prev, selectedItem]
      })
    }
  }, [selectedItem])

  const [showCreateModal, setShowCreateModal] = useState(false)
  const [newKeyName, setNewName] = useState("")
  const [createdKey, setCreatedKey] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const [createError, setCreateError] = useState<string | null>(null)
  const [copiedKey, setCopiedKey] = useState(false)
  const [copiedLogs, setCopiedLogs] = useState(false)
  const [copiedAwsCmd, setCopiedAwsCmd] = useState(false)
  const [copiedJustCmd, setCopiedJustCmd] = useState(false)
  const [activeExecTab, setActiveExecTab] = useState<'A' | 'B' | 'C'>('C')
  const [isShellMaximized, setIsShellMaximized] = useState(false)
  const [showTmuxHelp, setShowTmuxHelp] = useState(false)
  // Incrementing this key forces LiveShellTerminal to remount (explicit restart)
  const [shellRestartKey, setShellRestartKey] = useState(0)
  const [isRestarting, setIsRestarting] = useState(false)

  useEffect(() => {
    if (!showTmuxHelp) return
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setShowTmuxHelp(false)
      }
    }
    window.addEventListener("keydown", handleKeyDown)
    return () => window.removeEventListener("keydown", handleKeyDown)
  }, [showTmuxHelp])

  const handleRestartShell = useCallback(async () => {
    if (!selectedItem || selectedItem === "keys") return
    setIsRestarting(true)
    try {
      await apiFetch(`/api/runners/${selectedItem}/shell`, { method: "DELETE" })
    } catch (e) {
      // Best-effort — even if DELETE fails (e.g. session already gone), still reconnect
    }
    setShellRestartKey(k => k + 1)
    setIsRestarting(false)
  }, [selectedItem])

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
      let denRunners = runners
        .filter(r => getRunnerDenId(r.id) === den.id)
        .filter(r => r.id.toLowerCase().includes(searchQuery.toLowerCase()))

      const isRunnerOnline = (r: ActiveRunner) => {
        if (r.status === "provisioning") return true
        const lastHb = parseUtcDate(r.last_heartbeat).getTime()
        return Date.now() - lastHb < 30000
      }

      if (hideOffline) {
        denRunners = denRunners.filter(isRunnerOnline)
      }

      if (searchQuery && denRunners.length === 0) {
        return null
      }

      const isExpanded = searchQuery ? true : (expandedDens[den.id] ?? true)
      const onlineCount = denRunners.filter(isRunnerOnline).length

      // Sort runners: online/provisioning first, offline last
      const sortedRunners = [...denRunners].sort((a, b) => {
        const aOnline = isRunnerOnline(a)
        const bOnline = isRunnerOnline(b)
        if (aOnline && !bOnline) return -1
        if (!aOnline && bOnline) return 1
        return 0
      })

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
            <div className="pl-3 space-y-1">
              {sortedRunners.length === 0 ? (
                <div className="text-[10px] text-neutral-600 italic px-2 py-1">No agents.</div>
              ) : (
                sortedRunners.map(r => {
                  const active = selectedItem === r.id
                  const online = isRunnerOnline(r)
                  return (
                    <button
                      key={r.id}
                      onClick={() => setSelectedItem(r.id)}
                      className={`w-full flex items-center gap-1.5 px-2 py-1 rounded text-left transition-colors text-[11px] ${
                        active
                          ? "bg-neutral-800 text-white font-medium"
                          : "text-neutral-400 hover:text-white hover:bg-neutral-800/20"
                      }`}
                    >
                      <Cpu className="w-3 h-3 shrink-0 text-neutral-500" />
                      <span className="truncate flex-1 font-mono text-[10px]">{r.id}</span>
                      {r.status === "provisioning" ? (
                        <span className="w-1.5 h-1.5 rounded-full shrink-0 bg-yellow-500 animate-pulse" />
                      ) : online ? (
                        <span className="w-1.5 h-1.5 rounded-full shrink-0 bg-green-500 animate-pulse" />
                      ) : (
                        <span className="w-1.5 h-1.5 rounded-full shrink-0 bg-neutral-600" />
                      )}
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
        <div className="flex items-center justify-between px-3 h-[48px] border-b border-neutral-800 bg-[#171717] flex-shrink-0">
          <div className="flex flex-col min-w-0">
            <span className="text-sm font-bold tracking-wider text-white">Runners</span>
            <span className="text-[10px] text-neutral-500 mt-0.5 leading-none whitespace-nowrap truncate">Isolated execution</span>
          </div>
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
        <div className="p-2 border-b border-neutral-800/60 flex-shrink-0 space-y-2">
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
          <label className="flex items-center gap-1.5 px-1 cursor-pointer select-none">
            <input
              type="checkbox"
              checked={hideOffline}
              onChange={(e) => setHideOffline(e.target.checked)}
              className="rounded bg-neutral-950 border-neutral-800 text-brand-500 focus:ring-0 focus:ring-offset-0 w-3 h-3 cursor-pointer"
            />
            <span className="text-[10px] text-neutral-400 hover:text-white transition-colors">Hide offline agents</span>
          </label>
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
            {/* Header row — exact same h-[48px], borders and colors as /runs */}
            <div className="flex items-center justify-between px-4 h-[48px] border-b border-neutral-800 bg-[#171717] flex-shrink-0 gap-3 sticky top-0 z-10 backdrop-blur-md">
              <div className="flex flex-col min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <Key className="w-3.5 h-3.5 text-brand-400" />
                  <span className="text-sm font-bold tracking-wider text-white">Subscription Keys</span>
                </div>
                <span className="text-[10px] text-neutral-500 mt-0.5 leading-none">Security and credentials</span>
              </div>
              <button
                onClick={() => setShowCreateModal(true)}
                className="flex items-center gap-1.5 text-[11px] font-bold bg-brand-400 hover:bg-brand-300 text-neutral-950 px-2.5 py-1 transition-colors rounded-sm"
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
            {/* Header row — exact same h-[48px], borders and colors as /runs */}
            <div className="flex items-center justify-between px-4 h-[48px] border-b border-neutral-800 bg-[#171717] flex-shrink-0 gap-3 sticky top-0 z-10 backdrop-blur-md">
              <div className="flex flex-col min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <Cpu className="w-3.5 h-3.5 text-brand-400 flex-shrink-0" />
                  <span className="text-sm font-bold tracking-wider text-white truncate font-mono">{selectedRunner.id}</span>
                  {selectedRunner.status === "provisioning" ? (
                    <span className="px-1.5 py-0.5 rounded-full text-[9px] font-medium flex items-center gap-1 bg-yellow-500/10 text-yellow-400 border border-yellow-500/20">
                      <span className="w-1 h-1 rounded-full bg-yellow-500 animate-pulse" />
                      Pending
                    </span>
                  ) : Date.now() - parseUtcDate(selectedRunner.last_heartbeat).getTime() < 30000 ? (
                    <span className="px-1.5 py-0.5 rounded-full text-[9px] font-medium flex items-center gap-1 bg-green-500/10 text-green-400 border border-green-500/20">
                      <span className="w-1 h-1 rounded-full bg-green-500 animate-pulse" />
                      Online
                    </span>
                  ) : (
                    <span className="px-1.5 py-0.5 rounded-full text-[9px] font-medium flex items-center gap-1 bg-neutral-800 text-neutral-400 border border-neutral-700/60">
                      <span className="w-1 h-1 rounded-full bg-neutral-600" />
                      Offline
                    </span>
                  )}
                </div>
                <span className="text-[10px] text-neutral-500 mt-0.5 leading-none">
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

              {/* CLI Exec & Logs Side by Side for both Fargate and Local Dens */}
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                {/* Left: Container/Local Terminal */}
                <div className="border border-neutral-800 rounded-lg overflow-hidden flex flex-col bg-neutral-900/10 gap-px h-[354px]">
                  <div className="px-4 py-3 bg-neutral-900/40 border-b border-neutral-800 flex items-center justify-between flex-shrink-0">
                    <span className="text-xs font-semibold text-brand-400 uppercase tracking-wider flex items-center gap-1.5">
                      <Terminal className="w-3.5 h-3.5" />
                      {selectedRunner.id.startsWith("runner-fargate-") ? "CONTAINER TERMINAL" : "LOCAL TERMINAL"}
                    </span>
                    {(!selectedRunner.id.startsWith("runner-fargate-") || activeExecTab === "C") && (
                      <div className="flex items-center gap-1">
                        <button
                          onClick={() => setShowTmuxHelp(true)}
                          className="flex items-center gap-1 px-1.5 py-0.5 rounded bg-neutral-800 hover:bg-neutral-700 text-[9px] text-neutral-300 font-semibold transition-colors"
                          title="Show tmux shortcuts help"
                        >
                          <HelpCircle className="w-3 h-3" />
                          Help
                        </button>
                        <button
                          onClick={handleRestartShell}
                          disabled={isRestarting}
                          className="flex items-center gap-1 px-1.5 py-0.5 rounded bg-neutral-800 hover:bg-neutral-700 text-[9px] text-neutral-300 font-semibold transition-colors disabled:opacity-50"
                          title="Kill tmux session and reconnect"
                        >
                          <RefreshCw className={`w-3 h-3 ${isRestarting ? "animate-spin" : ""}`} />
                          Restart
                        </button>
                        <button
                          onClick={() => setIsShellMaximized(true)}
                          className="flex items-center gap-1 px-1.5 py-0.5 rounded bg-neutral-800 hover:bg-neutral-700 text-[9px] text-neutral-300 font-semibold transition-colors"
                          title="Maximize terminal"
                        >
                          <Maximize2 className="w-3 h-3" />
                          Maximize
                        </button>
                      </div>
                    )}
                  </div>
                  {selectedRunner.id.startsWith("runner-fargate-") && (
                    <div className="flex border-b border-neutral-800 bg-neutral-900/20 text-[10px] font-bold uppercase tracking-wider flex-shrink-0">
                      <button
                        onClick={() => setActiveExecTab("A")}
                        className={`flex-1 py-2 text-center transition-colors border-r border-neutral-800 ${
                          activeExecTab === "A"
                            ? "bg-neutral-950 text-brand-400 border-b-2 border-brand-500"
                            : "text-neutral-500 hover:text-neutral-300 hover:bg-neutral-900/40"
                        }`}
                      >
                        Justfile CLI
                      </button>
                      <button
                        onClick={() => setActiveExecTab("C")}
                        className={`flex-1 py-2 text-center transition-colors border-r border-neutral-800 ${
                          activeExecTab === "C"
                            ? "bg-neutral-950 text-brand-400 border-b-2 border-brand-500"
                            : "text-neutral-500 hover:text-neutral-300 hover:bg-neutral-900/40"
                        }`}
                      >
                        Live Shell
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
                  )}
                  <div className="flex-1 overflow-hidden flex flex-col">
                    {/* LiveShellTerminal stays mounted regardless of tab — only CSS-hidden when not active */}
                    <div className={`flex-1 flex flex-col overflow-hidden min-h-0${(!selectedRunner.id.startsWith("runner-fargate-") || activeExecTab === "C") ? "" : " hidden"}`}>
                      <div className={isShellMaximized ? "fixed inset-0 z-50 p-6 bg-neutral-950 flex flex-col" : "flex-1 flex flex-col min-h-0 relative overflow-hidden"}>
                         {isShellMaximized && (
                          <div className="px-4 py-3 bg-neutral-900/40 border-b border-neutral-800 flex items-center justify-between flex-shrink-0 mb-4 rounded-lg">
                            <span className="text-xs font-semibold text-brand-400 uppercase tracking-wider flex items-center gap-1.5">
                              <Terminal className="w-3.5 h-3.5" />
                              {selectedRunner.id.startsWith("runner-fargate-") ? "CONTAINER TERMINAL (MAXIMIZED)" : "LOCAL TERMINAL (MAXIMIZED)"}
                            </span>
                            <div className="flex items-center gap-1.5">
                              <button
                                onClick={() => setShowTmuxHelp(true)}
                                className="flex items-center gap-1 px-2.5 py-1 rounded bg-neutral-800 hover:bg-neutral-700 text-[10px] text-neutral-300 font-semibold transition-colors"
                                title="Show tmux shortcuts help"
                              >
                                <HelpCircle className="w-3.5 h-3.5" />
                                Help
                              </button>
                              <button
                                onClick={handleRestartShell}
                                disabled={isRestarting}
                                className="flex items-center gap-1 px-2.5 py-1 rounded bg-neutral-800 hover:bg-neutral-700 text-[10px] text-neutral-300 font-semibold transition-colors disabled:opacity-50"
                              >
                                <RefreshCw className={`w-3 h-3 ${isRestarting ? "animate-spin" : ""}`} />
                                Restart
                              </button>
                              <button
                                onClick={() => setIsShellMaximized(false)}
                                className="flex items-center gap-1 px-2.5 py-1 rounded bg-neutral-800 hover:bg-neutral-700 text-[10px] text-neutral-300 font-semibold transition-colors"
                              >
                                <Minimize2 className="w-3.5 h-3.5" />
                                Restore
                              </button>
                            </div>
                          </div>
                        )}
                        {openedShellRunnerIds.map(rid => (
                          <LiveShellTerminal
                            key={`${rid}-${shellRestartKey}`}
                            runnerId={rid}
                            visible={selectedRunner.id === rid && (!selectedRunner.id.startsWith("runner-fargate-") || activeExecTab === "C")}
                            isMaximized={isShellMaximized}
                          />
                        ))}
                      </div>
                      {!isShellMaximized && (
                        <p className="text-[10px] text-neutral-500 px-1 pt-1 flex-shrink-0 leading-relaxed">
                          Live WebSocket shell via tmux. Persists across page reloads. Use Restart to reset.
                        </p>
                      )}
                    </div>
                    {selectedRunner.id.startsWith("runner-fargate-") && activeExecTab === "A" && (
                      /* Option A: Justfile Shell */
                      <div className="space-y-2 p-4">
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
                    )}
                    {selectedRunner.id.startsWith("runner-fargate-") && activeExecTab === "B" && (
                      /* Option B: Native AWS CLI */
                      <div className="space-y-2 p-4">
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
                      This runner hasn't produced any log output yet.
                    </p>
                  </div>
                )}
              </div>

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

      {/* ── tmux Shortcuts Help Modal ── */}
      {showTmuxHelp && (
        <div 
          onClick={() => setShowTmuxHelp(false)}
          className="fixed inset-0 bg-black/60 backdrop-blur-sm z-[100] flex items-center justify-center p-4"
        >
          <div 
            onClick={(e) => e.stopPropagation()}
            className="bg-neutral-900 border border-neutral-800 rounded-lg max-w-md w-full p-5 shadow-xl relative text-left"
          >
            <button 
              onClick={() => setShowTmuxHelp(false)}
              className="absolute top-3 right-3 text-neutral-400 hover:text-white transition-colors"
            >
              <X className="w-4 h-4" />
            </button>
            <h3 className="text-sm font-bold text-brand-400 uppercase tracking-wider mb-4 flex items-center gap-1.5">
              <HelpCircle className="w-4 h-4 text-brand-400" />
              tmux Terminal Shortcuts
            </h3>
            <p className="text-[11px] text-neutral-400 mb-4 leading-relaxed">
              The live shell runs inside <code className="text-white">tmux</code>. Press the prefix key <kbd className="bg-neutral-800 text-white px-1 py-0.5 rounded font-mono text-[10px]">Ctrl + B</kbd>, release it, then press any of these shortcuts:
            </p>
            <div className="space-y-2 font-mono text-[11px]">
              <div className="flex justify-between border-b border-neutral-800 pb-1.5">
                <span className="text-neutral-500">Scroll/Copy Mode</span>
                <span className="text-white font-semibold">Ctrl + B, [</span>
              </div>
              <div className="flex justify-between border-b border-neutral-800 pb-1.5">
                <span className="text-neutral-500">Exit Scroll Mode</span>
                <span className="text-white font-semibold">q</span>
              </div>
              <div className="flex justify-between border-b border-neutral-800 pb-1.5">
                <span className="text-neutral-500">Split Vertically</span>
                <span className="text-white font-semibold">Ctrl + B, %</span>
              </div>
              <div className="flex justify-between border-b border-neutral-800 pb-1.5">
                <span className="text-neutral-500">Split Horizontally</span>
                <span className="text-white font-semibold">Ctrl + B, "</span>
              </div>
              <div className="flex justify-between border-b border-neutral-800 pb-1.5">
                <span className="text-neutral-500">Switch Panes</span>
                <span className="text-white font-semibold">Ctrl + B, Arrow Keys</span>
              </div>
              <div className="flex justify-between border-b border-neutral-800 pb-1.5">
                <span className="text-neutral-500">New Window</span>
                <span className="text-white font-semibold">Ctrl + B, c</span>
              </div>
              <div className="flex justify-between">
                <span className="text-neutral-500">Detach Session</span>
                <span className="text-white font-semibold">Ctrl + B, d</span>
              </div>
            </div>
            <div className="mt-5 pt-3 border-t border-neutral-800">
              <p className="text-[10px] text-neutral-500 leading-relaxed">
                💡 <strong>Tip:</strong> Run <code className="text-brand-400 bg-neutral-950 px-1 py-0.5 rounded text-[9px] select-all">tmux set -g mouse on</code> in the shell to enable mouse/trackpad scrolling and pane clicking!
              </p>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
