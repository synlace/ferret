"use client"

import React, { createContext, useContext, useState, useEffect, useCallback } from "react"

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000"

export interface Project {
  default_model: string
  id: string
  name: string
  description: string
  color: string
  emoji: string
  labels: string[]
  is_temp: boolean
  created_at: string
  updated_at: string
}

interface ProjectContextValue {
  projects: Project[]
  activeProjectId: string
  activeProject: Project | null
  setActiveProjectId: (id: string) => Promise<void>
  refreshProjects: () => Promise<void>
  isLoading: boolean
}

const ProjectContext = createContext<ProjectContextValue>({
  projects: [],
  activeProjectId: "temp",
  activeProject: null,
  setActiveProjectId: async () => {},
  refreshProjects: async () => {},
  isLoading: true,
})

export function ProjectProvider({ children }: { children: React.ReactNode }) {
  const [projects, setProjects] = useState<Project[]>([])
  const [activeProjectId, setActiveProjectIdState] = useState<string>("temp")
  const [isLoading, setIsLoading] = useState(true)

  const refreshProjects = useCallback(async () => {
    try {
      const res = await fetch(`${API_BASE}/api/projects`)
      if (res.ok) setProjects(await res.json())
    } catch { /* ignore */ }
  }, [])

  // On mount: load active project from API, fall back to localStorage, then "temp".
  // After loading projects, validate that the active ID still exists — if not (e.g.
  // after a DB reset), fall back to "temp" and clear the stale localStorage entry.
  useEffect(() => {
    const init = async () => {
      let resolvedId = "temp"
      try {
        const res = await fetch(`${API_BASE}/api/settings/active-project`)
        if (res.ok) {
          const data = await res.json()
          resolvedId = data.project_id ?? "temp"
        } else {
          const stored = localStorage.getItem("ferret_active_project_id")
          if (stored) resolvedId = stored
        }
      } catch {
        const stored = localStorage.getItem("ferret_active_project_id")
        if (stored) resolvedId = stored
      }

      // Fetch projects first so we can validate the resolved ID
      let loadedProjects: Project[] = []
      try {
        const res = await fetch(`${API_BASE}/api/projects`)
        if (res.ok) {
          loadedProjects = await res.json()
          setProjects(loadedProjects)
        }
      } catch { /* ignore */ }

      // If the resolved project no longer exists in the DB, reset to temp
      const exists = resolvedId === "temp" || loadedProjects.some(p => p.id === resolvedId)
      if (!exists) {
        resolvedId = "temp"
        localStorage.removeItem("ferret_active_project_id")
      }

      setActiveProjectIdState(resolvedId)
      setIsLoading(false)
    }
    init()
  }, [])

  const setActiveProjectId = useCallback(async (id: string) => {
    setActiveProjectIdState(id)
    localStorage.setItem("ferret_active_project_id", id)
    try {
      await fetch(`${API_BASE}/api/settings/active-project`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ project_id: id }),
      })
    } catch { /* ignore */ }
  }, [])

  const activeProject = projects.find((p: Project) => p.id === activeProjectId) ?? null

  return (
    <ProjectContext.Provider value={{ projects, activeProjectId, activeProject, setActiveProjectId, refreshProjects, isLoading }}>
      {children}
    </ProjectContext.Provider>
  )
}

export function useProject() {
  return useContext(ProjectContext)
}
