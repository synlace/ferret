"use client"

import React, { useState, useEffect, useCallback, useMemo, useRef } from "react"
import { apiFetch } from "@/lib/api-fetch"
import { useProject } from "@/app/context/project-context"
import { Button } from "@/components/ui/button"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { 
  Terminal, 
  RefreshCw, 
  ChevronDown, 
  ChevronRight, 
  AlertTriangle, 
  Info, 
  Bug, 
  AlertOctagon,
  SlidersHorizontal,
  X,
  ChevronUp,
  ChevronsUpDown,
  Loader2,
  Clock,
  Bookmark,
  BookmarkCheck,
  Tag,
  Link,
  Check,
  Copy,
  ChevronLeft,
  Trash2
} from "lucide-react"

import CodeMirror, { EditorView } from "@uiw/react-codemirror"
import { atomoneInit } from "@uiw/codemirror-theme-atomone"
import { json } from "@codemirror/lang-json"

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000"

const cmTheme = atomoneInit({
  settings: {
    background: "#0a0a0a",
    gutterBackground: "#171717",
    gutterForeground: "#525252",
    gutterBorder: "#262626",
    lineHighlight: "#1c1c1c",
    selection: "#264f78",
    fontFamily: "ui-monospace, 'JetBrains Mono', monospace",
  },
})

const cmOverrides = EditorView.theme({
  "&": { height: "auto", fontSize: "11px" },
  ".cm-editor": { height: "100%", backgroundColor: "#0a0a0a !important" },
  ".cm-scroller": { overflow: "auto", lineHeight: "1.5", backgroundColor: "#0a0a0a" },
  ".cm-content": { padding: "4px 0", backgroundColor: "#0a0a0a" },
  ".cm-focused": { outline: "none" },
  ".cm-lineNumbers .cm-gutterElement": { padding: "0 6px 0 4px", minWidth: "2rem" },
  "&.cm-focused .cm-selectionBackground, ::selection": { backgroundColor: "#264f78 !important" },
}, { dark: true })

const jsonExtensions = [cmTheme, cmOverrides, EditorView.lineWrapping, json()]

interface LogEntry {
  timestamp: string
  level: string
  component: string
  message: string
  details?: string
  context: {
    project_id?: string
    workspace_id?: string
    workflow_id?: string
    run_id?: string
  }
  exception?: string
}

interface SavedSearch {
  name: string
  query: string
}

// ---------------------------------------------------------------------------
// Unified Log Query Language Parser & Tokenizer
// ---------------------------------------------------------------------------

interface FilterToken {
  negated: boolean
  qualifier: string | null  // null = free text
  value: string
}

function tokeniseLogsQuery(input: string): FilterToken[] {
  const tokens: FilterToken[] = []
  const re = /(-?)(?:([a-zA-Z_]+):)?("(?:[^"\\]|\\.)*"|[^\s]+)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(input)) !== null) {
    const negated = m[1] === "-"
    const qualifier = m[2]?.toLowerCase() ?? null
    const rawValue = m[3].startsWith('"') ? m[3].slice(1, -1).replace(/\\"/g, '"') : m[3]
    tokens.push({ negated, qualifier, value: rawValue })
  }
  return tokens
}

interface ParsedLogsQuery {
  search: string
  level: string | null
  component: string | null
  projectId: string | null
  workspaceId: string | null
  workflowId: string | null
  runId: string | null
  negatedLevels: string[]
  negatedComponents: string[]
}

function parseLogsQuery(input: string): ParsedLogsQuery {
  const tokens = tokeniseLogsQuery(input)
  const freeTexts: string[] = []
  
  let level: string | null = null
  let component: string | null = null
  let projectId: string | null = null
  let workspaceId: string | null = null
  let workflowId: string | null = null
  let runId: string | null = null
  const negatedLevels: string[] = []
  const negatedComponents: string[] = []

  for (const token of tokens) {
    const val = token.value
    if (token.qualifier === null) {
      freeTexts.push(val)
      continue
    }

    const qual = token.qualifier
    if (qual === "level" || qual === "lvl" || qual === "severity") {
      if (token.negated) {
        negatedLevels.push(val.toUpperCase())
      } else {
        level = val.toUpperCase()
      }
    } else if (qual === "component" || qual === "comp" || qual === "source" || qual === "src") {
      if (token.negated) {
        negatedComponents.push(val.toLowerCase())
      } else {
        component = val.toLowerCase()
      }
    } else if (qual === "project" || qual === "proj" || qual === "prj") {
      projectId = val
    } else if (qual === "workspace" || qual === "ws") {
      workspaceId = val
    } else if (qual === "workflow" || qual === "wf") {
      workflowId = val
    } else if (qual === "run" || qual === "run_id") {
      runId = val
    } else {
      freeTexts.push(`${token.negated ? "-" : ""}${qual}:${val}`)
    }
  }

  return {
    search: freeTexts.join(" "),
    level,
    component,
    projectId,
    workspaceId,
    workflowId,
    runId,
    negatedLevels,
    negatedComponents
  }
}

// ---------------------------------------------------------------------------
// upsertToken — add, update, or remove a qualifier token in a raw query string
// ---------------------------------------------------------------------------

function upsertToken(query: string, qualifier: string, value: string, negated = false): string {
  const prefix = negated ? "-" : ""
  const qualLower = qualifier.toLowerCase()
  const tokenRe = new RegExp(`(-?)${qualLower}:("(?:[^"\\\\]|\\\\.)*"|[^\\s]*)`, "i")
  const match = tokenRe.exec(query)

  if (!match) {
    const trimmed = query.trim()
    return trimmed ? `${trimmed} ${prefix}${qualLower}:${value}` : `${prefix}${qualLower}:${value}`
  }

  const existingNegated = match[1] === "-"
  const rawValues = match[2].startsWith('"') ? match[2].slice(1, -1) : match[2]
  const currentValues = rawValues.split(",").map(v => v.trim()).filter(Boolean)
  const valueLower = value.toLowerCase()
  const idx = currentValues.findIndex(v => v.toLowerCase() === valueLower)

  let newValues: string[]
  if (idx >= 0) {
    newValues = currentValues.filter((_, i) => i !== idx)
  } else {
    newValues = [...currentValues, value]
  }

  if (newValues.length === 0) {
    return query.replace(tokenRe, "").replace(/\s{2,}/g, " ").trim()
  }

  const newNegated = idx >= 0 ? existingNegated : negated
  const newPrefix = newNegated ? "-" : ""
  const replacement = `${newPrefix}${qualLower}:${newValues.join(",")}`
  return query.replace(tokenRe, replacement).replace(/\s{2,}/g, " ").trim()
}

