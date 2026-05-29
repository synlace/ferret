"use client"

import { apiFetch } from "@/lib/api-fetch"
import React, { useState, useEffect, useCallback, useRef } from "react"
import {
  Plus, Trash2, Loader2, ChevronRight, ChevronDown,
  Terminal, CheckCircle, XCircle, Clock, RefreshCw,
  Copy, Download, Check, RotateCcw, Square,
} from "lucide-react"
import { useProject } from "../context/project-context"
import { NewRunModal } from "./NewRunModal"

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000"

const LIST_WIDTH_KEY = "ferret_runs_list_width"
const DEFAULT_LIST_WIDTH = 240
const MIN_LIST_WIDTH = 160
const MAX_LIST_WIDTH = 400

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
  runner_id?: string | null
}

interface WorkspaceFile {
  path: string
  subdir: string
  name: string
  size: number
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

function formatTs(ts: string | null): string {
  if (!ts) return "—"
  try {
    return new Date(ts).toLocaleString()
  } catch { return ts }
}

function StatusBadge({ status }: { status: Run["status"] }) {
  if (status === "running") return (
    <span className="flex items-center gap-1 text-[10px] text-brand-400 font-medium">
      <Loader2 className="w-3 h-3 animate-spin" />running
    </span>
  )
  if (status === "done") return (
    <span className="flex items-center gap-1 text-[10px] text-green-400 font-medium">
      <CheckCircle className="w-3 h-3" />done
    </span>
  )
  if (status === "error") return (
    <span className="flex items-center gap-1 text-[10px] text-red-400 font-medium">
      <XCircle className="w-3 h-3" />error
    </span>
  )
  return (
    <span className="flex items-center gap-1 text-[10px] text-neutral-500 font-medium">
      <Clock className="w-3 h-3" />pending
    </span>
  )
}

// ---------------------------------------------------------------------------
// Run detail panel with live SSE terminal
// ---------------------------------------------------------------------------
function RunDetail({ run, onDeleted, onRerun }: { run: Run; onDeleted: () => void; onRerun: (newRun: Run) => void }) {
  const [lines, setLines] = useState<string[]>([])
  const [streaming, setStreaming] = useState(false)
  const [files, setFiles] = useState<WorkspaceFile[]>([])
  const [currentStatus, setCurrentStatus] = useState(run.status)
  const outputRef = useRef<HTMLPreElement>(null)
  const wsRef = useRef<WebSocket | null>(null)
  const [deleting, setDeleting] = useState(false)
  const [rerunning, setRerunning] = useState(false)
  const [cancelling, setCancelling] = useState(false)
  const [copied, setCopied] = useState(false)

  // Auto-scroll output
  useEffect(() => {
    if (outputRef.current) {
      outputRef.current.scrollTop = outputRef.current.scrollHeight
    }
  }, [lines])

  // Fetch workspace files
  const fetchFiles = useCallback(async () => {
    try {
      const res = await apiFetch(`${API_BASE}/api/runs/${run.id}/files`)
      if (res.ok) {
        const data = await res.json()
        setFiles(data.files ?? [])
      }
    } catch { /* ignore */ }
  }, [run.id])

  // Connect to WebSocket stream
  useEffect(() => {
    setLines([])
    setCurrentStatus(run.status)
    fetchFiles()

    // Close any existing WebSocket before opening a new one
    if (wsRef.current) { wsRef.current.close(); wsRef.current = null }

    // Derive ws:// or wss:// from the API base URL
    const wsBase = API_BASE.replace(/^http/, "ws")
    const ws = new WebSocket(`${wsBase}/api/runs/${run.id}/ws`)
    wsRef.current = ws

    // Only mark as streaming once the connection is open — avoids a false
    // "streaming" state if the WS fails to connect or the run is already done.
    ws.onopen = () => {
      setStreaming(true)
    }

    ws.onmessage = (event) => {
      try {
        const payload = JSON.parse(event.data)
        if (payload.line !== undefined) {
          setLines(prev => [...prev, payload.line])
        }
        if (payload.status) {
          setCurrentStatus(payload.status)
          setStreaming(false)
          fetchFiles()
        }
      } catch { /* ignore malformed */ }
    }

    ws.onclose = () => {
      setStreaming(false)
      wsRef.current = null
    }

    ws.onerror = () => {
      setStreaming(false)
    }

    return () => {
      // Unmount: close without triggering a reconnect — the server will clean
      // up the queue subscription via WebSocketDisconnect / finally block.
      ws.onclose = null
      ws.onerror = null
      ws.close()
      wsRef.current = null
      setStreaming(false)
    }
  }, [run.id]) // eslint-disable-line react-hooks/exhaustive-deps

  const handleDelete = async () => {
    if (!confirm("Delete this run?")) return
    setDeleting(true)
    try {
      await apiFetch(`${API_BASE}/api/runs/${run.id}`, { method: "DELETE" })
      onDeleted()
    } catch { /* ignore */ } finally { setDeleting(false) }
  }

  const handleRerun = async () => {
    setRerunning(true)
    try {
      const res = await apiFetch(`${API_BASE}/api/runs/${run.id}/rerun`, { method: "POST" })
      if (res.ok) {
        const newRun = await res.json()
        onRerun(newRun as Run)
      }
    } catch { /* ignore */ } finally { setRerunning(false) }
  }

  const handleCancel = async () => {
    setCancelling(true)
    try {
      await apiFetch(`${API_BASE}/api/runs/${run.id}/cancel`, { method: "POST" })
    } catch { /* ignore */ } finally { setCancelling(false) }
  }

  const handleCopy = () => {
    const text = lines.join("")
    if (!text) return
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    }).catch(() => {})
  }

  const handleDownload = () => {
    const text = lines.join("")
    if (!text) return
    const slug = (run.target_url || run.plan_id).replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 40)
    const filename = `run_${run.id.slice(0, 8)}_${slug}.log`
    const blob = new Blob([text], { type: "text/plain" })
    const url = URL.createObjectURL(blob)
    const a = document.createElement("a")
    a.href = url; a.download = filename; a.click()
    URL.revokeObjectURL(url)
  }

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Header row — h-9 to align with the page-level header */}
      <div className="flex items-center justify-between px-4 h-[48px] border-b border-neutral-800 bg-[#171717] flex-shrink-0 gap-3">
        <div className="flex flex-col min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="text-sm font-bold tracking-wider text-white truncate">{run.target_url || run.plan_id}</span>
            <StatusBadge status={currentStatus} />
          </div>
          <span className="text-[10px] text-neutral-500 mt-0.5 leading-none font-mono">ID: {run.id}</span>
        </div>
        <div className="flex items-center gap-1.5 flex-shrink-0">
          {(currentStatus === "done" || currentStatus === "error") && (
            <button
              onClick={handleRerun}
              disabled={rerunning}
              className="flex items-center gap-1.5 text-[11px] font-bold bg-brand-400 hover:bg-brand-300 text-neutral-950 px-2.5 py-1 transition-colors rounded-sm disabled:opacity-40"
              title="Re-run with same plan and target"
            >
              {rerunning ? <Loader2 className="w-2.5 h-2.5 animate-spin" /> : <RotateCcw className="w-2.5 h-2.5" />}
              Re-run
            </button>
          )}
          {currentStatus === "running" && (
            <button
              onClick={handleCancel}
              disabled={cancelling}
              className="flex items-center gap-1.5 text-[11px] font-bold bg-red-500 hover:bg-red-400 text-neutral-950 px-2.5 py-1 transition-colors disabled:opacity-40"
              title="Stop this run"
            >
              {cancelling ? <Loader2 className="w-2.5 h-2.5 animate-spin" /> : <Square className="w-2.5 h-2.5 fill-current" />}
              Stop
            </button>
          )}
          <button
            onClick={handleDelete}
            disabled={deleting || currentStatus === "running"}
            className="flex items-center gap-1.5 text-[11px] font-bold bg-red-500 hover:bg-red-400 text-neutral-950 px-2.5 py-1 transition-colors disabled:opacity-40"
          >
            <Trash2 className="w-2.5 h-2.5" />Delete
          </button>
        </div>
      </div>
      {/* Metadata sub-row */}
      <div className="flex items-center gap-3 px-4 h-[27px] border-b border-neutral-800/60 text-[10px] text-neutral-500 flex-shrink-0 bg-neutral-900/30 flex-wrap">
        <span>Plan: <span className="text-neutral-400">{run.plan_id}</span></span>
        {run.runner_id && (
          <span>Runner: <span className="text-neutral-400 font-mono">{run.runner_id}</span></span>
        )}
        <span>Started: <span className="text-neutral-400">{formatTs(run.started_at)}</span></span>
        <span>Duration: <span className="text-neutral-400">{formatDuration(run.started_at, run.finished_at)}</span></span>
        {run.exit_code !== null && (
          <span>Exit: <span className={run.exit_code === 0 ? "text-green-400" : "text-red-400"}>{run.exit_code}</span></span>
        )}
      </div>

      {/* Terminal output */}
      <div className="flex-1 overflow-hidden flex flex-col min-h-0">
        <div className="flex items-center gap-2 px-4 h-[27px] border-b border-neutral-800/60 flex-shrink-0">
          <Terminal className="w-3 h-3 text-neutral-500" />
          <span className="text-[10px] text-neutral-500 uppercase tracking-wider">Output</span>
          <div className="ml-auto flex items-center gap-1">
            {streaming && <Loader2 className="w-3 h-3 text-brand-400 animate-spin" />}
            <button
              onClick={handleCopy}
              disabled={lines.length === 0}
              title="Copy output"
              className="text-neutral-500 hover:text-neutral-300 disabled:opacity-30 transition-colors p-0.5"
            >
              {copied ? <Check className="w-3 h-3 text-green-400" /> : <Copy className="w-3 h-3" />}
            </button>
            <button
              onClick={handleDownload}
              disabled={lines.length === 0}
              title="Download output as .log"
              className="text-neutral-500 hover:text-neutral-300 disabled:opacity-30 transition-colors p-0.5"
            >
              <Download className="w-3 h-3" />
            </button>
          </div>
        </div>
        <pre
          ref={outputRef}
          className="flex-1 overflow-y-auto p-3 text-xs font-mono text-neutral-300 bg-neutral-950 whitespace-pre-wrap leading-relaxed"
        >
          {lines.length === 0 && !streaming && (
            <span className="text-neutral-600 italic">No output yet.</span>
          )}
          {lines.join("")}
          {streaming && currentStatus === "running" && (
            <span className="text-brand-400 animate-pulse">▌</span>
          )}
        </pre>
      </div>

      {/* Output files */}
      {files.length > 0 && (
        <div className="border-t border-neutral-800 flex-shrink-0 max-h-40 overflow-y-auto">
          <div className="px-4 py-1.5 text-[10px] text-neutral-500 uppercase tracking-wider border-b border-neutral-800/60">
            Output Files
          </div>
          <div className="px-4 py-2 space-y-0.5">
            {files.map(f => (
              <div key={f.path} className="flex items-center gap-2 text-[11px]">
                <span className="text-neutral-600 w-20 flex-shrink-0">{f.subdir}/</span>
                <span className="text-neutral-300 truncate">{f.name}</span>
                <span className="text-neutral-600 ml-auto flex-shrink-0">{(f.size / 1024).toFixed(1)}KB</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Main Runs page
// ---------------------------------------------------------------------------
export default function RunsPage() {
  const { activeProjectId } = useProject()
  const [runs, setRuns] = useState<Run[]>([])
  const [loading, setLoading] = useState(false)
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null)
  const [showNewModal, setShowNewModal] = useState(false)

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

  const selectedRun = runs.find(r => r.id === selectedRunId) ?? null

  const fetchRuns = useCallback(async () => {
    if (!activeProjectId) return
    setLoading(true)
    try {
      const res = await apiFetch(`${API_BASE}/api/runs?project_id=${activeProjectId}`)
      if (res.ok) {
        const json = await res.json()
        const data: Run[] = Array.isArray(json) ? json : []
        setRuns(data)
        // Auto-select most recent run if nothing is currently selected
        setSelectedRunId(prev => {
          if (prev) return prev  // keep existing selection
          return data.length > 0 ? data[0].id : null
        })
      }
    } catch { /* ignore */ } finally { setLoading(false) }
  }, [activeProjectId])

  useEffect(() => { fetchRuns() }, [fetchRuns])

  // Poll while any run is running
  useEffect(() => {
    const hasRunning = runs.some(r => r.status === "running" || r.status === "pending")
    if (!hasRunning) return
    const id = setInterval(fetchRuns, 3000)
    return () => clearInterval(id)
  }, [runs, fetchRuns])

  const handleRunCreated = (run: { id: string; workspace_id: string; plan_id: string; target_url: string; status: string }) => {
    setShowNewModal(false)
    fetchRuns()
    setSelectedRunId(run.id)
  }

  const handleRunDeleted = () => {
    setSelectedRunId(null)
    fetchRuns()
  }

  const handleRunRerun = (newRun: Run) => {
    fetchRuns()
    setSelectedRunId(newRun.id)
  }

  return (
    <div className={`flex h-full bg-neutral-950 text-white overflow-hidden${isDragging ? " select-none" : ""}`}>
      {/* Left: run list */}
      <div
        className="flex-shrink-0 border-r border-neutral-800 bg-[#0a0a0a] flex flex-col overflow-hidden"
        style={{ width: `${listWidth}px` }}
      >
        {/* Left nav header */}
        <div className="flex items-center justify-between px-3 h-[48px] border-b border-neutral-800 bg-[#171717] flex-shrink-0">
          <div className="flex flex-col min-w-0">
            <span className="text-sm font-bold tracking-wider text-white">Runs</span>
            <span className="text-[10px] text-neutral-500 mt-0.5 leading-none whitespace-nowrap truncate">Execution history</span>
          </div>
          <div className="flex items-center gap-1.5">
            <button
              onClick={fetchRuns}
              className="text-neutral-500 hover:text-neutral-300 transition-colors"
              title="Refresh"
            >
              <RefreshCw className="w-3 h-3" />
            </button>
            <button
              onClick={() => setShowNewModal(true)}
              className="flex items-center justify-center w-6 h-6 bg-brand-400 hover:bg-brand-300 text-neutral-950 transition-colors rounded-sm"
              title="New Run"
            >
              <Plus className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>
        <div className="flex-1 overflow-y-auto">
          {loading && runs.length === 0 && (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="w-4 h-4 animate-spin text-neutral-600" />
            </div>
          )}
          {!loading && runs.length === 0 && (
            <div className="px-3 py-6 text-center">
              <p className="text-xs text-neutral-600">No runs yet.</p>
              <p className="text-[10px] text-neutral-700 mt-1">Create a run to execute a script plan.</p>
            </div>
          )}
          {runs.map(run => (
            <button
              key={run.id}
              onClick={() => setSelectedRunId(run.id)}
              className={`w-full text-left px-3 h-[54px] flex flex-col justify-center border-b border-neutral-800/60 last:border-b-0 transition-colors ${
                selectedRunId === run.id
                  ? "bg-neutral-800 text-white"
                  : "hover:bg-neutral-900/80 text-neutral-300"
              }`}
            >
              <div className="flex items-center gap-1.5 mb-0.5">
                {run.status === "running" && (
                  <span className="w-1.5 h-1.5 rounded-full bg-brand-500 animate-pulse flex-shrink-0" />
                )}
                <span className="text-xs font-medium truncate flex-1">
                  {run.target_url || run.plan_id}
                </span>
                <ChevronRight className={`w-3 h-3 flex-shrink-0 ${selectedRunId === run.id ? "text-brand-400" : "text-neutral-700"}`} />
              </div>
              <div className="flex items-center gap-2">
                <StatusBadge status={run.status} />
                <span className="text-[10px] text-neutral-600 ml-auto">
                  {formatDuration(run.started_at, run.finished_at)}
                </span>
              </div>
              <p className="text-[10px] text-neutral-600 truncate mt-0.5">{run.plan_id}</p>
            </button>
          ))}
        </div>
      </div>

      {/* Drag handle */}
      <div
        onMouseDown={handleDragStart}
        className="w-1 flex-shrink-0 bg-neutral-800 hover:bg-brand-500 transition-colors cursor-col-resize z-10"
      />

      {/* Right: run detail */}
      <div className="flex-1 overflow-hidden">
        {selectedRun ? (
          <RunDetail
            key={selectedRun.id}
            run={selectedRun}
            onDeleted={handleRunDeleted}
            onRerun={handleRunRerun}
          />
        ) : (
          <div className="flex items-center justify-center h-full">
            <div className="text-center">
              <Terminal className="w-8 h-8 text-neutral-700 mx-auto mb-3" />
              <p className="text-sm text-neutral-500">Select a run to view output</p>
              <button
                onClick={() => setShowNewModal(true)}
                className="mt-3 text-xs text-brand-400 hover:text-brand-300 transition-colors"
              >
                + New Run
              </button>
            </div>
          </div>
        )}
      </div>

      {showNewModal && (
        <NewRunModal
          activeProjectId={activeProjectId}
          onClose={() => setShowNewModal(false)}
          onCreated={handleRunCreated}
        />
      )}
    </div>
  )
}
