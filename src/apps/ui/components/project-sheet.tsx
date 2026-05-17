"use client"

import { apiFetch } from "@/lib/api-fetch"

/**
 * ProjectSheet
 *
 * A left-side slide-over sheet for switching the active project.
 * Mirrors the SigintPanel pattern (Sheet + SheetContent side="left").
 *
 * - Filter input to quickly find projects by name.
 * - Lists all projects; clicking one activates it and closes the sheet.
 * - Shows per-project AI spend fetched from /api/projects/{id}/spend.
 * - "Manage Projects" link at the bottom navigates to /projects.
 * - No inline create form — use /projects for project management.
 */

import React, { useState, useEffect, useRef, useCallback } from "react"
import Link from "next/link"
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet"
import { Check, Settings, Search } from "lucide-react"
import { useProject } from "@/app/context/project-context"

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000"

interface ProjectSheetProps {
  open: boolean
  onOpenChange: (open: boolean) => void
}

export default function ProjectSheet({ open, onOpenChange }: ProjectSheetProps) {
  const { projects, activeProjectId, activeProject, setActiveProjectId } = useProject()
  const [query, setQuery] = useState("")
  const [spendMap, setSpendMap] = useState<Map<string, number>>(new Map())
  const [spendLoading, setSpendLoading] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  const displayName  = activeProject?.name ?? "Temporary Workspace"
  const displayEmoji = activeProject?.emoji || "📁"

  // Fetch spend for all non-temp projects in parallel
  const fetchSpend = useCallback(async () => {
    if (projects.length === 0) return
    setSpendLoading(true)
    try {
      const results = await Promise.allSettled(
        projects
          .filter(p => !p.is_temp)
          .map(async p => {
            const res = await apiFetch(`${API_BASE}/api/projects/${p.id}/spend`)
            if (!res.ok) return { id: p.id, total: 0 }
            const data = await res.json()
            return { id: p.id, total: typeof data.total_usd === "number" ? data.total_usd : 0 }
          })
      )
      const next = new Map<string, number>()
      for (const r of results) {
        if (r.status === "fulfilled") {
          next.set(r.value.id, r.value.total)
        }
      }
      setSpendMap(next)
    } catch {
      // non-fatal — spend just won't show
    } finally {
      setSpendLoading(false)
    }
  }, [projects])

  // Clear filter when sheet closes; focus input + fetch spend when it opens
  useEffect(() => {
    if (open) {
      setQuery("")
      setTimeout(() => inputRef.current?.focus(), 80)
      fetchSpend()
    }
  }, [open, fetchSpend])

  const filtered = query.trim()
    ? projects.filter(p => p.name.toLowerCase().includes(query.toLowerCase()))
    : projects

  const switchProject = async (id: string) => {
    await setActiveProjectId(id)
    onOpenChange(false)
  }

  const formatSpend = (usd: number) => {
    if (usd === 0) return "$0.00"
    if (usd < 0.01) return `$${usd.toFixed(4)}`
    return `$${usd.toFixed(2)}`
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="left"
        className="w-[280px] bg-neutral-900 border-r border-neutral-800 text-white p-0 flex flex-col"
      >
        {/* Header — active project */}
        <SheetHeader className="px-4 py-3 border-b border-neutral-800 flex-shrink-0">
          <SheetTitle className="text-orange-500 font-bold text-sm tracking-wider">
            PROJECTS
          </SheetTitle>
          {/* Active project summary */}
          <div className="flex items-center gap-2 mt-1">
            <span className="text-base leading-none">{displayEmoji}</span>
            <span className="text-xs font-semibold text-white truncate flex-1">{displayName}</span>
          </div>
        </SheetHeader>

        {/* Filter input */}
        <div className="px-3 py-2 border-b border-neutral-800 flex-shrink-0">
          <div className="relative">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3 h-3 text-neutral-500 pointer-events-none" />
            <input
              ref={inputRef}
              value={query}
              onChange={e => setQuery(e.target.value)}
              onKeyDown={e => e.key === "Escape" && setQuery("")}
              placeholder="Filter projects..."
              className="w-full bg-neutral-800 border border-neutral-700 text-xs text-white placeholder-neutral-500 pl-7 pr-3 py-1.5 focus:outline-none focus:border-orange-500 transition-colors"
            />
          </div>
        </div>

        {/* Project list */}
        <div className="flex-1 overflow-y-auto">
          {filtered.length === 0 ? (
            <div className="px-4 py-8 text-center text-neutral-600 text-xs">
              {query ? "NO MATCHES" : "NO PROJECTS YET"}
            </div>
          ) : (
            filtered.map((p) => {
              const emoji    = p.emoji || "📁"
              const isActive = p.id === activeProjectId
              const spend    = spendMap.get(p.id)
              return (
                <button
                  key={p.id}
                  onClick={() => switchProject(p.id)}
                  className={`w-full flex items-center gap-3 px-4 py-3 text-sm transition-colors text-left border-b border-neutral-800/60 ${
                    isActive
                      ? "bg-orange-500/10 text-orange-400 border-l-2 border-l-orange-500"
                      : "text-neutral-300 hover:bg-neutral-800 hover:text-white"
                  }`}
                >
                  <span className="text-base leading-none flex-shrink-0">{emoji}</span>
                  <span className="flex-1 truncate font-medium">{p.name}</span>
                  {/* Spend badge — only for non-temp projects */}
                  {!p.is_temp && (
                    <span className={`text-[10px] tabular-nums flex-shrink-0 ${
                      isActive ? "text-orange-400/70" : "text-neutral-500"
                    }`}>
                      {spendLoading && spend === undefined
                        ? "..."
                        : spend !== undefined
                          ? formatSpend(spend)
                          : ""}
                    </span>
                  )}
                  {isActive && (
                    <Check className="w-3.5 h-3.5 text-orange-500 flex-shrink-0" />
                  )}
                </button>
              )
            })
          )}
        </div>

        {/* Footer — manage link */}
        <div className="border-t border-neutral-800 flex-shrink-0">
          <Link
            href="/projects"
            onClick={() => onOpenChange(false)}
            className="flex items-center gap-2 px-4 py-3 text-xs text-neutral-400 hover:text-white hover:bg-neutral-800 transition-colors"
          >
            <Settings className="w-3.5 h-3.5 flex-shrink-0" />
            Manage Projects
          </Link>
        </div>
      </SheetContent>
    </Sheet>
  )
}