function isTokenActive(query: string, qualifier: string, value: string): boolean {
  const tokenRe = new RegExp(`(?:^|\\s)-?${qualifier.toLowerCase()}:("(?:[^"\\\\]|\\\\.)*"|[^\\s]*)`, "i")
  const match = tokenRe.exec(query)
  if (!match) return false
  const rawValues = match[1].startsWith('"') ? match[1].slice(1, -1) : match[1]
  return rawValues.split(",").some(v => v.trim().toLowerCase() === value.toLowerCase())
}

// ---------------------------------------------------------------------------
// Human-friendly mapping function for log sources
// ---------------------------------------------------------------------------

const getFriendlySource = (component: string): string => {
  const comp = component.toLowerCase()
  
  if (comp.includes("chats_engine") || comp.includes("chats_ai") || comp.includes("orchestrator")) {
    return "AI Agent Loop"
  }
  if (comp.includes("script_execution") || comp.includes("execution_engine")) {
    return "Workflow Executor"
  }
  if (comp.includes("session_tunnel") || comp.includes("tunnel")) {
    return "Log Stream Tunnel"
  }
  if (comp.includes("runners") || comp.includes("runner")) {
    return "Runner Controller"
  }
  if (comp.includes("docker-shim") || comp.includes("shim")) {
    return "Container Sandbox"
  }
  if (comp.includes("aiosqlite") || comp.includes("sqlite") || comp.includes("db_client")) {
    return "Database Client"
  }
  if (comp.includes("deps")) {
    return "System Engine"
  }
  if (comp.includes("main") || comp.includes("api.main")) {
    return "FastAPI Core"
  }
  if (comp.includes("uvicorn")) {
    return "Web Server"
  }
  if (comp.includes("mitmproxy") || comp.includes("proxy")) {
    return "Traffic Proxy"
  }
  
  const cleaned = component.replace("src.apps.api.", "")
  return cleaned.charAt(0).toUpperCase() + cleaned.slice(1)
}

const getSourceColor = (component: string): string => {
  const comp = component.toLowerCase()
  
  if (comp.includes("chats_engine") || comp.includes("chats_ai") || comp.includes("orchestrator")) {
    return "text-purple-400"
  }
  if (comp.includes("script_execution") || comp.includes("execution_engine")) {
    return "text-emerald-400"
  }
  if (comp.includes("session_tunnel") || comp.includes("tunnel")) {
    return "text-pink-400"
  }
  if (comp.includes("runners") || comp.includes("runner")) {
    return "text-indigo-400"
  }
  if (comp.includes("docker-shim") || comp.includes("shim")) {
    return "text-cyan-400"
  }
  if (comp.includes("aiosqlite") || comp.includes("sqlite") || comp.includes("db_client")) {
    return "text-amber-400"
  }
  if (comp.includes("deps")) {
    return "text-violet-400"
  }
  if (comp.includes("main") || comp.includes("api.main")) {
    return "text-sky-400"
  }
  if (comp.includes("uvicorn")) {
    return "text-blue-400"
  }
  if (comp.includes("mitmproxy") || comp.includes("proxy")) {
    return "text-teal-400"
  }
  
  return "text-brand-400"
}

const SEVERITIES = [
  { value: "DEBUG", label: "DEBUG", desc: "Detailed trace diagnostics" },
  { value: "INFO", label: "INFO", desc: "General telemetry and health" },
  { value: "WARNING", label: "WARNING", desc: "Non-fatal warning issues" },
  { value: "ERROR", label: "ERROR", desc: "Fatal errors and failures" },
  { value: "CRITICAL", label: "CRITICAL", desc: "System critical events" }
]

const SOURCES = [
  { value: "chats_engine", label: "AI Agent Loop" },
  { value: "script_execution_engine", label: "Workflow Executor" },
  { value: "session_tunnel", label: "Log Stream Tunnel" },
  { value: "runners", label: "Runner Controller" },
  { value: "docker-shim", label: "Container Sandbox" },
  { value: "sqlite_client", label: "Database Client" },
  { value: "deps", label: "System Engine" },
  { value: "main", label: "FastAPI Core" },
  { value: "uvicorn", label: "Web Server" },
  { value: "mitmproxy", label: "Traffic Proxy" }
]

type SortField = "timestamp" | "level" | "component" | "message"
type SortDirection = "asc" | "desc" | "none"

const getLogKey = (log: LogEntry): string => {
  return `${log.timestamp}-${log.component}-${log.message}`
}

