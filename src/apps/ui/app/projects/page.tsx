"use client"

import React, { useState, useRef, useCallback, useEffect } from "react"
import { Plus, Upload, Search, X } from "lucide-react"
import { useProject, Project } from "../context/project-context"
import { ProjectRow } from "./ProjectRow"
import { ActiveProjectCard } from "./ActiveProjectCard"
import { NewProjectModal } from "./NewProjectModal"
import { PromoteModal } from "./PromoteModal"
import { EditProjectModal } from "./EditProjectModal"
import { KeysSheet } from "./KeysSheet"
import { SortKey, SortDir, API_BASE, ApiKey, SpendData, fetchKeys, fetchSpend } from "./types"

// ---------------------------------------------------------------------------
// Column header (sortable, no resize)
// ---------------------------------------------------------------------------

function ColHeader({
  label,
  sortKey,
  currentSort,
  sortDir,
  onSort,
  align = "left",
}: {
  label: string
  sortKey: SortKey | null
  currentSort: SortKey
  sortDir: SortDir
  onSort: (k: SortKey) => void
  align?: "left" | "right"
}) {
  const isActive = sortKey !== null && currentSort === sortKey
  return (
    <th className={`px-3 py-2 text-${align} text-[10px] font-semibold text-neutral-600 uppercase tracking-wider select-none`}>
      {sortKey ? (
        <button
          onClick={() => onSort(sortKey)}
          className={`flex items-center gap-1 hover:text-neutral-400 transition-colors ${align === "right" ? "ml-auto" : ""} ${isActive ? "text-orange-400" : ""}`}
        >
          {label}
          <span className="text-[9px] opacity-60">{isActive ? (sortDir === "asc" ? "↑" : "↓") : "↕"}</span>
        </button>
      ) : (
        <span className={align === "right" ? "block text-right" : ""}>{label}</span>
      )}
    </th>
  )
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function ProjectsPage() {
  const { projects, activeProjectId, setActiveProjectId, refreshProjects } = useProject()

  const [showNewModal, setShowNewModal] = useState(false)
  const [promoteTarget, setPromoteTarget] = useState<Project | null>(null)
  const [editTarget, setEditTarget] = useState<Project | null>(null)
  // keysTarget: which project's sheet is open (null = sheet closed)
  const [keysTarget, setKeysTarget] = useState<Project | null>(null)
  const [searchQuery, setSearchQuery] = useState("")
  const [sortKey, setSortKey] = useState<SortKey>("created_at")
  const [sortDir, setSortDir] = useState<SortDir>("desc")
  const fileInputRef = useRef<HTMLInputElement>(null)

  // Pre-fetched keys/spend keyed by project id
  const [projectKeys, setProjectKeys] = useState<Record<string, ApiKey[]>>({})
  const [projectSpend, setProjectSpend] = useState<Record<string, SpendData | null>>({})

  const activeProject = projects.find((p) => p.id === activeProjectId) ?? null

  // -------------------------------------------------------------------------
  // Pre-fetch keys + spend for all projects on mount / when project list changes
  // -------------------------------------------------------------------------

  useEffect(() => {
    if (projects.length === 0) return
    projects.forEach((p) => {
      Promise.all([fetchKeys(p.id), fetchSpend(p.id)]).then(([k, s]) => {
        setProjectKeys((prev) => ({ ...prev, [p.id]: k }))
        setProjectSpend((prev) => ({ ...prev, [p.id]: s }))
      })
    })
  }, [projects])

  // -------------------------------------------------------------------------
  // Filter + sort
  // -------------------------------------------------------------------------

  const filteredProjects = searchQuery.trim()
    ? projects.filter((p: Project) => {
        const q = searchQuery.toLowerCase()
        return (
          p.name.toLowerCase().includes(q) ||
          (p.description ?? "").toLowerCase().includes(q) ||
          (p.labels ?? []).some((l: string) => l.toLowerCase().includes(q))
        )
      })
    : projects

  const sortedProjects = [...filteredProjects].sort((a: Project, b: Project) => {
    let cmp = 0
    if (sortKey === "name") cmp = a.name.localeCompare(b.name)
    else if (sortKey === "created_at") cmp = a.created_at.localeCompare(b.created_at)
    return sortDir === "asc" ? cmp : -cmp
  })

  const handleSort = (k: SortKey) => {
    if (sortKey === k) setSortDir((d) => (d === "asc" ? "desc" : "asc"))
    else { setSortKey(k); setSortDir("asc") }
  }

  // -------------------------------------------------------------------------
  // Actions
  // -------------------------------------------------------------------------

  const handleCreate = useCallback(async (
    name: string, description: string, _color: string, emoji: string,
    labels: string[], defaultModel: string, provisionKey: boolean,
  ) => {
    try {
      const res = await fetch(`${API_BASE}/api/projects`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, description, color: "#f97316", emoji, labels, default_model: defaultModel, provision_key: provisionKey }),
      })
      if (res.ok) {
        const project: Project = await res.json()
        await refreshProjects()
        await setActiveProjectId(project.id)
      }
    } catch { /* ignore */ }
    setShowNewModal(false)
  }, [refreshProjects, setActiveProjectId])

  const handleEdit = useCallback(async (
    id: string,
    updates: { name: string; description: string; emoji: string; labels: string[]; defaultModel: string },
  ) => {
    try {
      await fetch(`${API_BASE}/api/projects/${id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: updates.name,
          description: updates.description,
          emoji: updates.emoji,
          labels: updates.labels,
          default_model: updates.defaultModel,
        }),
      })
      await refreshProjects()
    } catch { /* ignore */ }
  }, [refreshProjects])

  const handleExport = useCallback(async (project: Project) => {
    try {
      const res = await fetch(`${API_BASE}/api/projects/${project.id}/export`)
      if (!res.ok) return
      const blob = await res.blob()
      const url = URL.createObjectURL(blob)
      const a = document.createElement("a")
      a.href = url
      a.download = `project-${project.name.replace(/\s+/g, "-").toLowerCase()}.json`
      a.click()
      URL.revokeObjectURL(url)
    } catch { /* ignore */ }
  }, [])

  const handleDelete = useCallback(async (id: string) => {
    if (!window.confirm("Delete this project? This action cannot be undone.")) return
    try {
      const res = await fetch(`${API_BASE}/api/projects/${id}`, { method: "DELETE" })
      if (res.ok) {
        if (activeProjectId === id) await setActiveProjectId("temp")
        await refreshProjects()
      } else {
        const body = await res.json().catch(() => ({}))
        window.alert(`Delete failed: ${body?.detail ?? res.status}`)
      }
    } catch { /* ignore */ }
  }, [activeProjectId, setActiveProjectId, refreshProjects])

  const handlePromote = useCallback(async (name: string) => {
    if (!promoteTarget) return
    try {
      const res = await fetch(`${API_BASE}/api/projects/temp/promote`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, provision_key: false }),
      })
      if (res.ok) {
        const project: Project = await res.json()
        await refreshProjects()
        await setActiveProjectId(project.id)
      }
    } catch { /* ignore */ }
    setPromoteTarget(null)
  }, [promoteTarget, refreshProjects, setActiveProjectId])

  const handleImport = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    try {
      const text = await file.text()
      const json = JSON.parse(text)
      const res = await fetch(`${API_BASE}/api/projects/import`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(json),
      })
      if (res.ok) {
        const project: Project = await res.json()
        await refreshProjects()
        await setActiveProjectId(project.id)
      }
    } catch { /* ignore */ }
    if (fileInputRef.current) fileInputRef.current.value = ""
  }, [refreshProjects, setActiveProjectId])

  // -------------------------------------------------------------------------
  // Column definitions
  // -------------------------------------------------------------------------

  const colDefs: Array<{ label: string; sortKey: SortKey | null; align?: "left" | "right" }> = [
    { label: "",            sortKey: null },
    { label: "Name",        sortKey: "name" },
    { label: "Description", sortKey: null },
    { label: "Created",     sortKey: "created_at" },
    { label: "Requests",    sortKey: "requests",   align: "right" },
    { label: "Findings",    sortKey: "findings",   align: "right" },
    { label: "Spend",       sortKey: "spend",      align: "right" },
    { label: "Actions",     sortKey: null,         align: "right" },
  ]

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------

  return (
    <div className="flex flex-col h-full overflow-hidden bg-neutral-950 text-white">

      {/* ── Page header ─────────────────────────────────────────── */}
      <div className="flex items-center justify-between px-3 h-10 border-b border-neutral-800 flex-shrink-0 bg-neutral-900">
        <h1 className="text-sm font-semibold text-white">Projects</h1>
        <div className="flex items-center gap-1.5">
          {/* Search */}
          <div className="relative">
            <Search className="absolute left-2 top-1/2 -translate-y-1/2 w-3 h-3 text-neutral-600 pointer-events-none" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Filter..."
              className="pl-6 pr-6 h-7 text-xs bg-neutral-800 border border-neutral-700 rounded text-white placeholder-neutral-600 focus:outline-none focus:border-orange-500 w-40"
            />
            {searchQuery && (
              <button
                onClick={() => setSearchQuery("")}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-neutral-600 hover:text-white transition-colors"
              >
                <X className="w-3 h-3" />
              </button>
            )}
          </div>

          {/* Import */}
          <input ref={fileInputRef} type="file" accept=".json" className="hidden" onChange={handleImport} />
          <button
            onClick={() => fileInputRef.current?.click()}
            className="flex items-center gap-1 h-7 px-2.5 text-xs text-neutral-500 border border-neutral-700 rounded hover:text-neutral-300 hover:bg-neutral-800 transition-colors"
          >
            <Upload className="w-3 h-3" /> Import
          </button>

          {/* New project */}
          <button
            onClick={() => setShowNewModal(true)}
            className="flex items-center gap-1 h-7 px-2.5 text-xs font-semibold bg-orange-500 hover:bg-orange-600 text-white rounded transition-colors"
          >
            <Plus className="w-3 h-3" /> New Project
          </button>
        </div>
      </div>

      {/* ── Active project strip ─────────────────────────────────── */}
      {activeProject && <ActiveProjectCard project={activeProject} />}

      {/* ── Table ───────────────────────────────────────────────── */}
      <div className="flex-1 overflow-auto min-h-0">
        <table className="w-full text-sm">
          <thead className="sticky top-0 z-10 bg-neutral-900 border-b border-neutral-800">
            <tr>
              {colDefs.map((col, i) => (
                <ColHeader
                  key={i}
                  label={col.label}
                  sortKey={col.sortKey}
                  currentSort={sortKey}
                  sortDir={sortDir}
                  onSort={handleSort}
                  align={col.align}
                />
              ))}
            </tr>
          </thead>
          <tbody>
            {projects.length === 0 ? (
              <tr>
                <td colSpan={8} className="px-4 py-16 text-center text-neutral-600 text-sm">
                  No projects yet.{" "}
                  <button onClick={() => setShowNewModal(true)} className="text-orange-400 hover:text-orange-300 transition-colors">
                    Create one to get started.
                  </button>
                </td>
              </tr>
            ) : sortedProjects.length === 0 ? (
              <tr>
                <td colSpan={8} className="px-4 py-16 text-center text-neutral-600 text-sm">
                  No projects match <span className="text-neutral-400">&ldquo;{searchQuery}&rdquo;</span>.
                </td>
              </tr>
            ) : (
              sortedProjects.map((project) => (
                <ProjectRow
                  key={project.id}
                  project={project}
                  isActive={project.id === activeProjectId}
                  onSetActive={setActiveProjectId}
                  onEdit={setEditTarget}
                  onDelete={handleDelete}
                  onKeys={setKeysTarget}
                  onPromote={setPromoteTarget}
                />
              ))
            )}
          </tbody>
        </table>
      </div>

      {/* ── Modals ──────────────────────────────────────────────── */}
      {showNewModal && (
        <NewProjectModal onClose={() => setShowNewModal(false)} onCreate={handleCreate} />
      )}
      {promoteTarget && (
        <PromoteModal onClose={() => setPromoteTarget(null)} onPromote={handlePromote} />
      )}
      {editTarget && (
        <EditProjectModal
          project={editTarget}
          onClose={() => setEditTarget(null)}
          onSave={handleEdit}
          onExport={handleExport}
          onDelete={handleDelete}
        />
      )}

      {/* ── Keys sheet — always mounted, slides up/down ──────────── */}
      <KeysSheet
        open={keysTarget !== null}
        projectId={keysTarget?.id ?? ""}
        projectName={keysTarget?.name ?? ""}
        initialKeys={keysTarget ? (projectKeys[keysTarget.id] ?? undefined) : undefined}
        initialSpend={keysTarget ? (projectSpend[keysTarget.id] ?? null) : null}
        onClose={() => setKeysTarget(null)}
      />
    </div>
  )
}
