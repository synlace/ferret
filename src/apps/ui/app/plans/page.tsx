"use client"

import { apiFetch } from "@/lib/api-fetch"

import React, { useState, useEffect, useCallback, useRef } from "react"
import { Plus, Pencil, Trash2, Copy, Loader2, X, ChevronRight, Save } from "lucide-react"
import { useProject } from "../context/project-context"

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000"

const LIST_WIDTH_KEY = "ferret_plans_list_width"
const DEFAULT_LIST_WIDTH = 240
const MIN_LIST_WIDTH = 160
const MAX_LIST_WIDTH = 400

interface Plan {
  id: string
  name: string
  description: string
  tool: string
  prompt: string
  max_tool_calls: number
  is_builtin: boolean
  created_at: string
}

type ToolFilter = "all" | "script" | "hunt" | "gnaw" | "pounce" | "snare"

const TOOL_TABS: { key: ToolFilter; label: string }[] = [
  { key: "all",    label: "All" },
  { key: "script", label: "Scripts" },
  { key: "hunt",   label: "Prompts" },
]

const TOOL_BADGE: Record<string, string> = {
  script: "bg-orange-500/20 text-orange-300 border-orange-500/40",
  hunt:   "bg-brand-500/20 text-brand-300 border-brand-500/40",
  gnaw:   "bg-blue-500/20 text-blue-300 border-blue-500/40",
  pounce: "bg-purple-500/20 text-purple-300 border-purple-500/40",
  snare:  "bg-green-500/20 text-green-300 border-green-500/40",
}

// ─── New Plan Modal (create only) ─────────────────────────────────────────────
interface NewPlanModalProps {
  projectId: string
  onClose: () => void
  onSaved: (plan: Plan) => void
}

