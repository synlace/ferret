"use client"

import { apiFetch } from "@/lib/api-fetch"
import React, { useState, useEffect, useRef } from "react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { X, Loader2 } from "lucide-react"

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000"

interface Plan {
  id: string
  name: string
  description: string
  tool: string
  interpreter: string
  max_runtime_seconds: number
  discovers_hosts?: boolean
  discovers_paths?: boolean
  runs_on_hosts?: boolean
  runs_on_paths?: boolean
}

interface Workspace {
  id: string
  name: string
  run_count: number
  hunt_count: number
  file_counts: Record<string, number>
}

interface NewRunModalProps {
  activeProjectId: string
  onClose: () => void
  onCreated: (run: { id: string; workspace_id: string; plan_id: string; target_url: string; status: string }) => void
  /** Pre-fill workspace when opening from a workspace detail view */
  initialWorkspaceId?: string
  /** Pre-fill target URL */
  initialTargetUrl?: string
}

export function NewRunModal({
  activeProjectId,
  onClose,
  onCreated,
  initialWorkspaceId,
  initialTargetUrl = "",
}: NewRunModalProps) {
  const [selectedPlanIds, setSelectedPlanIds] = useState<string[]>([])
  const [runAgainstDiscoveredHosts, setRunAgainstDiscoveredHosts] = useState(false)
  const [runAgainstDiscoveredPaths, setRunAgainstDiscoveredPaths] = useState(false)
  // Plans to run on each discovered host (subset of selectedPlanIds with runs_on_hosts)
  const [hostFollowOnIds, setHostFollowOnIds] = useState<string[]>([])
  // Plans to run on each discovered path (subset of selectedPlanIds with runs_on_paths)
  const [pathFollowOnIds, setPathFollowOnIds] = useState<string[]>([])
  const [targetUrl, setTargetUrl] = useState(initialTargetUrl)
  const [plans, setPlans] = useState<Plan[]>([])
  const [plansLoading, setPlansLoading] = useState(false)
  const [creating, setCreating] = useState(false)
  const [validationError, setValidationError] = useState("")

  // Workspace picker
  const [workspaceMode, setWorkspaceMode] = useState<"new" | "existing">(
    initialWorkspaceId ? "existing" : "new"
  )
  const [workspaceName, setWorkspaceName] = useState("")
  const [workspaceId, setWorkspaceId] = useState(initialWorkspaceId ?? "")
  const [workspaces, setWorkspaces] = useState<Workspace[]>([])
  const [workspacesLoading, setWorkspacesLoading] = useState(false)

  const modalRef = useRef<HTMLDivElement>(null)

  // Fetch script plans only
  useEffect(() => {
    if (!activeProjectId) return
    setPlansLoading(true)
    apiFetch(`${API_BASE}/api/plans?project_id=${activeProjectId}`)
      .then(r => r.ok ? r.json() : [])
      .then((data: Plan[]) => {
        if (!Array.isArray(data)) { setPlans([]); return }
        const scripts = data.filter(p => p.tool === "script")
        // discovers_hosts first, then discovers_paths, then alphabetical
        scripts.sort((a, b) => {
          const aScore = (a.discovers_hosts ? 0 : a.discovers_paths ? 1 : 2)
          const bScore = (b.discovers_hosts ? 0 : b.discovers_paths ? 1 : 2)
          if (aScore !== bScore) return aScore - bScore
          return a.name.localeCompare(b.name)
        })
        setPlans(scripts)
      })
      .catch(() => setPlans([]))
      .finally(() => setPlansLoading(false))
  }, [activeProjectId])

  // Fetch existing workspaces
  useEffect(() => {
    if (!activeProjectId) return
    setWorkspacesLoading(true)
    apiFetch(`${API_BASE}/api/workspaces?project_id=${activeProjectId}`)
      .then(r => r.ok ? r.json() : [])
      .then((data: Workspace[]) => setWorkspaces(Array.isArray(data) ? data : []))
      .catch(() => setWorkspaces([]))
      .finally(() => setWorkspacesLoading(false))
  }, [activeProjectId])

  // Esc key
  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === "Escape") onClose() }
    document.addEventListener("keydown", handler)
    return () => document.removeEventListener("keydown", handler)
  }, [onClose])

  // Outside click
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (modalRef.current && !modalRef.current.contains(e.target as Node)) onClose()
    }
    document.addEventListener("mousedown", handler)
    return () => document.removeEventListener("mousedown", handler)
  }, [onClose])

  // Derived: first selected plan that discovers hosts / paths
  const discoversHostsPlan = plans.find(p => selectedPlanIds.includes(p.id) && p.discovers_hosts) ?? null
  const discoversPathsPlan = plans.find(p => selectedPlanIds.includes(p.id) && p.discovers_paths) ?? null

  // Reset toggles when the relevant discovers plan is deselected
  useEffect(() => { if (!discoversHostsPlan) { setRunAgainstDiscoveredHosts(false); setHostFollowOnIds([]) } }, [discoversHostsPlan])
  useEffect(() => { if (!discoversPathsPlan) { setRunAgainstDiscoveredPaths(false); setPathFollowOnIds([]) } }, [discoversPathsPlan])

  // Plans eligible for host follow-on (runs_on_hosts, excluding the discovers plan itself)
  const hostEligible = plans.filter(p => p.runs_on_hosts && p.id !== discoversHostsPlan?.id)
  // Plans eligible for path follow-on (runs_on_paths, excluding the discovers plan itself)
  const pathEligible = plans.filter(p => p.runs_on_paths && p.id !== discoversPathsPlan?.id)

  const togglePlan = (id: string) => {
    setSelectedPlanIds(prev =>
      prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]
    )
    // Also remove from follow-on lists if deselected
    setHostFollowOnIds(prev => prev.filter(x => x !== id))
    setPathFollowOnIds(prev => prev.filter(x => x !== id))
  }

  const toggleHostFollowOn = (id: string) => {
    setHostFollowOnIds(prev => prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id])
  }

  const togglePathFollowOn = (id: string) => {
    setPathFollowOnIds(prev => prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id])
  }

  const handleCreate = async () => {
    setValidationError("")
    if (selectedPlanIds.length === 0) {
      setValidationError("Select at least one script to run.")
      return
    }
    if (!targetUrl.trim()) {
      setValidationError("Target URL is required.")
      return
    }
    if (workspaceMode === "existing" && !workspaceId) {
      setValidationError("Please select an existing workspace.")
      return
    }
    setCreating(true)

    // Build shared workspace fields
    const workspaceFields: Record<string, unknown> = {}
    if (workspaceMode === "existing" && workspaceId) {
      workspaceFields.workspace_id = workspaceId
    } else {
      workspaceFields.workspace_name = workspaceName.trim() || targetUrl.trim()
    }

    try {
      // Determine if we use the "single primary + follow-on" path or "N independent runs" path.
      // Use single-primary path when either discovered-hosts or discovered-paths toggle is on.
      const useHostDiscovery = runAgainstDiscoveredHosts && discoversHostsPlan !== null
      const usePathDiscovery = runAgainstDiscoveredPaths && discoversPathsPlan !== null

      if (useHostDiscovery || usePathDiscovery) {
        // Determine the primary plan: prefer the discovers_hosts plan, fall back to discovers_paths
        const primaryPlan = discoversHostsPlan ?? discoversPathsPlan!
        const body: Record<string, unknown> = {
          plan_id: primaryPlan.id,
          target_url: targetUrl.trim(),
          ...workspaceFields,
        }
        if (useHostDiscovery && hostFollowOnIds.length > 0) {
          body.follow_on_plan_ids = hostFollowOnIds
        }
        if (usePathDiscovery && pathFollowOnIds.length > 0) {
          body.follow_on_path_plan_ids = pathFollowOnIds
        }
        const res = await apiFetch(`${API_BASE}/api/runs?project_id=${activeProjectId}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        })
        if (res.ok) {
          const run = await res.json()
          onCreated(run)
        } else {
          const d = await res.json().catch(() => ({}))
          setValidationError(d.detail ?? "Failed to create run")
        }
      } else {
        // N independent runs sharing the same workspace
        let sharedWorkspaceId = workspaceMode === "existing" ? workspaceId : ""
        let firstRun: Record<string, unknown> | null = null

        for (const planId of selectedPlanIds) {
          const body: Record<string, unknown> = {
            plan_id: planId,
            target_url: targetUrl.trim(),
          }
          if (sharedWorkspaceId) {
            body.workspace_id = sharedWorkspaceId
          } else {
            body.workspace_name = workspaceName.trim() || targetUrl.trim()
          }

          const res = await apiFetch(`${API_BASE}/api/runs?project_id=${activeProjectId}`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
          })
          if (res.ok) {
            const run = await res.json()
            if (!firstRun) {
              firstRun = run
              sharedWorkspaceId = run.workspace_id
            }
          } else {
            const d = await res.json().catch(() => ({}))
            setValidationError(d.detail ?? `Failed to create run for plan ${planId}`)
            setCreating(false)
            return
          }
        }

        if (firstRun) {
          onCreated(firstRun as { id: string; workspace_id: string; plan_id: string; target_url: string; status: string })
        }
      }
    } catch {
      setValidationError("Network error")
    } finally {
      setCreating(false)
    }
  }

  const totalFiles = (ws: Workspace) =>
    Object.values(ws.file_counts).reduce((a, b) => a + b, 0)

  const scriptCount = selectedPlanIds.length
  const buttonLabel = creating
    ? "Starting…"
    : scriptCount === 0
      ? "Run Scripts"
      : scriptCount === 1
        ? "Run 1 Script"
        : `Run ${scriptCount} Scripts`

  // Checkbox row component for follow-on plan lists
  const FollowOnRow = ({ plan, checked, onToggle }: { plan: Plan; checked: boolean; onToggle: () => void }) => (
    <label className="flex items-start gap-2.5 px-2.5 py-2 cursor-pointer hover:bg-neutral-700/40 select-none">
      <input
        type="checkbox"
        checked={checked}
        onChange={onToggle}
        className="accent-brand-500 w-3 h-3 flex-shrink-0 mt-0.5"
      />
      <div className="min-w-0">
        <div className="text-xs text-neutral-200 font-medium">{plan.name}</div>
        {plan.description && (
          <div className="text-[10px] text-neutral-500 mt-0.5 leading-relaxed line-clamp-2">
            {plan.description}
          </div>
        )}
      </div>
    </label>
  )

  return (
    <div className="fixed inset-0 bg-black/60 flex items-start justify-center z-50 pt-16 pb-8 overflow-y-auto" data-modal>
      <div
        ref={modalRef}
        className="bg-neutral-900 border border-neutral-700 rounded-lg w-[640px] p-5 shadow-2xl"
      >
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-sm font-semibold text-white">New Run</h2>
          <Button variant="ghost" size="icon" className="h-6 w-6 text-neutral-400 hover:text-white" onClick={onClose}>
            <X className="w-3 h-3" />
          </Button>
        </div>

        <div className="space-y-4">
          {/* Target + Workspace in a 2-column row — always at the top */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-xs text-neutral-400 block mb-1.5">Target</label>
              <Input
                value={targetUrl}
                onChange={e => setTargetUrl(e.target.value)}
                onKeyDown={e => { if (e.key === "Enter") handleCreate() }}
                placeholder="*.example.com"
                className="bg-neutral-800 border-neutral-600 text-white text-sm placeholder:text-neutral-600"
              />
            </div>
            <div>
              {/* Label + radio buttons on same row so input aligns with Target field */}
              <div className="flex items-center gap-3 mb-1.5">
                <span className="text-xs text-neutral-400">Workspace</span>
                <label className="flex items-center gap-1 cursor-pointer">
                  <input
                    type="radio"
                    name="runWorkspaceMode"
                    value="new"
                    checked={workspaceMode === "new"}
                    onChange={() => setWorkspaceMode("new")}
                    className="accent-brand-500"
                  />
                  <span className="text-xs text-neutral-300">New</span>
                </label>
                <label className="flex items-center gap-1 cursor-pointer">
                  <input
                    type="radio"
                    name="runWorkspaceMode"
                    value="existing"
                    checked={workspaceMode === "existing"}
                    onChange={() => setWorkspaceMode("existing")}
                    className="accent-brand-500"
                    disabled={workspaces.length === 0}
                  />
                  <span className={`text-xs ${workspaces.length === 0 ? "text-neutral-600" : "text-neutral-300"}`}>
                    Existing {workspaces.length > 0 ? `(${workspaces.length})` : ""}
                  </span>
                </label>
              </div>
              {workspaceMode === "new" ? (
                <Input
                  value={workspaceName}
                  onChange={e => setWorkspaceName(e.target.value)}
                  placeholder="Name (defaults to target)"
                  className="bg-neutral-800 border-neutral-600 text-white text-sm placeholder:text-neutral-600"
                />
              ) : (
                <select
                  value={workspaceId}
                  onChange={e => setWorkspaceId(e.target.value)}
                  disabled={workspacesLoading}
                  className="w-full bg-neutral-800 border border-neutral-600 text-sm text-white px-2 py-1.5 focus:outline-none focus:border-brand-500/60 disabled:opacity-50"
                >
                  <option value="">Select workspace…</option>
                  {workspaces.map(ws => (
                    <option key={ws.id} value={ws.id}>
                      {ws.name} ({totalFiles(ws)} files, {ws.run_count} runs)
                    </option>
                  ))}
                </select>
              )}
            </div>
          </div>

          {/* Script checklist — 2-column grid */}
          <div>
            <label className="text-xs text-neutral-400 block mb-1.5">Scripts</label>
            {plansLoading ? (
              <p className="text-[10px] text-neutral-600">Loading scripts…</p>
            ) : plans.length === 0 ? (
              <p className="text-[10px] text-neutral-600">No script plans available.</p>
            ) : (
              <div className="bg-neutral-800 border border-neutral-600">
                <div className="grid grid-cols-2 divide-x divide-neutral-700/60">
                  {plans.map((p, i) => {
                    const checked = selectedPlanIds.includes(p.id)
                    const topBorder = i >= 2 ? "border-t border-neutral-700/60" : ""
                    return (
                      <label
                        key={p.id}
                        className={`flex items-start gap-2.5 px-2.5 py-2 cursor-pointer hover:bg-neutral-700/40 select-none ${topBorder}`}
                      >
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={() => togglePlan(p.id)}
                          className="accent-brand-500 w-3 h-3 flex-shrink-0 mt-0.5"
                        />
                        <div className="min-w-0">
                          <div className="text-xs text-neutral-200 font-medium flex items-center gap-1.5 flex-wrap">
                            {p.name}
                            {p.discovers_hosts && (
                              <span className="text-[9px] text-brand-400 border border-brand-500/40 px-1 py-px leading-none whitespace-nowrap">
                                discovers hosts
                              </span>
                            )}
                            {p.discovers_paths && (
                              <span className="text-[9px] text-sky-400 border border-sky-500/40 px-1 py-px leading-none whitespace-nowrap">
                                discovers paths
                              </span>
                            )}
                          </div>
                          {p.description && (
                            <div className="text-[10px] text-neutral-500 mt-0.5 leading-relaxed line-clamp-2">
                              {p.description}
                            </div>
                          )}
                        </div>
                      </label>
                    )
                  })}
                </div>
              </div>
            )}
          </div>

          {/* Host discovery follow-on section — only rendered when a discovers_hosts plan is selected */}
          {discoversHostsPlan && (
            <div>
              <label className="flex items-start gap-2.5 cursor-pointer select-none group mb-2">
                <input
                  type="checkbox"
                  checked={runAgainstDiscoveredHosts}
                  onChange={e => setRunAgainstDiscoveredHosts(e.target.checked)}
                  className="accent-brand-500 w-3 h-3 flex-shrink-0 mt-0.5"
                />
                <div className="min-w-0">
                  <div className="text-xs text-neutral-300 font-medium group-hover:text-white transition-colors">
                    Also run scripts against each discovered host
                  </div>
                  <div className="text-[10px] text-neutral-500 mt-0.5">
                    <span className="text-neutral-400">{discoversHostsPlan.name}</span> emits a <code className="text-neutral-400">[FERRET:MANIFEST]</code> line per host.
                  </div>
                </div>
              </label>
              {runAgainstDiscoveredHosts && hostEligible.length > 0 && (
                <div className="ml-5 bg-neutral-800 border border-neutral-700 divide-y divide-neutral-700/60">
                  {hostEligible.map(p => (
                    <FollowOnRow
                      key={p.id}
                      plan={p}
                      checked={hostFollowOnIds.includes(p.id)}
                      onToggle={() => toggleHostFollowOn(p.id)}
                    />
                  ))}
                </div>
              )}
            </div>
          )}

          {/* Path discovery follow-on section — only rendered when a discovers_paths plan is selected */}
          {discoversPathsPlan && (
            <div>
              <label className="flex items-start gap-2.5 cursor-pointer select-none group mb-2">
                <input
                  type="checkbox"
                  checked={runAgainstDiscoveredPaths}
                  onChange={e => setRunAgainstDiscoveredPaths(e.target.checked)}
                  className="accent-brand-500 w-3 h-3 flex-shrink-0 mt-0.5"
                />
                <div className="min-w-0">
                  <div className="text-xs text-neutral-300 font-medium group-hover:text-white transition-colors">
                    Also run scripts against each discovered path
                  </div>
                  <div className="text-[10px] text-neutral-500 mt-0.5">
                    <span className="text-neutral-400">{discoversPathsPlan.name}</span> emits a <code className="text-neutral-400">[FERRET:MANIFEST]</code> line per interesting URL.
                  </div>
                </div>
              </label>
              {runAgainstDiscoveredPaths && pathEligible.length > 0 && (
                <div className="ml-5 bg-neutral-800 border border-neutral-700 divide-y divide-neutral-700/60">
                  {pathEligible.map(p => (
                    <FollowOnRow
                      key={p.id}
                      plan={p}
                      checked={pathFollowOnIds.includes(p.id)}
                      onToggle={() => togglePathFollowOn(p.id)}
                    />
                  ))}
                </div>
              )}
            </div>
          )}

          {/* Validation error */}
          {validationError && (
            <p className="text-xs text-red-400 bg-red-500/10 border border-red-500/30 px-2 py-1.5">
              {validationError}
            </p>
          )}

          <div className="flex gap-2">
            <Button
              onClick={handleCreate}
              disabled={creating || selectedPlanIds.length === 0}
              className="flex-1 bg-brand-500 hover:bg-brand-600 text-neutral-900 text-sm h-9 flex items-center gap-1.5 disabled:opacity-50"
            >
              {creating && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
              {buttonLabel}
            </Button>
            <Button
              variant="outline"
              onClick={onClose}
              className="border-neutral-600 text-neutral-300 text-sm h-9 hover:bg-neutral-800"
            >
              Cancel
            </Button>
          </div>
        </div>
      </div>
    </div>
  )
}