export default function LogsPage() {
  const { activeProjectId, activeProject, isLoading: projectLoading } = useProject()
  const lastProjectIdRef = useRef<string | null>(null)
  
  // Search history state (persisted specifically for logs)
  const [searchHistory, setSearchHistory] = useState<string[]>([])
  const [historyOpen, setHistoryOpen] = useState(false)
  const [historyIndex, setHistoryIndex] = useState(-1)
  
  // Saved searches state (bookmarks specifically for logs)
  const [savedSearches, setSavedSearches] = useState<SavedSearch[]>([])
  const [activePills, setActivePills] = useState<SavedSearch[]>([])
  const [savingSearch, setSavingSearch] = useState(false)
  const [saveNameInput, setSaveNameInput] = useState("")
  
  // Filter panel collapse state
  const [filterOpen, setFilterOpen] = useState(false)
  
  // Single source of truth query state (just like proxy history)
  const [rawText, setRawText] = useState("")
  const [copiedFilterUrl, setCopiedFilterUrl] = useState(false)

  // Derived: final effective query
  const searchQuery = useMemo(() => {
    const parts = [...activePills.map(p => p.query), rawText].filter(Boolean)
    return parts.join(" ")
  }, [activePills, rawText])

  const [logs, setLogs] = useState<LogEntry[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const [clearing, setClearing] = useState(false)
  const [autoRefresh, setAutoRefresh] = useState(false)
  const [expandedLogKey, setExpandedLogKey] = useState<string | null>(null)
  const [selectedKeys, setSelectedKeys] = useState<Set<string>>(new Set())
  const [copiedSelected, setCopiedSelected] = useState(false)
  const [copiedIdx, setCopiedIdx] = useState<number | null>(null)
  const [copiedExcIdx, setCopiedExcIdx] = useState<number | null>(null)
  
  // Pagination state (Identical UX/Logic to Proxy History)
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(50)

  // Sorting state
  const [sortField, setSortField] = useState<SortField>("timestamp")
  const [sortDirection, setSortDirection] = useState<SortDirection>("desc")

  const searchInputRef = useRef<HTMLInputElement>(null)
  const saveNameInputRef = useRef<HTMLInputElement>(null)

  // ---------------------------------------------------------------------------
  // Load & Sync Storage
  // ---------------------------------------------------------------------------
  useEffect(() => {
    try {
      const h = localStorage.getItem("ferret:logsSearchHistory")
      if (h) setSearchHistory(JSON.parse(h))
      
      const s = localStorage.getItem("ferret:logsSavedSearches")
      if (s) setSavedSearches(JSON.parse(s))
    } catch (e) {
      console.error("Storage error:", e)
    }
  }, [])

  // Helper to replace or remove project filter dynamically on sidebar transition
  const replaceProjectToken = useCallback((query: string, newProjectId: string): string => {
    const tokenRe = /(-?)project:("(?:[^"\\]|\\.)*"|[^\s]*)/i
    if (newProjectId === "temp") {
      return query.replace(tokenRe, "").replace(/\s{2,}/g, " ").trim()
    }
    if (tokenRe.test(query)) {
      return query.replace(tokenRe, `project:${newProjectId}`)
    }
    const trimmed = query.trim()
    return trimmed ? `${trimmed} project:${newProjectId}` : `project:${newProjectId}`
  }, [])

  // Deep shareable links loader (copies proxy history pattern)
  useEffect(() => {
    if (projectLoading) return
    const params = new URLSearchParams(window.location.search)
    const q = params.get("q")
    if (q) {
      setRawText(q)
      window.history.replaceState({}, "", window.location.pathname)
    } else {
      if (!rawText && activePills.length === 0) {
        if (activeProjectId !== "temp") {
          setRawText(`project:${activeProjectId}`)
        }
      } else if (lastProjectIdRef.current && lastProjectIdRef.current !== activeProjectId) {
        setRawText(q => replaceProjectToken(q, activeProjectId))
      }
    }
    lastProjectIdRef.current = activeProjectId
  }, [activeProjectId, projectLoading, activePills.length, replaceProjectToken])

  const saveHistoryToStorage = (entries: string[]) => {
    try {
      localStorage.setItem("ferret:logsSearchHistory", JSON.stringify(entries))
    } catch { /* ignore */ }
  }

  const saveBookmarksToStorage = (entries: SavedSearch[]) => {
    try {
      localStorage.setItem("ferret:logsSavedSearches", JSON.stringify(entries))
    } catch { /* ignore */ }
  }

  const pushHistory = (query: string) => {
    const trimmed = query.trim()
    if (!trimmed) return
    setSearchHistory(prev => {
      const deduped = [trimmed, ...prev.filter(q => q !== trimmed)].slice(0, 20)
      saveHistoryToStorage(deduped)
      return deduped
    })
    setHistoryOpen(false)
  }

  const removeHistory = (query: string) => {
    setSearchHistory(prev => {
      const next = prev.filter(q => q !== query)
      saveHistoryToStorage(next)
      return next
    })
  }

  const clearHistory = () => {
    setSearchHistory([])
    saveHistoryToStorage([])
  }

  const saveCurrentSearch = (name: string, queryStr: string) => {
    const trimmed = name.trim()
    if (!trimmed) return
    setSavedSearches(prev => {
      const next = [...prev.filter(s => s.name !== trimmed), { name: trimmed, query: queryStr }]
      saveBookmarksToStorage(next)
      return next
    })
    setSaveNameInput("")
    setSavingSearch(false)
  }

  const deleteSavedSearch = (name: string) => {
    setSavedSearches(prev => {
      const next = prev.filter(s => s.name !== name)
      saveBookmarksToStorage(next)
      return next
    })
  }

  const togglePill = (s: SavedSearch) => {
    setActivePills(prev => prev.some(p => p.name === s.name) ? prev.filter(p => p.name !== s.name) : [...prev, s])
    setHistoryOpen(false)
    setPage(1)
  }

  const copyFilterUrl = () => {
    const url = `${window.location.origin}${window.location.pathname}?q=${encodeURIComponent(rawText)}`
    navigator.clipboard.writeText(url).then(() => {
      setCopiedFilterUrl(true)
      setTimeout(() => setCopiedFilterUrl(false), 2000)
    })
  }

  // Parse current query for backend request parameters
  const parsedFilters = useMemo(() => parseLogsQuery(searchQuery), [searchQuery])
  
  const fetchLogs = useCallback(async () => {
    if (projectLoading) return
    setLoading(true)
    try {
      const queryParams = new URLSearchParams()
      
      const { level, component, projectId, workspaceId, workflowId, runId, search, negatedLevels, negatedComponents } = parsedFilters
      
      if (level) queryParams.append("level", level)
      if (component) queryParams.append("component", component)
      if (search) queryParams.append("search", search)
      if (projectId) queryParams.append("project_id", projectId)
      if (workspaceId) queryParams.append("workspace_id", workspaceId)
      if (workflowId) queryParams.append("workflow_id", workflowId)
      if (runId) queryParams.append("run_id", runId)
      if (negatedLevels.length > 0) queryParams.append("negated_levels", negatedLevels.join(","))
      if (negatedComponents.length > 0) queryParams.append("negated_components", negatedComponents.join(","))
      
      // Hook up full pagination to server logs fetch!
      queryParams.append("limit", String(pageSize))
      queryParams.append("offset", String((page - 1) * pageSize))

      const res = await apiFetch(`${API_BASE}/api/logs?${queryParams.toString()}`)
      if (res.ok) {
        const data = await res.json()
        setLogs(data.logs || [])
        setTotal(data.total || 0)
      }
    } catch (err) {
      console.error("Error fetching logs:", err)
    } finally {
      setLoading(false)
    }
  }, [parsedFilters, page, pageSize, projectLoading])

  useEffect(() => {
    fetchLogs()
  }, [fetchLogs])

  useEffect(() => {
    if (!autoRefresh) return
    const interval = setInterval(fetchLogs, 3000)
    return () => clearInterval(interval)
  }, [autoRefresh, fetchLogs])

  // Reset pagination on filter adjustments
  useEffect(() => {
    setPage(1)
  }, [searchQuery])

  const handleClearLogs = async () => {
    const isTemp = activeProjectId === "temp"
    const confirmMsg = isTemp 
      ? "Delete all system logs? This cannot be undone."
      : `Delete all logs for project "${activeProject?.name || activeProjectId}"? This cannot be undone.`

    if (!window.confirm(confirmMsg)) return

    setClearing(true)
    try {
      const queryParams = new URLSearchParams()
      if (!isTemp) {
        queryParams.append("project_id", activeProjectId)
      }
      const res = await apiFetch(`${API_BASE}/api/logs?${queryParams.toString()}`, {
        method: "DELETE",
      })
      if (!res.ok) throw new Error(`API returned ${res.status}`)
      
      // Refresh the logs list
      await fetchLogs()
    } catch (err) {
      console.error("Failed to clear logs:", err)
    } finally {
      setClearing(false)
    }
  }

  const toggleSelectRow = (key: string) => {
    setSelectedKeys(prev => {
      const next = new Set(prev)
      if (next.has(key)) {
        next.delete(key)
      } else {
        next.add(key)
      }
      return next
    })
  }

  const isRowSelected = (key: string) => selectedKeys.has(key)

  const handleSelectAll = () => {
    const visibleKeys = sortedLogs.map(getLogKey)
    const allSelected = visibleKeys.length > 0 && visibleKeys.every(k => selectedKeys.has(k))

    setSelectedKeys(prev => {
      const next = new Set(prev)
      if (allSelected) {
        visibleKeys.forEach(k => next.delete(k))
      } else {
        visibleKeys.forEach(k => next.add(k))
      }
      return next
    })
  }

  const handleCopySelected = () => {
    const selectedLogsArray = logs.filter(log => selectedKeys.has(getLogKey(log)))
    if (selectedLogsArray.length === 0) return

    navigator.clipboard.writeText(JSON.stringify(selectedLogsArray, null, 2))
      .then(() => {
        setCopiedSelected(true)
        setTimeout(() => setCopiedSelected(false), 2000)
      })
      .catch(err => console.error("Failed to copy selected logs:", err))
  }

  const handleClearSelection = () => {
    setSelectedKeys(new Set())
  }

  // Apply negated filter lists on client side for maximum speed and control
  const filteredLogs = useMemo(() => {
    const { negatedLevels, negatedComponents } = parsedFilters
    if (negatedLevels.length === 0 && negatedComponents.length === 0) return logs

    return logs.filter(log => {
      if (negatedLevels.includes(log.level.toUpperCase())) return false
      if (negatedComponents.some(nc => log.component.toLowerCase().includes(nc))) return false
      return true
    })
  }, [logs, parsedFilters])

  // Client-side sorting logic
  const sortedLogs = useMemo(() => {
    if (sortDirection === "none" || !sortField) return filteredLogs

    return [...filteredLogs].sort((a, b) => {
      let valA = ""
      let valB = ""
      if (sortField === "level") {
        valA = a.level
        valB = b.level
      } else if (sortField === "message") {
        valA = a.message
        valB = b.message
      } else if (sortField === "component") {
        valA = a.component
        valB = b.component
      } else if (sortField === "timestamp") {
        valA = a.timestamp
        valB = b.timestamp
      }

      if (sortField === "timestamp") {
        const timeA = new Date(valA).getTime()
        const timeB = new Date(valB).getTime()
        return sortDirection === "asc" ? timeA - timeB : timeB - timeA
      }

      if (sortField === "component") {
        const sourceA = getFriendlySource(a.component).toLowerCase()
        const sourceB = getFriendlySource(b.component).toLowerCase()
        if (sourceA < sourceB) return sortDirection === "asc" ? -1 : 1
        if (sourceA > sourceB) return sortDirection === "asc" ? 1 : -1
        return 0
      }

      valA = valA.toString().toLowerCase()
      valB = valB.toString().toLowerCase()

      if (valA < valB) return sortDirection === "asc" ? -1 : 1
      if (valA > valB) return sortDirection === "asc" ? 1 : -1
      return 0
    })
  }, [filteredLogs, sortField, sortDirection])

  const handleSort = (field: SortField) => {
    if (sortField === field) {
      if (sortDirection === "desc") setSortDirection("asc")
      else if (sortDirection === "asc") setSortDirection("none")
      else setSortDirection("desc")
    } else {
      setSortField(field)
      setSortDirection("desc")
    }
  }

  const renderSortIcon = (field: SortField) => {
    if (sortField !== field || sortDirection === "none") {
      return <ChevronsUpDown className="w-3 h-3 text-neutral-600 shrink-0" />
    }
    return sortDirection === "asc" 
      ? <ChevronUp className="w-3 h-3 text-brand-500 shrink-0" />
      : <ChevronDown className="w-3 h-3 text-brand-500 shrink-0" />
  }

  const getLevelBadgeStyle = (levelStr: string) => {
    switch (levelStr.toUpperCase()) {
      case "CRITICAL":
      case "ERROR":
        return { bg: "bg-red-950/40 text-red-400 border-red-900/50", text: "text-red-400", icon: AlertOctagon }
      case "WARNING":
        return { bg: "bg-yellow-950/40 text-yellow-400 border-yellow-900/50", text: "text-yellow-400", icon: AlertTriangle }
      case "INFO":
        return { bg: "bg-blue-950/40 text-blue-400 border-blue-900/50", text: "text-blue-400", icon: Info }
      case "DEBUG":
      default:
        return { bg: "bg-neutral-800/40 text-neutral-400 border-neutral-700/50", text: "text-neutral-400", icon: Bug }
    }
  }

  const toggleFilter = (qualifier: string, value: string, negated = false) => {
    setRawText(q => upsertToken(q, qualifier, value, negated))
  }

  const hasActiveFilters = searchQuery.includes(":")

  const filteredHistorySuggestions = useMemo(() => {
    const q = rawText.trim().toLowerCase()
    if (!q) return searchHistory
    return searchHistory.filter(h => h.toLowerCase().includes(q))
  }, [rawText, searchHistory])

  const filteredSavedSearchSuggestions = useMemo(() => {
    const q = rawText.trim().toLowerCase()
    if (!q) return savedSearches
    return savedSearches.filter(s =>
      s.name.toLowerCase().includes(q) || s.query.toLowerCase().includes(q)
    )
  }, [rawText, savedSearches])

  // Pagination bounds checks
  const totalPages = Math.ceil(total / pageSize) || 1
  const canPrev = page > 1
  const canNext = page < totalPages

  return (
    <div className="flex flex-col h-full overflow-hidden relative bg-neutral-950 text-neutral-200">
      
      {/* 1. Header Bar */}
      <div className="flex items-center justify-between px-3 h-[48px] border-b border-neutral-800 bg-[#171717] flex-shrink-0">
        <div className="flex flex-col min-w-0">
          <span className="text-sm font-bold tracking-wider text-white">System Logs</span>
          {activeProject ? (
            <span className="text-[10px] text-neutral-500 mt-0.5 leading-none whitespace-nowrap truncate">{activeProject.name}</span>
          ) : (
            <span className="text-[10px] text-neutral-500 mt-0.5 leading-none whitespace-nowrap truncate">Ferret orchestrator</span>
          )}
        </div>
        <div className="flex items-center gap-1.5">
          {/* Multi-selection copy actions */}
          {selectedKeys.size > 0 && (
            <>
              <Button
                tabIndex={-1}
                variant="ghost"
                size="sm"
                onClick={handleCopySelected}
                className="h-7 text-xs text-brand-400 hover:text-brand-300 hover:bg-brand-500/10 border border-brand-500/20"
              >
                {copiedSelected ? <Check className="w-3 h-3 mr-1" /> : <Copy className="w-3 h-3 mr-1" />}
                Copy Selected ({selectedKeys.size})
              </Button>
              <Button
                tabIndex={-1}
                variant="ghost"
                size="sm"
                onClick={handleClearSelection}
                className="h-7 text-xs text-neutral-400 hover:text-white mr-1.5"
              >
                Clear Selection
              </Button>
            </>
          )}

          {/* Live refresh polling button */}
          <Button
            tabIndex={-1}
            variant="ghost"
            size="sm"
            onClick={() => setAutoRefresh(!autoRefresh)}
            className={`h-7 text-xs flex items-center gap-1.5 transition-colors border border-transparent ${
              autoRefresh 
                ? "text-brand-400 hover:text-brand-300 hover:bg-brand-500/10" 
                : "text-neutral-400 hover:text-white"
            }`}
          >
            <span className={`h-1.5 w-1.5 rounded-full ${autoRefresh ? "bg-brand-500 animate-pulse" : "bg-neutral-600"}`} />
            {autoRefresh ? "Live Polling" : "Polling Paused"}
          </Button>

          {/* Refresh button */}
          <Button 
            tabIndex={-1} 
            variant="ghost" 
            size="sm" 
            className="h-7 text-xs text-neutral-400 hover:text-brand-400 hover:bg-transparent" 
            onClick={fetchLogs} 
            disabled={loading}
          >
            {loading ? <Loader2 className="w-3 h-3 mr-1 animate-spin" /> : <RefreshCw className="w-3 h-3 mr-1" />}
            Refresh
          </Button>

          {/* Clear Logs button */}
          <Button
            tabIndex={-1}
            variant="ghost"
            size="sm"
            onClick={handleClearLogs}
            disabled={clearing}
            className="h-7 text-xs text-neutral-400 hover:text-red-400 hover:bg-transparent"
          >
            {clearing ? <Loader2 className="w-3 h-3 mr-1 animate-spin" /> : <Trash2 className="w-3 h-3 mr-1" />}
            Clear Logs
          </Button>

          {/* Clear search query button */}
          {(rawText || activePills.length > 0) && (
            <Button
              tabIndex={-1}
              variant="ghost"
              size="sm"
              onClick={() => { setRawText(""); setActivePills([]); setExpandedLogKey(null); setPage(1) }}
              className="h-7 text-xs text-red-400 hover:text-red-300 hover:bg-red-950/20"
            >
              <X className="w-3 h-3 mr-1" />
              Clear Search
            </Button>
          )}
        </div>
      </div>

      {/* 2. Unified Search Input Bar (Matches Proxy History layout) */}
      <div className="flex border-b border-neutral-800 flex-shrink-0 h-[36px] bg-neutral-900">
        <div className="relative flex-1 flex items-center bg-neutral-900 min-w-0 gap-1 px-2 h-full">
          {/* Active Pills */}
          {activePills.map(pill => (
            <span
              key={pill.name}
              className="inline-flex items-center gap-1 bg-brand-500/20 border border-brand-500/40 text-brand-300 text-[11px] font-mono rounded px-1.5 py-0.5 flex-shrink-0 my-0.5 select-none"
              title={pill.query}
            >
              🔖 {pill.name}
              <button
                tabIndex={-1}
                onClick={() => togglePill(pill)}
                className="text-brand-400/60 hover:text-white transition-colors ml-0.5"
              >
                <X className="w-2.5 h-2.5" />
              </button>
            </span>
          ))}

          {/* Raw Text Input */}
          <input
            ref={searchInputRef}
            type="text"
            placeholder={activePills.length > 0 ? "Add more filters..." : "Search logs... or use qualifiers: level:error component:chats_engine project:temp"}
            value={rawText}
            onFocus={() => setHistoryOpen(true)}
            onBlur={() => setTimeout(() => setHistoryOpen(false), 200)}
            onChange={(e) => { setRawText(e.target.value); setHistoryIndex(-1); setHistoryOpen(true) }}
            onKeyDown={(e) => {
              if (historyOpen && filteredHistorySuggestions.length > 0) {
                if (e.key === "ArrowDown") {
                  e.preventDefault()
                  setHistoryIndex(i => Math.min(i + 1, filteredHistorySuggestions.length - 1))
                } else if (e.key === "ArrowUp") {
                  e.preventDefault()
                  setHistoryIndex(i => Math.max(i - 1, -1))
                } else if (e.key === "Enter") {
                  e.preventDefault()
                  if (historyIndex >= 0 && filteredHistorySuggestions[historyIndex]) {
                    setRawText(filteredHistorySuggestions[historyIndex])
                    setHistoryOpen(false)
                    setHistoryIndex(-1)
                    setPage(1)
                  } else {
                    pushHistory(rawText)
                  }
                } else if (e.key === "Escape") {
                  setHistoryOpen(false)
                  setHistoryIndex(-1)
                  searchInputRef.current?.blur()
                }
              } else if (e.key === "Enter" && rawText.trim()) {
                pushHistory(rawText)
              } else if (e.key === "Escape") {
                setHistoryOpen(false)
                setHistoryIndex(-1)
                searchInputRef.current?.blur()
              }
            }}
            className="h-full text-xs bg-transparent border-0 border-transparent text-white flex-1 min-w-[200px] focus:outline-none focus:ring-0 focus:ring-offset-0 font-mono placeholder:font-sans placeholder:text-neutral-600 pr-8"
          />

          {/* Quick Clear Single Field */}
          {(rawText || activePills.length > 0) && (
            <button
              onClick={() => { setRawText(""); setActivePills([]); setHistoryOpen(false); setHistoryIndex(-1) }}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-neutral-500 hover:text-white p-1"
              title="Clear text query"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          )}
        </div>

        {/* Bookmark save search button */}
        {rawText.trim() && !savingSearch && (
          <button
            onClick={() => { setSavingSearch(true); setSaveNameInput("") }}
            className="h-full px-3 flex items-center border-l border-neutral-800 transition-colors flex-shrink-0 bg-neutral-900 text-neutral-500 hover:text-brand-400"
            title="Save this search"
          >
            <Bookmark className="w-4 h-4" />
          </button>
        )}

        {/* Bookmark input container */}
        {savingSearch && (
          <div className="flex items-center border-l border-neutral-800 bg-neutral-900 px-2 gap-2 text-xs flex-shrink-0 h-full">
            <input
              ref={saveNameInputRef}
              type="text"
              placeholder="Name..."
              value={saveNameInput}
              onChange={(e) => setSaveNameInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") saveCurrentSearch(saveNameInput, rawText)
                else if (e.key === "Escape") setSavingSearch(false)
              }}
              className="h-6 bg-neutral-950 border border-neutral-800 rounded px-2 text-xs text-white max-w-[120px] focus:outline-none focus:border-brand-500 font-mono"
            />
            <Button size="sm" variant="ghost" onClick={() => saveCurrentSearch(saveNameInput, rawText)} className="h-6 text-xs text-brand-400 px-2 hover:bg-brand-500/10">
              <BookmarkCheck className="w-3.5 h-3.5" />
            </Button>
            <button onClick={() => setSavingSearch(false)} className="text-neutral-500 hover:text-white p-1"><X className="w-3.5 h-3.5" /></button>
          </div>
        )}

        {/* Clock (history) button */}
        <button
          onClick={() => setHistoryOpen(!historyOpen)}
          className={`h-full px-3 flex items-center border-l border-neutral-800 transition-colors flex-shrink-0 ${
            historyOpen ? "bg-brand-500/20 text-brand-400" : "bg-neutral-900 text-neutral-400 hover:text-brand-400"
          }`}
          title="Search history"
        >
          <Clock className="w-4 h-4" />
        </button>

        {/* Copy Shareable URL button */}
        {(rawText || activePills.length > 0) && (
          <button
            onClick={copyFilterUrl}
            className={`h-full px-3 flex items-center border-l border-neutral-800 transition-colors flex-shrink-0 ${
              copiedFilterUrl ? "text-green-400 bg-neutral-900" : "bg-neutral-900 text-neutral-400 hover:text-brand-400"
            }`}
            title="Copy shareable filter URL"
          >
            {copiedFilterUrl ? <Check className="w-4 h-4" /> : <Link className="w-4 h-4" />}
          </button>
        )}

        {/* Sliders filter button (incorporates the required text "Filter" + active dot indicator) */}
        <button
          onClick={() => setFilterOpen(!filterOpen)}
          className={`h-full px-3 text-xs flex items-center gap-1.5 border-l border-neutral-800 transition-colors flex-shrink-0 ${
            filterOpen || hasActiveFilters
              ? "bg-brand-500/20 text-brand-400"
              : "bg-neutral-900 text-neutral-400 hover:text-brand-400"
          }`}
        >
          <SlidersHorizontal className="w-3.5 h-3.5" />
          Filter
          <span className={`w-1.5 h-1.5 rounded-full bg-brand-400 ml-0.5 transition-opacity ${hasActiveFilters ? "opacity-100" : "opacity-0"}`} />
        </button>
      </div>

      {/* History and Saved Searches autocomplete dropdown */}
      {historyOpen && (
        <div className="absolute left-0 right-0 top-[84px] z-50 bg-[#18181b] border border-neutral-800 rounded-b-lg shadow-xl max-h-60 overflow-y-auto select-none p-1.5 space-y-1 scrollbar-thin">
          {filteredSavedSearchSuggestions.length === 0 && filteredHistorySuggestions.length === 0 ? (
            <div className="text-center py-4 text-neutral-500 text-xs font-mono">
              No recent queries or bookmarks yet.
            </div>
          ) : (
            <>
              {filteredSavedSearchSuggestions.length > 0 && (
                <div className="space-y-0.5">
                  <span className="block text-[9px] uppercase tracking-wider text-neutral-600 font-bold px-2 py-1 flex items-center gap-1">
                    <Bookmark className="w-3 h-3 text-brand-500" /> Bookmarked Filters
                  </span>
                  {filteredSavedSearchSuggestions.map((s) => (
                    <div 
                      key={s.name} 
                      onMouseDown={() => togglePill(s)}
                      className="flex items-center justify-between text-xs px-2 py-1.5 rounded text-neutral-300 hover:bg-neutral-800 cursor-pointer"
                    >
                      <div className="flex items-center gap-2 min-w-0">
                        <span className="text-brand-400 font-semibold truncate font-mono">🔖 {s.name}</span>
                        <span className="text-neutral-500 text-[10px] truncate font-mono">({s.query})</span>
                      </div>
                      <button 
                        onMouseDown={(e) => { e.stopPropagation(); deleteSavedSearch(s.name) }} 
                        className="text-neutral-600 hover:text-red-400 p-0.5"
                        title="Delete bookmark"
                      >
                        <X className="w-3 h-3" />
                      </button>
                    </div>
                  ))}
                </div>
              )}

              {filteredHistorySuggestions.length > 0 && (
                <div className={`space-y-0.5 pt-1.5 ${filteredSavedSearchSuggestions.length > 0 ? "border-t border-neutral-900/60" : ""}`}>
                  <span className="block text-[9px] uppercase tracking-wider text-neutral-600 font-bold px-2 py-1 flex items-center gap-1">
                    <Clock className="w-3 h-3 text-neutral-500" /> Recent Queries
                  </span>
                  {filteredHistorySuggestions.map((h, i) => (
                    <div 
                      key={h}
                      onMouseDown={() => { setRawText(h); setHistoryOpen(false); setHistoryIndex(-1); setPage(1) }}
                      className={`flex items-center justify-between text-xs px-2 py-1.5 rounded cursor-pointer ${
                        i === historyIndex ? "bg-neutral-800 text-white" : "text-neutral-300 hover:bg-neutral-800"
                      }`}
                    >
                      <span className="font-mono truncate flex-1">{h}</span>
                      <button 
                        onMouseDown={(e) => { e.stopPropagation(); removeHistory(h) }} 
                        className="text-neutral-600 hover:text-red-400 p-0.5"
                        title="Remove from history"
                      >
                        <X className="w-3 h-3" />
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </>
          )}
        </div>
      )}

      {/* Collapsible Filter Panel */}
      {filterOpen && (
        <div className="border-b border-neutral-800 bg-neutral-950 flex-shrink-0 overflow-y-auto p-4 select-none" style={{ maxHeight: "40vh" }}>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6 text-[11px]">
            
            {/* Severity Levels Column */}
            <div>
              <span className="block font-bold text-neutral-500 uppercase tracking-widest border-b border-neutral-900 pb-1.5 mb-2 flex items-center gap-1.5">
                <AlertTriangle className="w-3.5 h-3.5 text-brand-500" /> Severity Level Toggles
              </span>
              <div className="flex flex-col gap-1.5">
                {SEVERITIES.map(sev => {
                  const active = isTokenActive(searchQuery, "level", sev.value)
                  return (
                    <div key={sev.value} className="flex items-center justify-between group">
                      <button
                        onClick={() => toggleFilter("level", sev.value)}
                        className={`font-mono text-left transition-colors font-semibold ${
                          active ? "text-brand-400" : "text-neutral-400 hover:text-white"
                        }`}
                      >
                        level:{sev.value}
                      </button>
                      <span className="text-[10px] text-neutral-500 italic pr-3">{sev.desc}</span>
                    </div>
                  )
                })}
              </div>
            </div>

            {/* Logger Sources Column */}
            <div>
              <span className="block font-bold text-neutral-500 uppercase tracking-widest border-b border-neutral-900 pb-1.5 mb-2 flex items-center gap-1.5">
                <Tag className="w-3.5 h-3.5 text-brand-500" /> Log Source Toggles
              </span>
              <div className="grid grid-cols-1 gap-1.5 max-h-[160px] overflow-y-auto scrollbar-thin">
                {SOURCES.map(src => {
                  const active = isTokenActive(searchQuery, "component", src.value)
                  return (
                    <button
                      key={src.value}
                      onClick={() => toggleFilter("component", src.value)}
                      className={`text-left transition-colors font-mono ${
                        active ? "text-brand-400" : "text-neutral-400 hover:text-white"
                      }`}
                    >
                      component:{src.value}
                      <span className="text-[9px] text-neutral-500 ml-2 font-sans font-normal">({src.label})</span>
                    </button>
                  )
                })}
              </div>
            </div>

            {/* Quick Helper Toggles Column */}
            <div>
              <span className="block font-bold text-neutral-500 uppercase tracking-widest border-b border-neutral-900 pb-1.5 mb-2 flex items-center gap-1.5">
                <Terminal className="w-3.5 h-3.5 text-brand-500" /> Context Quick Toggles
              </span>
              <div className="flex flex-col gap-1.5 font-mono">
                {[
                  { token: "project:temp", desc: "Default temporary sandbox project" },
                  { token: "workspace:system", desc: "System engine background workflows" },
                  { token: "-component:sqlite_client", desc: "Exclude Database trace logs" },
                  { token: "-level:debug", desc: "Exclude massive low-level Trace details" },
                ].map(({ token, desc }) => {
                  const isNegated = token.startsWith("-")
                  const cleaned = isNegated ? token.slice(1) : token
                  const colonIdx = cleaned.indexOf(":")
                  const qual = cleaned.slice(0, colonIdx)
                  const val = cleaned.slice(colonIdx + 1)
                  const active = isTokenActive(searchQuery, qual, val)

                  return (
                    <button
                      key={token}
                      onClick={() => toggleFilter(qual, val, isNegated)}
                      className={`text-left transition-colors flex items-baseline gap-1.5 ${
                        active ? "text-brand-400" : "text-neutral-400 hover:text-white"
                      }`}
                    >
                      <span className="font-semibold whitespace-nowrap">{token}</span>
                      <span className="text-[10px] text-neutral-500 font-sans font-normal">({desc})</span>
                    </button>
                  )
                })}
              </div>
            </div>

          </div>
        </div>
      )}

      {/* 3. Stats & Pagination Bar (Matches Proxy History design perfectly) */}
      <div className="flex items-center border-b border-neutral-800 text-xs flex-shrink-0 bg-neutral-900 select-none h-[36px]">
        <div className="flex items-center flex-1 h-full">
          {[
            { label: "Total Match", value: total, color: "text-white" },
            { label: "Polling Interval", value: autoRefresh ? "3s" : "Inactive", color: autoRefresh ? "text-green-400" : "text-neutral-500" },
          ].map((stat, i) => (
            <div key={i} className={`flex items-center gap-1.5 px-3 h-full ${i > 0 ? "border-l border-neutral-800" : ""}`}>
              <span className="text-neutral-500">{stat.label}:</span>
              <span className={`font-mono font-semibold ${stat.color}`}>{stat.value}</span>
            </div>
          ))}
        </div>

        {/* Replicated pagination component from Proxy History */}
        {total > 0 && (
          <div className="flex items-center gap-1.5 px-3 border-l border-neutral-800 flex-shrink-0 h-full">
            <span className="text-neutral-400 whitespace-nowrap">
              {((page - 1) * pageSize) + 1}–{Math.min(page * pageSize, total)} of {total}
            </span>
            <span className="text-neutral-700">|</span>
            <Select value={String(pageSize)} onValueChange={(v) => { setPageSize(Number(v)); setPage(1) }}>
              <SelectTrigger className="h-6 w-16 bg-neutral-800 border-neutral-700 text-white text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent className="bg-neutral-800 border-neutral-600">
                <SelectItem value="25">25</SelectItem>
                <SelectItem value="50">50</SelectItem>
                <SelectItem value="100">100</SelectItem>
                <SelectItem value="150">150</SelectItem>
              </SelectContent>
            </Select>
            
            {/* Previous Page */}
            <Button 
              variant="ghost" 
              size="icon" 
              className="h-6 w-6 text-neutral-400 hover:text-white disabled:opacity-30" 
              disabled={!canPrev} 
              onClick={() => setPage((p) => p - 1)}
            >
              <ChevronLeft className="w-3 h-3" />
            </Button>
            
            <span className="text-neutral-400 whitespace-nowrap">p{page}/{totalPages}</span>
            
            {/* Next Page */}
            <Button 
              variant="ghost" 
              size="icon" 
              className="h-6 w-6 text-neutral-400 hover:text-white disabled:opacity-30" 
              disabled={!canNext} 
              onClick={() => setPage((p) => p + 1)}
            >
              <ChevronRight className="w-3 h-3" />
            </Button>
          </div>
        )}
      </div>

      {/* 4. Grid Headers */}
      <div className="flex items-center gap-3 px-4 bg-neutral-900/60 border-b border-neutral-800 text-neutral-400 text-[10px] uppercase font-bold tracking-wider select-none shrink-0 h-[36px]">
        {/* Bulk select checkbox column */}
        <div className="w-6 shrink-0 flex items-center justify-center">
          <input 
            type="checkbox"
            checked={sortedLogs.length > 0 && sortedLogs.every(log => selectedKeys.has(getLogKey(log)))}
            onChange={handleSelectAll}
            className="appearance-none rounded border border-neutral-700 bg-neutral-900 checked:bg-brand-500 checked:border-brand-500 cursor-pointer h-3.5 w-3.5 flex items-center justify-center after:content-['✓'] after:text-black after:text-[9px] after:font-extrabold after:hidden checked:after:block focus:outline-none"
          />
        </div>
        <div className="w-8 shrink-0"></div>
        <div 
          onClick={() => handleSort("timestamp")}
          className="w-24 shrink-0 flex items-center gap-1.5 cursor-pointer hover:text-white transition-colors"
        >
          Time {renderSortIcon("timestamp")}
        </div>
        <div 
          onClick={() => handleSort("level")}
          className="w-28 shrink-0 flex items-center gap-1.5 cursor-pointer hover:text-white transition-colors"
        >
          Severity {renderSortIcon("level")}
        </div>
        <div 
          onClick={() => handleSort("component")}
          className="w-48 shrink-0 flex items-center gap-1.5 cursor-pointer hover:text-white transition-colors"
        >
          Source {renderSortIcon("component")}
        </div>
        <div 
          onClick={() => handleSort("message")}
          className="flex-1 min-w-0 flex items-center gap-1.5 cursor-pointer hover:text-white transition-colors"
        >
          Message {renderSortIcon("message")}
        </div>
      </div>

      {/* 5. Log Console View with structured Columns */}
      <div className="flex-1 overflow-y-auto font-mono text-[11px] leading-relaxed select-text scrollbar-thin">
        {loading && sortedLogs.length === 0 ? (
          <div className="flex items-center justify-center py-16 text-neutral-500">
            <Loader2 className="w-6 h-6 animate-spin mr-2" />
            Loading logs...
          </div>
        ) : sortedLogs.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-16 text-neutral-500 space-y-2">
            <SlidersHorizontal className="w-6 h-6 text-neutral-700" />
            <div className="text-center text-xs">No matching system logs captured yet.</div>
          </div>
        ) : (
          sortedLogs.map((log, idx) => {
            const levelStyle = getLevelBadgeStyle(log.level)
            const BadgeIcon = levelStyle.icon
            const logKey = getLogKey(log)
            const isExpanded = expandedLogKey === logKey
            const friendlySource = getFriendlySource(log.component)

            return (
              <div 
                key={idx} 
                className={`border-b border-neutral-900 transition-colors ${
                  isExpanded 
                    ? "bg-[#121212]" 
                    : "hover:bg-neutral-900/40"
                }`}
              >
                {/* Table Row layout */}
                <div 
                  className="flex items-center gap-3 cursor-pointer py-1 px-4 text-neutral-300"
                  onClick={() => setExpandedLogKey(isExpanded ? null : logKey)}
                >
                  {/* Selection Checkbox */}
                  <div 
                    className="w-6 shrink-0 flex items-center justify-center"
                    onClick={(e) => {
                      e.stopPropagation() // Don't trigger row expand
                      toggleSelectRow(logKey)
                    }}
                  >
                    <input 
                      type="checkbox"
                      checked={isRowSelected(logKey)}
                      onChange={() => {}} // handled by onClick on wrapper to ensure easy click target
                      className="appearance-none rounded border border-neutral-700 bg-neutral-900 checked:bg-brand-500 checked:border-brand-500 cursor-pointer h-3.5 w-3.5 flex items-center justify-center after:content-['✓'] after:text-black after:text-[9px] after:font-extrabold after:hidden checked:after:block focus:outline-none"
                    />
                  </div>
                  {/* Expansion indicator */}
                  <span className="w-8 shrink-0 flex justify-center text-neutral-600 select-none">
                    {isExpanded ? <ChevronDown className="w-3.5 h-3.5 text-neutral-400" /> : <ChevronRight className="w-3.5 h-3.5 text-neutral-500" />}
                  </span>
                  
                  {/* Timestamp column */}
                  <span className="w-24 shrink-0 text-neutral-500 select-none font-mono">
                    {new Date(log.timestamp).toLocaleTimeString()}
                  </span>

                  {/* Severity Level column */}
                  <div className="w-28 shrink-0 flex select-none">
                    <span className={`text-[10px] font-bold shrink-0 flex items-center gap-1 ${levelStyle.text}`}>
                      <BadgeIcon className="w-3 h-3" />
                      {log.level}
                    </span>
                  </div>

                  {/* Descriptive Source Column */}
                  <span className={`w-48 shrink-0 font-semibold truncate select-none ${getSourceColor(log.component)}`} title={`${log.component} (Click to expand details)`}>
                    {friendlySource}
                  </span>

                  {/* Message column */}
                  <span className="flex-1 min-w-0 text-neutral-300 truncate select-none" title={log.message}>
                    {log.message}
                  </span>
                </div>

                {/* Collapsible Meta & Exception view */}
                {isExpanded && (
                  <div className="mt-1.5 mb-3 px-4 py-2 border-t border-neutral-900/60 space-y-2.5">
                    {/* Detailed contextual explanation */}
                    {log.details && (
                      <div className="text-neutral-300 animate-fade-in">
                        <p className="text-neutral-200 select-text leading-relaxed font-sans text-xs">
                          {log.details}
                        </p>
                      </div>
                    )}




                    
                    {log.exception && (
                      <div>
                        <div className="flex items-center justify-between mb-1.5">
                          <span className="text-red-400 font-semibold text-[10px] uppercase tracking-wider select-none">Exception Traceback</span>
                          <button
                            onClick={() => {
                              navigator.clipboard.writeText(log.exception ?? "").catch(() => {})
                              setCopiedExcIdx(idx)
                              setTimeout(() => setCopiedExcIdx(null), 1500)
                            }}
                            className={`h-5 px-2 flex items-center gap-1.5 rounded text-[10px] font-medium transition-colors border ${
                              copiedExcIdx === idx
                                ? "text-green-400 border-green-950 bg-green-950/20"
                                : "text-neutral-500 hover:text-white hover:bg-neutral-850 border-neutral-800"
                            }`}
                            title="Copy Exception Traceback"
                          >
                            {copiedExcIdx === idx ? (
                              <>
                                <Check className="w-3 h-3" />
                                Copied!
                              </>
                            ) : (
                              <>
                                <Copy className="w-3 h-3" />
                                Copy Traceback
                              </>
                            )}
                          </button>
                        </div>
                        <pre className="bg-red-950/20 border border-red-950/40 text-red-300/95 p-2 rounded overflow-x-auto text-[10px] leading-relaxed whitespace-pre font-mono scrollbar-thin">
                          {log.exception}
                        </pre>
                      </div>
                    )}

                    <div>
                      <div className="flex items-center gap-2 mb-1.5">
                        <span className="text-neutral-600 font-semibold text-[10px] uppercase tracking-wider select-none">Raw JSON Payload</span>
                        <button
                          onClick={() => {
                            navigator.clipboard.writeText(JSON.stringify(log, null, 2)).catch(() => {})
                            setCopiedIdx(idx)
                            setTimeout(() => setCopiedIdx(null), 1500)
                          }}
                          className={`h-5 px-2 flex items-center gap-1.5 rounded text-[10px] font-medium transition-colors border ${
                            copiedIdx === idx
                              ? "text-green-400 border-green-950 bg-green-950/20"
                              : "text-neutral-500 hover:text-white hover:bg-neutral-850 border-neutral-800"
                          }`}
                          title="Copy Raw JSON Payload"
                        >
                          {copiedIdx === idx ? (
                            <>
                              <Check className="w-3 h-3" />
                              Copied!
                            </>
                          ) : (
                            <>
                              <Copy className="w-3 h-3" />
                              Copy JSON
                            </>
                          )}
                        </button>
                      </div>
                      <CodeMirror
                        value={JSON.stringify(log, null, 2)}
                        extensions={jsonExtensions}
                        theme="dark"
                        editable={false}
                        basicSetup={{
                          lineNumbers: true,
                          foldGutter: false,
                          highlightActiveLine: false,
                          highlightActiveLineGutter: false,
                          drawSelection: false
                        }}
                        className="border border-neutral-800 rounded overflow-hidden max-h-60"
                      />
                    </div>
                  </div>
                )}
              </div>
            )
          })
        )}
      </div>

      {/* Footer count indicator */}
      <div className="px-6 py-3 border-t border-neutral-800 bg-neutral-900/20 flex justify-between items-center text-[10px] text-neutral-500 font-mono flex-shrink-0 select-none">
        <span>Showing up to 150 most recent records</span>
        <span>Total session logs matched: {total}</span>
      </div>
    </div>
  )
}
