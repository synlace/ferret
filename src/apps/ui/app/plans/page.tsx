"use client"

import React, { useState, useEffect, useCallback } from "react"
import { Plus, Pencil, Trash2, Copy, Loader2, X } from "lucide-react"
import { useProject } from "../context/project-context"

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000"

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

type ToolFilter = "all" | "hunt" | "gnaw" | "pounce" | "snare"

const TOOL_TABS: { key: ToolFilter; label: string }[] = [
  { key: "all",    label: "All" },
  { key: "hunt",   label: "Hunts" },
  { key: "gnaw",   label: "Gnaw" },
  { key: "pounce", label: "Pounce" },
  { key: "snare",  label: "Snare" },
]

const TOOL_BADGE: Record<string, string> = {
  hunt:   "bg-orange-500/20 text-orange-300 border-orange-500/40",
  gnaw:   "bg-blue-500/20 text-blue-300 border-blue-500/40",
  pounce: "bg-purple-500/20 text-purple-300 border-purple-500/40",
  snare:  "bg-green-500/20 text-green-300 border-green-500/40",
}

// ─── Plan Edit/Create Modal ───────────────────────────────────────────────────
interface PlanModalProps {
  plan: Plan | null  // null = create mode
  projectId: string
  onClose: () => void
  onSaved: () => void
}

function PlanModal({ plan, projectId, onClose, onSaved }: PlanModalProps) {
  const [name, setName] = useState(plan?.name ?? "")
  const [description, setDescription] = useState(plan?.description ?? "")
  const [tool, setTool] = useState(plan?.tool ?? "hunt")
  const [prompt, setPrompt] = useState(plan?.prompt ?? "")
  const [maxToolCalls, setMaxToolCalls] = useState(plan?.max_tool_calls ?? 20)
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
      const url = plan ? `${API_BASE}/api/plans/${plan.id}` : `${API_BASE}/api/plans`
      const method = plan ? "PUT" : "POST"
      const res = await fetch(url, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })
      if (!res.ok) { const d = await res.json().catch(() => ({})); setError(d.detail ?? "Save failed"); return }
      onSaved()
    } catch { setError("Network error") } finally { setSaving(false) }
  }

  return (
    <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50" onClick={onClose}>
      <div className="bg-neutral-900 border border-neutral-700 w-[520px] max-h-[90vh] flex flex-col shadow-2xl" onClick={e => e.stopPropagation()}>
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-neutral-800 flex-shrink-0">
          <h2 className="text-sm font-semibold text-white">{plan ? "Edit Plan" : "New Plan"}</h2>
          <button onClick={onClose} className="text-neutral-400 hover:text-white transition-colors">
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto px-4 py-3 space-y-3">
          {error && <p className="text-xs text-red-400 bg-red-500/10 border border-red-500/30 px-2 py-1.5">{error}</p>}

          <div>
            <label className="text-[10px] text-neutral-500 uppercase tracking-wider block mb-1">Name</label>
            <input
              autoFocus value={name} onChange={e => setName(e.target.value)}
              placeholder="e.g. OWASP Top 10 Hunt"
              className="w-full bg-neutral-800 border border-neutral-700 px-2 py-1.5 text-sm text-white placeholder:text-neutral-600 focus:outline-none focus:border-orange-500/60"
            />
          </div>

          <div>
            <label className="text-[10px] text-neutral-500 uppercase tracking-wider block mb-1">Description</label>
            <input
              value={description} onChange={e => setDescription(e.target.value)}
              placeholder="Short description of what this plan does"
              className="w-full bg-neutral-800 border border-neutral-700 px-2 py-1.5 text-sm text-white placeholder:text-neutral-600 focus:outline-none focus:border-orange-500/60"
            />
          </div>

          <div>
            <label className="text-[10px] text-neutral-500 uppercase tracking-wider block mb-1">Tool</label>
            <select
              value={tool} onChange={e => setTool(e.target.value)}
              className="w-full bg-neutral-800 border border-neutral-700 px-2 py-1.5 text-sm text-white focus:outline-none focus:border-orange-500/60"
            >
              <option value="hunt">hunt</option>
              <option value="gnaw">gnaw</option>
              <option value="pounce">pounce</option>
              <option value="snare">snare</option>
            </select>
          </div>

          <div>
            <label className="text-[10px] text-neutral-500 uppercase tracking-wider block mb-1">Prompt</label>
            <textarea
              value={prompt} onChange={e => setPrompt(e.target.value)}
              placeholder="System prompt or instructions for the AI agent..."
              rows={8}
              className="w-full bg-neutral-800 border border-neutral-700 px-2 py-1.5 text-sm text-white placeholder:text-neutral-600 focus:outline-none focus:border-orange-500/60 resize-none font-mono"
            />
          </div>

          <div>
            <label className="text-[10px] text-neutral-500 uppercase tracking-wider block mb-1">Max Tool Calls</label>
            <input
              type="number" min={1} max={200} value={maxToolCalls}
              onChange={e => setMaxToolCalls(Math.max(1, Math.min(200, Number(e.target.value))))}
              className="w-24 bg-neutral-800 border border-neutral-700 px-2 py-1.5 text-sm text-white focus:outline-none focus:border-orange-500/60 text-center"
            />
          </div>
        </div>

        {/* Footer */}
        <div className="flex gap-2 px-4 py-3 border-t border-neutral-800 flex-shrink-0">
          <button
            onClick={handleSave} disabled={saving}
            className="flex-1 bg-orange-500 hover:bg-orange-600 disabled:opacity-40 text-white text-sm py-2 transition-colors flex items-center justify-center gap-1.5"
          >
            {saving && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
            {saving ? "Saving..." : "Save Plan"}
          </button>
          <button onClick={onClose} className="px-4 py-2 text-sm text-neutral-300 border border-neutral-700 hover:bg-neutral-800 transition-colors">
            Cancel
          </button>
        </div>
      </div>
    </div>
  )
}