function NewPlanModal({ projectId, onClose, onSaved }: NewPlanModalProps) {
  const [name, setName] = useState("")
  const [description, setDescription] = useState("")
  const [tool, setTool] = useState("hunt")
  const [prompt, setPrompt] = useState("")
  const [maxToolCalls, setMaxToolCalls] = useState(20)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState("")

  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === "Escape") onClose() }
    document.addEventListener("keydown", handler)
    return () => document.removeEventListener("keydown", handler)
  }, [onClose])

  const handleSave = async () => {
    if (!name.trim()) { setError("Name is required"); return }
    setSaving(true); setError("")
    try {
      const body = { project_id: projectId, name: name.trim(), description, tool, prompt, max_tool_calls: maxToolCalls }
      const res = await apiFetch(`${API_BASE}/api/plans`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })
      if (!res.ok) { const d = await res.json().catch(() => ({})); setError(d.detail ?? "Save failed"); return }
      const created = await res.json()
      onSaved(created)
    } catch { setError("Network error") } finally { setSaving(false) }
  }

  return (
    <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50" onClick={onClose} data-modal>
      <div className="bg-neutral-900 border border-neutral-700 w-[520px] max-h-[90vh] flex flex-col shadow-2xl" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between px-4 py-3 border-b border-neutral-800 flex-shrink-0">
          <h2 className="text-sm font-semibold text-white">New Plan</h2>
          <button onClick={onClose} className="text-neutral-400 hover:text-white transition-colors"><X className="w-4 h-4" /></button>
        </div>
        <div className="flex-1 overflow-y-auto px-4 py-3 space-y-3">
          {error && <p className="text-xs text-red-400 bg-red-500/10 border border-red-500/30 px-2 py-1.5">{error}</p>}
          <div>
            <label className="text-[10px] text-neutral-500 uppercase tracking-wider block mb-1">Name</label>
            <input autoFocus value={name} onChange={e => setName(e.target.value)} placeholder="e.g. OWASP Top 10 Hunt"
              className="w-full bg-neutral-800 border border-neutral-700 px-2 py-1.5 text-sm text-white placeholder:text-neutral-600 focus:outline-none focus:border-brand-500/60" />
          </div>
          <div>
            <label className="text-[10px] text-neutral-500 uppercase tracking-wider block mb-1">Description</label>
            <input value={description} onChange={e => setDescription(e.target.value)} placeholder="Short description"
              className="w-full bg-neutral-800 border border-neutral-700 px-2 py-1.5 text-sm text-white placeholder:text-neutral-600 focus:outline-none focus:border-brand-500/60" />
          </div>
          <div>
            <label className="text-[10px] text-neutral-500 uppercase tracking-wider block mb-1">Tool</label>
            <select value={tool} onChange={e => setTool(e.target.value)}
              className="w-full bg-neutral-800 border border-neutral-700 px-2 py-1.5 text-sm text-white focus:outline-none focus:border-brand-500/60">
              <option value="hunt">hunt</option>
              <option value="gnaw">gnaw</option>
              <option value="pounce">pounce</option>
              <option value="snare">snare</option>
            </select>
          </div>
          <div>
            <label className="text-[10px] text-neutral-500 uppercase tracking-wider block mb-1">Prompt</label>
            <textarea value={prompt} onChange={e => setPrompt(e.target.value)} placeholder="System prompt or instructions..." rows={8}
              className="w-full bg-neutral-800 border border-neutral-700 px-2 py-1.5 text-sm text-white placeholder:text-neutral-600 focus:outline-none focus:border-brand-500/60 resize-none font-mono" />
          </div>
          <div>
            <label className="text-[10px] text-neutral-500 uppercase tracking-wider block mb-1">Max Tool Calls</label>
            <input type="number" min={1} max={200} value={maxToolCalls}
              onChange={e => setMaxToolCalls(Math.max(1, Math.min(200, Number(e.target.value))))}
              className="w-24 bg-neutral-800 border border-neutral-700 px-2 py-1.5 text-sm text-white focus:outline-none focus:border-brand-500/60 text-center" />
          </div>
        </div>
        <div className="flex gap-2 px-4 py-3 border-t border-neutral-800 flex-shrink-0">
          <button onClick={handleSave} disabled={saving}
            className="flex-1 bg-brand-500 hover:bg-brand-600 disabled:opacity-40 text-neutral-900 text-sm py-2 transition-colors flex items-center justify-center gap-1.5">
            {saving && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
            {saving ? "Saving..." : "Create Plan"}
          </button>
          <button onClick={onClose} className="px-4 py-2 text-sm text-neutral-300 border border-neutral-700 hover:bg-neutral-800 transition-colors">Cancel</button>
        </div>
      </div>
    </div>
  )
}

// ─── Plan List Item ───────────────────────────────────────────────────────────
interface PlanListItemProps {
  plan: Plan
  selected: boolean
  onClick: () => void
  dimmed: boolean
}

function PlanListItem({ plan, selected, onClick, dimmed }: PlanListItemProps) {
  const badgeClass = TOOL_BADGE[plan.tool] ?? "bg-neutral-700 text-neutral-300 border-neutral-600"
  return (
    <button
      onClick={onClick}
      className={`w-full text-left px-3 h-[54px] flex-shrink-0 flex flex-col justify-center gap-1 transition-colors border-b border-neutral-800/60 last:border-b-0 ${
        selected ? "bg-neutral-800 text-white" : "hover:bg-neutral-900/80 text-neutral-300"
      } ${dimmed ? "opacity-40 pointer-events-none" : ""}`}
    >
      <div className="w-full flex items-center justify-between gap-2">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5 flex-wrap">
            <span className="text-xs font-medium leading-tight truncate">{plan.name}</span>
            <span className={`text-[8px] font-bold uppercase px-1 py-0.5 border flex-shrink-0 ${badgeClass}`}>{plan.tool}</span>
            {plan.is_builtin && (
              <span className="text-[8px] text-neutral-600 border border-neutral-800 px-1 py-0.5 flex-shrink-0">built-in</span>
            )}
          </div>
          {plan.description && (
            <p className="text-[10px] text-neutral-500 mt-0.5 truncate">{plan.description}</p>
          )}
        </div>
        <ChevronRight className={`w-3 h-3 flex-shrink-0 transition-colors ${selected ? "text-brand-400" : "text-neutral-700"}`} />
      </div>
    </button>
  )
}

