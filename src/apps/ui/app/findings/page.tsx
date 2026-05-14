"use client"

import React, { useState, useEffect, useCallback, useMemo, useRef } from "react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Badge } from "@/components/ui/badge"
import { Textarea } from "@/components/ui/textarea"
import {
  ShieldAlert, RefreshCw, ChevronRight, ChevronDown,
  MessageSquare, X, Loader2, Trash2, SlidersHorizontal,
} from "lucide-react"
import { useProject } from "../context/project-context"
import { fetchSpend } from "../projects/types"
// Note: Card, Select removed — findings now uses a flush table layout matching the history page

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000"

interface Finding {
  id: string
  title: string
  severity: string
  type: string
  host: string
  request_id: string | null
  source: string
  status: string
  description: string | null
  evidence: string | null
  created_at: string
}

interface ChatMsg {
  role: "user" | "assistant"
  content: string
}

const SEVERITY_COLORS: Record<string, string> = {
  critical: "bg-red-600 text-white",
  high: "bg-orange-500 text-white",
  medium: "bg-yellow-500 text-black",
  low: "bg-blue-500 text-white",
  info: "bg-neutral-500 text-white",
}

const STATUS_COLORS: Record<string, string> = {
  open: "text-red-400",
  confirmed: "text-orange-400",
  false_positive: "text-neutral-400",
  fixed: "text-green-400",
}

const STATUS_CYCLE: Record<string, string> = {
  open: "confirmed",
  confirmed: "false_positive",
  false_positive: "fixed",
  fixed: "open",
}