// ─── Plan Card ────────────────────────────────────────────────────────────────
interface PlanCardProps {
  plan: Plan
  onEdit: () => void
  onDelete: () => void
  onClone: () => void
}

function PlanCard({ plan, onEdit, onDelete, onClone }: PlanCardProps) {
  const badgeClass = TOOL_BADGE[plan.tool] ?? "bg-neutral-700 text-neutral-300 border-neutral-600"
  return (
    <div className="bg-neutral-900 border border-neutral-800 p-3 flex flex-col gap-2 hover:border-neutral-700 transition-colors">
      {/* Header row */}
      <div className="flex items-start gap-2">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-sm font-semibold text-white leading-tight">{plan.name}</span>
            <span className={`text-[9px] font-bold uppercase px-1.5 py-0.5 border ${badgeClass}`}>
              {plan.tool}
            </span>
            {plan.is_builtin && (
              <span className="text-[9px] text-neutral-500 border border-neutral-700 px-1.5 py-0.5">
                built-in
              </span>
            )}
          </div>
          {plan.description && (
            <p className="text-xs text-neutral-400 mt-1 leading-relaxed line-clamp-2">{plan.description}</p>
          )}
        </div>
      </div>

      {/* Footer row: meta + actions */}
      <div className="flex items-center justify-between">
        <span className="text-[9px] text-neutral-600 font-mono">max {plan.max_tool_calls} calls</span>
        <div className="flex items-center gap-1">
          {plan.is_builtin ? (
            <button
              onClick={onClone}
              className="flex items-center gap-1 text-[10px] text-neutral-400 hover:text-orange-400 border border-neutral-700 hover:border-orange-500/40 px-2 py-0.5 transition-colors"
              title="Clone to edit"
            >
              <Copy className="w-2.5 h-2.5" />Clone
            </button>
          ) : (
            <>
              <button
                onClick={onEdit}
                className="flex items-center gap-1 text-[10px] text-neutral-400 hover:text-orange-400 border border-neutral-700 hover:border-orange-500/40 px-2 py-0.5 transition-colors"
                title="Edit plan"
              >
                <Pencil className="w-2.5 h-2.5" />Edit
              </button>
              <button
                onClick={onDelete}
                className="flex items-center gap-1 text-[10px] text-neutral-400 hover:text-red-400 border border-neutral-700 hover:border-red-500/40 px-2 py-0.5 transition-colors"
                title="Delete plan"
              >
                <Trash2 className="w-2.5 h-2.5" />Delete
              </button>
            </>
          )}
        </div>
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
  const [editingPlan, setEditingPlan] = useState<Plan | null | undefined>(undefined) // undefined = closed, null = new
  const [actionLoading, setActionLoading] = useState<string | null>(null)

  const fetchPlans = useCallback(async () => {
    if (!activeProjectId) return
    setLoading(true)
    try {
      const res = await fetch(`${API_BASE}/api/plans?project_id=${activeProjectId}`)
      if (res.ok) setPlans(await res.json())
    } catch { /* ignore */ } finally { setLoading(false) }
  }, [activeProjectId])

  useEffect(() => { fetchPlans() }, [fetchPlans])

  const handleDelete = async (plan: Plan) => {
    if (!window.confirm(`Delete plan "${plan.name}"? This cannot be undone.`)) return
    setActionLoading(plan.id)
    try {
      await fetch(`${API_BASE}/api/plans/${plan.id}?project_id=${activeProjectId}`, { method: "DELETE" })
      await fetchPlans()
    } catch { /* ignore */ } finally { setActionLoading(null) }
  }

  const handleClone = async (plan: Plan) => {
    setActionLoading(plan.id)
    try {
      await fetch(`${API_BASE}/api/plans/${plan.id}/clone?project_id=${activeProjectId}`, { method: "POST" })
      await fetchPlans()
    } catch { /* ignore */ } finally { setActionLoading(null) }
  }

  const filtered = toolFilter === "all" ? plans : plans.filter(p => p.tool === toolFilter)

  return (
    <div className="flex flex-col h-full bg-neutral-950 text-white overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between h-9 px-4 border-b border-neutral-800 bg-neutral-900/60 flex-shrink-0">
        <span className="text-xs font-semibold text-white">Plans</span>
        <button
          onClick={() => setEditingPlan(null)}
          className="flex items-center gap-1 text-[10px] text-neutral-400 hover:text-orange-400 border border-neutral-800 hover:border-orange-500/40 px-2 py-1 transition-colors"
        >
          <Plus className="w-3 h-3" />New Plan
        </button>
      </div>

      {/* Tool filter tabs */}
      <div className="flex items-center gap-0 border-b border-neutral-800 bg-neutral-900/40 flex-shrink-0 px-4">
        {TOOL_TABS.map(tab => (
          <button
            key={tab.key}
            onClick={() => setToolFilter(tab.key)}
            className={`px-3 py-2 text-[10px] font-medium transition-colors border-b-2 -mb-px ${
              toolFilter === tab.key
                ? "text-orange-400 border-orange-500"
                : "text-neutral-500 border-transparent hover:text-neutral-300"
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto p-4">
        {!activeProjectId && (
          <p className="text-xs text-neutral-600 text-center py-8">Select a project to view plans.</p>
        )}
        {activeProjectId && loading && (
          <div className="flex items-center justify-center py-12">
            <Loader2 className="w-5 h-5 animate-spin text-orange-500" />
          </div>
        )}
        {activeProjectId && !loading && filtered.length === 0 && (
          <div className="flex flex-col items-center justify-center py-12 text-neutral-600">
            <p className="text-sm mb-2">No plans yet.</p>
            <button
              onClick={() => setEditingPlan(null)}
              className="text-xs text-orange-400 hover:text-orange-300 transition-colors"
            >
              Create your first plan →
            </button>
          </div>
        )}
        {activeProjectId && !loading && filtered.length > 0 && (
          <div className="grid grid-cols-1 gap-2 max-w-3xl">
            {filtered.map(plan => (
              <div key={plan.id} className={actionLoading === plan.id ? "opacity-50 pointer-events-none" : ""}>
                <PlanCard
                  plan={plan}
                  onEdit={() => setEditingPlan(plan)}
                  onDelete={() => handleDelete(plan)}
                  onClone={() => handleClone(plan)}
                />
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Modal */}
      {editingPlan !== undefined && (
        <PlanModal
          plan={editingPlan}
          projectId={activeProjectId}
          onClose={() => setEditingPlan(undefined)}
          onSaved={() => { setEditingPlan(undefined); fetchPlans() }}
        />
      )}
    </div>
  )
}