// ─── Plan Detail / Inline Edit Panel ─────────────────────────────────────────
interface PlanDetailProps {
  plan: Plan
  onSaved: (updated: Plan) => void
  onDelete: () => void
  onClone: () => void
  actionLoading: boolean
}

function PlanDetail({ plan, onSaved, onDelete, onClone, actionLoading }: PlanDetailProps) {
  const [editing, setEditing] = useState(false)
  const [name, setName] = useState(plan.name)
  const [description, setDescription] = useState(plan.description)
  const [tool, setTool] = useState(plan.tool)
  const [prompt, setPrompt] = useState(plan.prompt)
  const [maxToolCalls, setMaxToolCalls] = useState(plan.max_tool_calls)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState("")

  // Reset form when plan changes
  useEffect(() => {
    setEditing(false)
    setName(plan.name)
    setDescription(plan.description)
    setTool(plan.tool)
    setPrompt(plan.prompt)
    setMaxToolCalls(plan.max_tool_calls)
    setError("")
  }, [plan.id]) // eslint-disable-line react-hooks/exhaustive-deps

  const handleSave = async () => {
    if (!name.trim()) { setError("Name is required"); return }
    setSaving(true); setError("")
    try {
      const body = { name: name.trim(), description, tool, prompt, max_tool_calls: maxToolCalls }
      const res = await apiFetch(`${API_BASE}/api/plans/${plan.id}`, {
        method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
      })
      if (!res.ok) { const d = await res.json().catch(() => ({})); setError(d.detail ?? "Save failed"); return }
      const updated = await res.json()
      setEditing(false)
      onSaved(updated)
    } catch { setError("Network error") } finally { setSaving(false) }
  }

  const handleCancel = () => {
    setEditing(false)
    setName(plan.name); setDescription(plan.description)
    setTool(plan.tool); setPrompt(plan.prompt)
    setMaxToolCalls(plan.max_tool_calls); setError("")
  }

  const badgeClass = TOOL_BADGE[plan.tool] ?? "bg-neutral-700 text-neutral-300 border-neutral-600"
  const editBadgeClass = TOOL_BADGE[tool] ?? "bg-neutral-700 text-neutral-300 border-neutral-600"

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Detail header */}
      <div className="flex items-start justify-between px-4 py-3 border-b border-neutral-800 bg-[#171717] flex-shrink-0 gap-3">
        <div className="flex-1 min-w-0">
          {editing ? (
            <div className="space-y-2">
              <input
                value={name} onChange={e => setName(e.target.value)} autoFocus
                className="w-full bg-neutral-800 border border-neutral-700 px-2 py-1 text-sm text-white focus:outline-none focus:border-brand-500/60"
                placeholder="Plan name"
              />
              <input
                value={description} onChange={e => setDescription(e.target.value)}
                className="w-full bg-neutral-800 border border-neutral-700 px-2 py-1 text-xs text-white placeholder:text-neutral-600 focus:outline-none focus:border-brand-500/60"
                placeholder="Description (optional)"
              />
            </div>
          ) : (
            <div>
              <div className="flex items-center gap-2 flex-wrap mb-0.5">
                <span className="text-sm font-semibold text-white leading-tight">{plan.name}</span>
                <span className={`text-[9px] font-bold uppercase px-1.5 py-0.5 border ${badgeClass}`}>{plan.tool}</span>
                {plan.is_builtin && (
                  <span className="text-[9px] text-neutral-500 border border-neutral-700 px-1.5 py-0.5">built-in</span>
                )}
              </div>
              {plan.description && <p className="text-xs text-neutral-400 leading-relaxed">{plan.description}</p>}
            </div>
          )}
        </div>

        {/* Actions */}
        <div className="flex items-center gap-1 flex-shrink-0">
          {editing ? (
            <>
              <button onClick={handleSave} disabled={saving}
                className="flex items-center gap-1 text-[10px] text-neutral-900 bg-brand-500 hover:bg-brand-600 disabled:opacity-40 px-2 py-1 transition-colors">
                {saving ? <Loader2 className="w-2.5 h-2.5 animate-spin" /> : <Save className="w-2.5 h-2.5" />}
                {saving ? "Saving…" : "Save"}
              </button>
              <button onClick={handleCancel} disabled={saving}
                className="flex items-center gap-1 text-[10px] text-neutral-400 hover:text-white border border-neutral-700 hover:border-neutral-500 px-2 py-1 transition-colors">
                <X className="w-2.5 h-2.5" />Cancel
              </button>
            </>
          ) : plan.is_builtin ? (
            <button onClick={onClone} disabled={actionLoading}
              className="flex items-center gap-1 text-[10px] text-neutral-400 hover:text-brand-400 border border-neutral-700 hover:border-brand-500/40 px-2 py-1 transition-colors disabled:opacity-40">
              <Copy className="w-2.5 h-2.5" />Clone
            </button>
          ) : (
            <>
              <button onClick={() => setEditing(true)} disabled={actionLoading}
                className="flex items-center gap-1 text-[10px] text-neutral-400 hover:text-brand-400 border border-neutral-700 hover:border-brand-500/40 px-2 py-1 transition-colors disabled:opacity-40">
                <Pencil className="w-2.5 h-2.5" />Edit
              </button>
              <button onClick={onDelete} disabled={actionLoading}
                className="flex items-center gap-1 text-[10px] text-neutral-400 hover:text-red-400 border border-neutral-700 hover:border-red-500/40 px-2 py-1 transition-colors disabled:opacity-40">
                <Trash2 className="w-2.5 h-2.5" />Delete
              </button>
            </>
          )}
        </div>
      </div>

      {/* Error */}
      {error && (
        <div className="px-4 py-2 flex-shrink-0">
          <p className="text-xs text-red-400 bg-red-500/10 border border-red-500/30 px-2 py-1.5">{error}</p>
        </div>
      )}

      {/* Meta row */}
      <div className="flex items-center gap-4 px-4 h-[27px] border-b border-neutral-800/60 flex-shrink-0">
        {editing ? (
          <div className="flex items-center gap-4">
            <div className="flex items-center gap-2">
              <label className="text-[10px] text-neutral-500">Tool</label>
              <select value={tool} onChange={e => setTool(e.target.value)}
                className="bg-neutral-800 border border-neutral-700 px-2 py-0.5 text-xs text-white focus:outline-none focus:border-brand-500/60">
                <option value="hunt">hunt</option>
                <option value="gnaw">gnaw</option>
                <option value="pounce">pounce</option>
                <option value="snare">snare</option>
              </select>
              <span className={`text-[8px] font-bold uppercase px-1 py-0.5 border ${editBadgeClass}`}>{tool}</span>
            </div>
            <div className="flex items-center gap-2">
              <label className="text-[10px] text-neutral-500">Max calls</label>
              <input type="number" min={1} max={200} value={maxToolCalls}
                onChange={e => setMaxToolCalls(Math.max(1, Math.min(200, Number(e.target.value))))}
                className="w-16 bg-neutral-800 border border-neutral-700 px-2 py-0.5 text-xs text-white focus:outline-none focus:border-brand-500/60 text-center" />
            </div>
          </div>
        ) : (
          <>
            <span className="text-[10px] text-neutral-500">Max tool calls: <span className="text-neutral-300 font-mono">{plan.max_tool_calls}</span></span>
            <span className="text-[10px] text-neutral-600 font-mono truncate">{plan.id}</span>
          </>
        )}
      </div>

      {/* Prompt body */}
      <div className="flex-1 overflow-y-auto px-4 py-3 flex flex-col">
        <div className="text-[10px] text-neutral-500 uppercase tracking-wider mb-2">Prompt</div>
        {editing ? (
          <textarea
            value={prompt} onChange={e => setPrompt(e.target.value)}
            placeholder="System prompt or instructions for the AI agent..."
            className="flex-1 w-full bg-neutral-800 border border-neutral-700 px-3 py-2 text-xs text-white placeholder:text-neutral-600 focus:outline-none focus:border-brand-500/60 resize-none font-mono leading-relaxed min-h-[200px]"
          />
        ) : plan.prompt ? (
          <pre className="text-xs text-neutral-300 font-mono whitespace-pre-wrap leading-relaxed">{plan.prompt}</pre>
        ) : (
          <p className="text-xs text-neutral-600 italic">No prompt defined.</p>
        )}
      </div>
    </div>
  )
}