export default function FindingsPage() {
  const { activeProjectId, activeProject } = useProject()

  const [findings, setFindings] = useState<Finding[]>([])
  const [loading, setLoading] = useState(false)
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [totalSpendUsd, setTotalSpendUsd] = useState<number | null>(null)

  // Filter state
  const [search, setSearch] = useState("")
  const [filterOpen, setFilterOpen] = useState(false)
  const [severityFilters, setSeverityFilters] = useState<Set<string>>(new Set())
  const [statusFilters, setStatusFilters] = useState<Set<string>>(new Set())
  const filterRef = useRef<HTMLDivElement>(null)

  // Chat panel
  const [chatOpen, setChatOpen] = useState(false)
  const [chatMessages, setChatMessages] = useState<ChatMsg[]>([])
  const [chatInput, setChatInput] = useState("")
  const [chatLoading, setChatLoading] = useState(false)

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

  const fetchFindings = useCallback(async () => {
    setLoading(true)
    try {
      const params = new URLSearchParams({ project_id: activeProjectId })
      const res = await fetch(`${API_BASE}/api/findings?${params}`)
      if (res.ok) setFindings(await res.json())
    } catch {
      // ignore
    } finally {
      setLoading(false)
    }
  }, [activeProjectId])

  useEffect(() => { fetchFindings() }, [fetchFindings])

  // Fetch project spend to compute avg cost per finding
  useEffect(() => {
    if (!activeProjectId) return
    fetchSpend(activeProjectId).then(s => setTotalSpendUsd(s?.total_usd ?? null))
  }, [activeProjectId])

  // Client-side filtering
  const filteredFindings = useMemo(() => {
    return findings.filter(f => {
      if (severityFilters.size > 0 && !severityFilters.has(f.severity)) return false
      if (statusFilters.size > 0 && !statusFilters.has(f.status)) return false
      if (search.trim()) {
        const q = search.toLowerCase()
        if (!f.title.toLowerCase().includes(q) && !f.host.toLowerCase().includes(q) && !f.type.toLowerCase().includes(q)) return false
      }
      return true
    })
  }, [findings, severityFilters, statusFilters, search])

  const toggleExpand = (id: string) => {
    setExpanded(prev => {
      const next = new Set(prev)
      next.has(id) ? next.delete(id) : next.add(id)
      return next
    })
  }

  const cycleStatus = async (finding: Finding) => {
    const next = STATUS_CYCLE[finding.status] ?? "open"
    try {
      await fetch(`${API_BASE}/api/findings/${finding.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: next }),
      })
      setFindings(prev => prev.map(f => f.id === finding.id ? { ...f, status: next } : f))
    } catch {
      // ignore
    }
  }

  const deleteFinding = async (id: string) => {
    try {
      await fetch(`${API_BASE}/api/findings/${id}`, { method: "DELETE" })
      setFindings(prev => prev.filter(f => f.id !== id))
    } catch {
      // ignore
    }
  }

  const sendChat = async () => {
    if (!chatInput.trim()) return
    const userMsg: ChatMsg = { role: "user", content: chatInput }
    setChatMessages(prev => [...prev, userMsg])
    setChatInput("")
    setChatLoading(true)
    try {
      const res = await fetch(`${API_BASE}/api/findings/chat?project_id=${activeProjectId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: chatInput, project_id: activeProjectId }),
      })
      if (res.ok) {
        const data = await res.json()
        setChatMessages(prev => [...prev, { role: "assistant", content: data.reply ?? "" }])
      }
    } catch {
      setChatMessages(prev => [...prev, { role: "assistant", content: "Error contacting AI." }])
    } finally {
      setChatLoading(false)
    }
  }

  const counts = {
    critical: findings.filter(f => f.severity === "critical").length,
    high: findings.filter(f => f.severity === "high").length,
    medium: findings.filter(f => f.severity === "medium").length,
    low: findings.filter(f => f.severity === "low").length,
    info: findings.filter(f => f.severity === "info").length,
  }

  const avgCostPerFinding: number | null =
    totalSpendUsd !== null && findings.length > 0
      ? totalSpendUsd / findings.length
      : null

  const hasFilters = severityFilters.size > 0 || statusFilters.size > 0

  return (
    <div className="flex h-full overflow-hidden bg-neutral-950 text-white">
      {/* Main Panel */}
      <div className="flex-1 flex flex-col min-w-0 overflow-hidden">

        {/* Page header */}
        <div className="flex items-center justify-between px-3 py-2 border-b border-neutral-800 flex-shrink-0 bg-neutral-900">
          <div className="flex items-center gap-3">
            <h1 className="text-sm font-bold text-white">Findings</h1>
            {activeProject && (
              <div className="flex items-center gap-1.5 px-2 py-0.5 bg-neutral-800 border border-neutral-700 text-xs">
                <div className="w-2 h-2 flex-shrink-0" style={{ backgroundColor: activeProject.color }} />
                <span className="text-neutral-300">{activeProject.name}</span>
              </div>
            )}
          </div>
          <div className="flex items-center gap-1">
            <Button
              variant="ghost" size="sm"
              className="h-7 text-xs text-neutral-400 hover:text-white"
              onClick={() => setChatOpen(v => !v)}
            >
              <MessageSquare className="w-3 h-3 mr-1" />
              AI Chat
            </Button>
            <Button
              variant="ghost" size="sm"
              className="h-7 text-xs text-neutral-400 hover:text-white"
              onClick={fetchFindings}
              disabled={loading}
            >
              {loading ? <Loader2 className="w-3 h-3 mr-1 animate-spin" /> : <RefreshCw className="w-3 h-3 mr-1" />}
              Refresh
            </Button>
          </div>
        </div>

        {/* Search + Filter bar */}
        <div className="flex border-b border-neutral-800 flex-shrink-0 relative" ref={filterRef}>
          <Input
            placeholder="Search findings…"
            value={search}
            onChange={e => setSearch(e.target.value)}
            className="h-8 text-xs bg-neutral-900 border-0 border-r border-neutral-800 text-white flex-1 rounded-none focus-visible:ring-0"
          />
          <button
            onClick={() => setFilterOpen(v => !v)}
            className={`h-8 px-3 text-xs flex items-center gap-1.5 border-l border-neutral-800 transition-colors ${
              filterOpen || hasFilters
                ? "bg-orange-500/20 text-orange-400"
                : "bg-neutral-900 text-neutral-400 hover:text-white"
            }`}
          >
            <SlidersHorizontal className="w-3 h-3" />
            Filter
            {hasFilters && <span className="w-1.5 h-1.5 rounded-full bg-orange-400 ml-0.5" />}
          </button>

          {/* Filter popup */}
          {filterOpen && (
            <div className="absolute top-full right-0 z-30 bg-neutral-900 border border-neutral-700 shadow-2xl w-[360px]">
              <div className="flex items-center justify-between px-3 py-2 border-b border-neutral-800">
                <span className="text-xs font-semibold text-neutral-300">Filters</span>
                <button
                  onClick={() => { setSeverityFilters(new Set()); setStatusFilters(new Set()) }}
                  className="text-xs text-neutral-500 hover:text-orange-400"
                >
                  Reset all
                </button>
              </div>
              <div className="grid grid-cols-2 divide-x divide-neutral-800">
                {/* Severity */}
                <div className="p-3">
                  <div className="text-[10px] font-semibold text-neutral-500 uppercase tracking-wider mb-2">Severity</div>
                  {["critical", "high", "medium", "low", "info"].map(s => (
                    <label key={s} className="flex items-center gap-2 py-0.5 cursor-pointer group">
                      <input
                        type="checkbox"
                        checked={severityFilters.has(s)}
                        onChange={() => setSeverityFilters(prev => {
                          const next = new Set(prev)
                          next.has(s) ? next.delete(s) : next.add(s)
                          return next
                        })}
                        className="accent-orange-500"
                      />
                      <span className={`text-xs ${severityFilters.has(s) ? "text-orange-400" : "text-neutral-300 group-hover:text-white"}`}>
                        {s.toUpperCase()}
                        <span className="ml-1 text-neutral-500 font-mono">{counts[s as keyof typeof counts] ?? 0}</span>
                      </span>
                    </label>
                  ))}
                </div>
                {/* Status */}
                <div className="p-3">
                  <div className="text-[10px] font-semibold text-neutral-500 uppercase tracking-wider mb-2">Status</div>
                  {[
                    { value: "open", label: "Open" },
                    { value: "confirmed", label: "Confirmed" },
                    { value: "false_positive", label: "False Positive" },
                    { value: "fixed", label: "Fixed" },
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
                      <span className={`text-xs ${statusFilters.has(s.value) ? "text-orange-400" : "text-neutral-300 group-hover:text-white"}`}>{s.label}</span>
                    </label>
                  ))}
                </div>
              </div>
            </div>
          )}
        </div>

        {/* Stats bar */}
        <div className="flex items-center border-b border-neutral-800 text-xs flex-shrink-0 bg-neutral-900">
          {(["critical", "high", "medium", "low", "info"] as const).map((sev, i) => (
            <div key={sev} className={`flex items-center gap-1.5 px-3 py-1.5 ${i > 0 ? "border-l border-neutral-800" : ""}`}>
              <span className="text-neutral-500">{sev.charAt(0).toUpperCase() + sev.slice(1)}:</span>
              <span className={`font-mono font-semibold ${SEVERITY_COLORS[sev]?.includes("red") ? "text-red-400" : sev === "high" ? "text-orange-400" : sev === "medium" ? "text-yellow-400" : sev === "low" ? "text-blue-400" : "text-neutral-400"}`}>
                {counts[sev]}
              </span>
            </div>
          ))}
          {avgCostPerFinding !== null && (
            <div className="flex items-center gap-1.5 px-3 py-1.5 border-l border-neutral-800">
              <span className="text-neutral-500">Avg/finding:</span>
              <span className="font-mono font-semibold text-green-400">
                ${avgCostPerFinding < 0.0001 ? avgCostPerFinding.toExponential(2) : avgCostPerFinding.toFixed(4)}
              </span>
            </div>
          )}
          <div className="flex items-center gap-1.5 px-3 py-1.5 border-l border-neutral-800 ml-auto">
            <span className="text-neutral-500">Showing:</span>
            <span className="font-mono font-semibold text-white">{filteredFindings.length}</span>
            {filteredFindings.length !== findings.length && (
              <span className="text-neutral-600">of {findings.length}</span>
            )}
          </div>
        </div>

        {/* Findings Table */}
        <div className="flex-1 overflow-y-auto min-h-0">
          {loading && findings.length === 0 && (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="w-6 h-6 animate-spin text-orange-500" />
            </div>
          )}
          {!loading && findings.length === 0 && (
            <div className="flex flex-col items-center justify-center py-12 text-neutral-500">
              <ShieldAlert className="w-12 h-12 mb-3 opacity-30" />
              <p className="text-sm">No findings yet</p>
              <p className="text-xs mt-1">Findings are created by the AI or from test runs</p>
            </div>
          )}
          {filteredFindings.length === 0 && findings.length > 0 && (
            <div className="flex flex-col items-center justify-center py-12 text-neutral-500">
              <p className="text-sm">No findings match the current filters</p>
              <button
                onClick={() => { setSeverityFilters(new Set()); setStatusFilters(new Set()); setSearch("") }}
                className="text-xs text-orange-400 hover:text-orange-300 mt-2"
              >
                Clear filters
              </button>
            </div>
          )}
          {filteredFindings.length > 0 && (
            <table className="w-full table-fixed text-sm">
              <colgroup>
                <col style={{ width: "24px" }} />
                <col style={{ width: "80px" }} />
                <col /> {/* title — flex fill */}
                <col style={{ width: "160px" }} />
                <col style={{ width: "100px" }} />
                <col style={{ width: "80px" }} />
                <col style={{ width: "32px" }} />
              </colgroup>
              <thead className="sticky top-0 z-10 bg-neutral-800">
                <tr className="border-b border-neutral-700">
                  <th className="px-2 py-1.5 text-left" />
                  <th className="px-2 py-1.5 text-left text-[11px] font-semibold text-neutral-400 uppercase tracking-wider">Severity</th>
                  <th className="px-2 py-1.5 text-left text-[11px] font-semibold text-neutral-400 uppercase tracking-wider">Title</th>
                  <th className="px-2 py-1.5 text-left text-[11px] font-semibold text-neutral-400 uppercase tracking-wider">Host</th>
                  <th className="px-2 py-1.5 text-left text-[11px] font-semibold text-neutral-400 uppercase tracking-wider">Type</th>
                  <th className="px-2 py-1.5 text-left text-[11px] font-semibold text-neutral-400 uppercase tracking-wider">Status</th>
                  <th className="px-2 py-1.5" />
                </tr>
              </thead>
              <tbody>
                {filteredFindings.map(finding => (
                  <React.Fragment key={finding.id}>
                    <tr
                      className={`border-b border-neutral-800 cursor-pointer transition-colors ${
                        expanded.has(finding.id) ? "bg-neutral-800/60" : "hover:bg-neutral-800/40"
                      }`}
                      onClick={() => toggleExpand(finding.id)}
                    >
                      <td className="px-2 py-2 text-neutral-500">
                        {expanded.has(finding.id)
                          ? <ChevronDown className="w-3 h-3" />
                          : <ChevronRight className="w-3 h-3" />
                        }
                      </td>
                      <td className="px-2 py-2">
                        <Badge className={`text-xs px-1.5 py-0 border-0 ${SEVERITY_COLORS[finding.severity] ?? "bg-neutral-600 text-white"}`}>
                          {finding.severity.toUpperCase()}
                        </Badge>
                      </td>
                      <td className="px-2 py-2">
                        <span className="text-white text-xs truncate block">{finding.title}</span>
                      </td>
                      <td className="px-2 py-2">
                        <span className="text-neutral-400 text-xs font-mono truncate block">{finding.host}</span>
                      </td>
                      <td className="px-2 py-2">
                        <span className="text-neutral-400 text-xs truncate block">{finding.type}</span>
                      </td>
                      <td className="px-2 py-2">
                        <button
                          onClick={e => { e.stopPropagation(); cycleStatus(finding) }}
                          className={`text-xs font-mono hover:text-white transition-colors ${STATUS_COLORS[finding.status] ?? "text-neutral-400"}`}
                        >
                          {finding.status.replace("_", " ")}
                        </button>
                      </td>
                      <td className="px-2 py-2">
                        <button
                          onClick={e => { e.stopPropagation(); deleteFinding(finding.id) }}
                          className="text-neutral-600 hover:text-red-400 transition-colors"
                        >
                          <Trash2 className="w-3 h-3" />
                        </button>
                      </td>
                    </tr>
                    {expanded.has(finding.id) && (
                      <tr className="border-b border-neutral-800 bg-neutral-900">
                        <td colSpan={7} className="px-4 py-3">
                          <div className="space-y-2">
                            <div className="flex gap-4 text-xs text-neutral-400">
                              <span>Source: <span className="text-white">{finding.source}</span></span>
                              {finding.request_id && (
                                <span>Request: <span className="text-orange-400 font-mono">{finding.request_id.slice(0, 8)}…</span></span>
                              )}
                              <span>Created: <span className="text-white font-mono">{new Date(finding.created_at).toLocaleString()}</span></span>
                            </div>
                            {(finding.description || finding.evidence) && (
                              <div className="flex gap-3 min-h-0">
                                {finding.description && (
                                  <div className="flex-1 min-w-0">
                                    <p className="text-[10px] text-neutral-500 uppercase tracking-wider mb-1">Description</p>
                                    <p className="text-xs text-neutral-200 leading-relaxed">{finding.description}</p>
                                  </div>
                                )}
                                {finding.evidence && (
                                  <div className="flex-1 min-w-0">
                                    <p className="text-[10px] text-neutral-500 uppercase tracking-wider mb-1">Evidence</p>
                                    <pre className="text-xs text-green-300 bg-neutral-950 p-2 font-mono whitespace-pre-wrap border border-neutral-800 overflow-x-auto">{finding.evidence}</pre>
                                  </div>
                                )}
                              </div>
                            )}
                          </div>
                        </td>
                      </tr>
                    )}
                  </React.Fragment>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>

      {/* AI Chat Panel */}
      {chatOpen && (
        <aside className="w-80 border-l border-neutral-800 flex flex-col bg-neutral-900 flex-shrink-0">
          <div className="px-3 py-2 border-b border-neutral-800 flex items-center justify-between">
            <span className="text-xs font-semibold text-orange-500">AI SECURITY ANALYST</span>
            <Button variant="ghost" size="icon" className="h-6 w-6 text-neutral-400 hover:text-white" onClick={() => setChatOpen(false)}>
              <X className="w-3 h-3" />
            </Button>
          </div>
          <div className="flex-1 overflow-y-auto p-3 space-y-2">
            {chatMessages.length === 0 && (
              <p className="text-xs text-neutral-500">Ask the AI to analyse findings, suggest remediations, or correlate vulnerabilities.</p>
            )}
            {chatMessages.map((msg, i) => (
              <div key={i} className={`text-xs p-2 border ${msg.role === "user" ? "bg-neutral-800 border-neutral-700 text-white ml-4" : "bg-neutral-800/40 border-neutral-800 text-neutral-200 mr-4"}`}>
                <span className="font-semibold text-orange-400 block mb-1">{msg.role === "user" ? "You" : "AI"}</span>
                <span className="whitespace-pre-wrap">{msg.content}</span>
              </div>
            ))}
            {chatLoading && (
              <div className="bg-neutral-800/40 border border-neutral-800 p-2 mr-4">
                <Loader2 className="w-3 h-3 animate-spin text-orange-400" />
              </div>
            )}
          </div>
          <div className="p-2 border-t border-neutral-800 flex gap-2">
            <Textarea
              value={chatInput}
              onChange={e => setChatInput(e.target.value)}
              onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendChat() } }}
              placeholder="Ask about security findings..."
              className="flex-1 text-xs bg-neutral-800 border-neutral-700 text-white resize-none min-h-0 h-16 rounded-none"
            />
            <Button
              size="icon"
              onClick={sendChat}
              disabled={chatLoading || !chatInput.trim()}
              className="bg-orange-500 hover:bg-orange-600 self-end h-8 w-8 rounded-none"
            >
              <ChevronRight className="w-4 h-4" />
            </Button>
          </div>
        </aside>
      )}
    </div>
  )
}