// ─── Plans Page ───────────────────────────────────────────────────────────────
export default function PlansPage() {
  const { activeProjectId } = useProject()
  const [plans, setPlans] = useState<Plan[]>([])
  const [loading, setLoading] = useState(false)
  const [toolFilter, setToolFilter] = useState<ToolFilter>("all")
  const [selectedPlanId, setSelectedPlanId] = useState<string | null>(null)
  const [showNewModal, setShowNewModal] = useState(false)
  const [actionLoading, setActionLoading] = useState<string | null>(null)

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

  // ── Data ──────────────────────────────────────────────────────────────────
  const fetchPlans = useCallback(async () => {
    if (!activeProjectId) return
    setLoading(true)
    try {
      const res = await apiFetch(`${API_BASE}/api/plans?project_id=${activeProjectId}`)
      if (res.ok) setPlans(await res.json())
    } catch { /* ignore */ } finally { setLoading(false) }
  }, [activeProjectId])

  useEffect(() => { fetchPlans() }, [fetchPlans])

  // Keep selectedPlanId valid when list changes
  useEffect(() => {
    if (selectedPlanId && !plans.some(p => p.id === selectedPlanId)) setSelectedPlanId(null)
  }, [plans, selectedPlanId])

  const handleDelete = async (plan: Plan) => {
    if (!window.confirm(`Delete plan "${plan.name}"? This cannot be undone.`)) return
    setActionLoading(plan.id)
    try {
      await apiFetch(`${API_BASE}/api/plans/${plan.id}?project_id=${activeProjectId}`, { method: "DELETE" })
      if (selectedPlanId === plan.id) setSelectedPlanId(null)
      await fetchPlans()
    } catch { /* ignore */ } finally { setActionLoading(null) }
  }

  const handleClone = async (plan: Plan) => {
    setActionLoading(plan.id)
    try {
      const res = await apiFetch(`${API_BASE}/api/plans/${plan.id}/clone?project_id=${activeProjectId}`, { method: "POST" })
      if (res.ok) {
        const cloned = await res.json()
        await fetchPlans()
        setSelectedPlanId(cloned.id)
      } else {
        await fetchPlans()
      }
    } catch { /* ignore */ } finally { setActionLoading(null) }
  }

  const handleSaved = (updated: Plan) => {
    setPlans(prev => prev.map(p => p.id === updated.id ? updated : p))
  }

  const filtered = toolFilter === "all" ? plans : plans.filter(p => p.tool === toolFilter)
  const selectedPlan = plans.find(p => p.id === selectedPlanId) ?? null

  return (
    <div className={`flex flex-col h-full bg-neutral-950 text-white overflow-hidden${isDragging ? " select-none" : ""}`}>
      {/* Header */}
      <div className="flex items-center justify-between px-4 h-[48px] border-b border-neutral-800 bg-[#171717] flex-shrink-0">
        <div className="flex flex-col min-w-0">
          <span className="text-sm font-bold tracking-wider text-white">Plans</span>
          <span className="text-[10px] text-neutral-500 mt-0.5 leading-none whitespace-nowrap truncate">Blueprint templates</span>
        </div>
        <button
          onClick={() => setShowNewModal(true)}
          className="flex items-center justify-center w-6 h-6 bg-brand-400 hover:bg-brand-300 text-neutral-950 transition-colors rounded-sm flex-shrink-0"
          title="New Plan"
        >
          <Plus className="w-3.5 h-3.5" />
        </button>
      </div>

      {/* Tool filter tabs */}
      <div className="flex items-center gap-0 h-[36px] border-b border-neutral-800 bg-neutral-900/40 flex-shrink-0 px-4">
        {TOOL_TABS.map(tab => (
          <button
            key={tab.key}
            onClick={() => setToolFilter(tab.key)}
            className={`px-3 h-full text-[10px] font-medium transition-colors border-b-2 -mb-px ${
              toolFilter === tab.key
                ? "text-brand-400 border-brand-500"
                : "text-neutral-500 border-transparent hover:text-neutral-300"
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* Split pane */}
      <div className="flex-1 flex overflow-hidden">
        {/* Left: plan list */}
        <div
          className="flex-shrink-0 border-r border-neutral-800 bg-[#0a0a0a] flex flex-col overflow-hidden"
          style={{ width: `${listWidth}px` }}
        >
          <div className="flex-1 overflow-y-auto">
            {!activeProjectId && (
              <p className="text-xs text-neutral-600 text-center py-8 px-3">Select a project to view plans.</p>
            )}
            {activeProjectId && loading && (
              <div className="flex items-center justify-center py-12">
                <Loader2 className="w-5 h-5 animate-spin text-brand-500" />
              </div>
            )}
            {activeProjectId && !loading && filtered.length === 0 && (
              <div className="flex flex-col items-center justify-center py-12 text-neutral-600 px-3">
                <p className="text-sm mb-2">No plans yet.</p>
                <button onClick={() => setShowNewModal(true)} className="text-xs text-brand-400 hover:text-brand-300 transition-colors">
                  Create your first plan →
                </button>
              </div>
            )}
            {activeProjectId && !loading && filtered.length > 0 && (
              <div>
                {filtered.map(plan => (
                  <PlanListItem
                    key={plan.id}
                    plan={plan}
                    selected={selectedPlanId === plan.id}
                    onClick={() => setSelectedPlanId(plan.id)}
                    dimmed={actionLoading === plan.id}
                  />
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Drag handle */}
        <div
          onMouseDown={handleDragStart}
          className="w-1 flex-shrink-0 bg-neutral-800 hover:bg-brand-500 transition-colors cursor-col-resize z-10"
        />

        {/* Right: detail panel */}
        <div className="flex-1 overflow-hidden">
          {selectedPlan ? (
            <PlanDetail
              key={selectedPlan.id}
              plan={selectedPlan}
              onSaved={handleSaved}
              onDelete={() => handleDelete(selectedPlan)}
              onClone={() => handleClone(selectedPlan)}
              actionLoading={actionLoading === selectedPlan.id}
            />
          ) : (
            <div className="flex items-center justify-center h-full text-neutral-700">
              <p className="text-xs">Select a plan to view its contents</p>
            </div>
          )}
        </div>
      </div>

      {/* New plan modal */}
      {showNewModal && (
        <NewPlanModal
          projectId={activeProjectId}
          onClose={() => setShowNewModal(false)}
          onSaved={created => {
            setPlans(prev => [...prev, created])
            setSelectedPlanId(created.id)
            setShowNewModal(false)
          }}
        />
      )}
    </div>
  )
}
