"use client"

import React, { useState } from "react"
import { Plus, Trash2, Terminal, FileCode, FileText, KeyRound, Code2, BookOpen, Layers, ChevronRight, ChevronDown } from "lucide-react"
import type { WorkspaceSession } from "./types"
import type { WorkspaceFile } from "./FileTree"

export interface SessionFileCounts {
  workspace: number
  scripts: number
  tests: number
  notes: number
  credentials: number
  source: number
  docs: number
}

interface HuntsListProps {
  sessions: WorkspaceSession[]
  activeSessionId: string | null
  selectedFilePath: string | null
  workspaceFiles: WorkspaceFile[]
  sessionFileCounts: Record<string, SessionFileCounts>
  wsFilter: string
  wsSort: "newest" | "oldest" | "az" | "za"
  leftWidth: number
  onFilterChange: (v: string) => void
  onSortChange: (v: "newest" | "oldest" | "az" | "za") => void
  onSelectSession: (id: string) => void
  onDeleteSession: (id: string, e: React.MouseEvent) => void
  onSelectFile: (path: string) => void
  onNewHunt: () => void
}

// Ordered display list — workspace first (scratch), then polished, then reference
const SUBDIR_ORDER: (keyof SessionFileCounts)[] = [
  "workspace", "scripts", "tests", "notes", "credentials", "source", "docs",
]

const SUBDIR_META: Record<keyof SessionFileCounts, {
  icon: (active: boolean) => React.ReactNode
  chipIcon: React.ReactNode
  label: string
  activeChip: string
  inactiveChip: string
}> = {
  workspace:   {
    icon: (a) => <Layers   className={`w-2 h-2 flex-shrink-0 ${a ? "text-orange-400" : "text-orange-700"}`} />,
    chipIcon: <Layers   className="w-2.5 h-2.5 flex-shrink-0" />,
    label: "Workspace",
    activeChip: "text-orange-500", inactiveChip: "text-orange-700",
  },
  scripts:     {
    icon: (a) => <Terminal className={`w-2 h-2 flex-shrink-0 ${a ? "text-brand-400" : "text-brand-700"}`} />,
    chipIcon: <Terminal className="w-2.5 h-2.5 flex-shrink-0" />,
    label: "Scripts",
    activeChip: "text-neutral-500", inactiveChip: "text-neutral-600",
  },
  tests:       {
    icon: (a) => <FileCode className={`w-2 h-2 flex-shrink-0 ${a ? "text-blue-400" : "text-blue-700"}`} />,
    chipIcon: <FileCode className="w-2.5 h-2.5 flex-shrink-0" />,
    label: "Tests",
    activeChip: "text-neutral-500", inactiveChip: "text-neutral-600",
  },
  notes:       {
    icon: (a) => <FileText className={`w-2 h-2 flex-shrink-0 ${a ? "text-green-400" : "text-green-700"}`} />,
    chipIcon: <FileText className="w-2.5 h-2.5 flex-shrink-0" />,
    label: "Notes",
    activeChip: "text-neutral-500", inactiveChip: "text-neutral-600",
  },
  credentials: {
    icon: (a) => <KeyRound className={`w-2 h-2 flex-shrink-0 ${a ? "text-red-400" : "text-red-700"}`} />,
    chipIcon: <KeyRound className="w-2.5 h-2.5 flex-shrink-0" />,
    label: "Credentials",
    activeChip: "text-red-500", inactiveChip: "text-red-700",
  },
  source:      {
    icon: (a) => <Code2    className={`w-2 h-2 flex-shrink-0 ${a ? "text-purple-400" : "text-purple-700"}`} />,
    chipIcon: <Code2    className="w-2.5 h-2.5 flex-shrink-0" />,
    label: "Source",
    activeChip: "text-purple-500", inactiveChip: "text-purple-700",
  },
  docs:        {
    icon: (a) => <BookOpen className={`w-2 h-2 flex-shrink-0 ${a ? "text-yellow-400" : "text-yellow-700"}`} />,
    chipIcon: <BookOpen className="w-2.5 h-2.5 flex-shrink-0" />,
    label: "Docs",
    activeChip: "text-yellow-500", inactiveChip: "text-yellow-700",
  },
}

/** Per-session, per-subdir expand state stored outside the session row so it
 *  survives re-renders when the session list updates. */
const expandedSubdirs: Record<string, Record<string, boolean>> = {}

function getExpanded(sessionId: string, subdir: string): boolean {
  return expandedSubdirs[sessionId]?.[subdir] ?? false
}

function setExpanded(sessionId: string, subdir: string, value: boolean) {
  if (!expandedSubdirs[sessionId]) expandedSubdirs[sessionId] = {}
  expandedSubdirs[sessionId][subdir] = value
}

export function HuntsList({
  sessions,
  activeSessionId,
  selectedFilePath,
  workspaceFiles,
  sessionFileCounts,
  wsFilter,
  wsSort,
  leftWidth,
  onFilterChange,
  onSortChange,
  onSelectSession,
  onDeleteSession,
  onSelectFile,
  onNewHunt,
}: HuntsListProps) {
  // Force re-render when a subdir is toggled
  const [, forceRender] = useState(0)

  const filtered = sessions.filter(s =>
    s.name.toLowerCase().includes(wsFilter.toLowerCase())
  )

  const sorted = [...filtered].sort((a, b) => {
    if (wsSort === "newest") return new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
    if (wsSort === "oldest") return new Date(a.created_at).getTime() - new Date(b.created_at).getTime()
    if (wsSort === "az") return a.name.localeCompare(b.name)
    return b.name.localeCompare(a.name)
  })

  return (
    <div className="flex flex-col h-full" style={{ width: `${leftWidth}px` }}>
      {/* Header */}
      <div className="flex items-center justify-between h-9 px-3 border-b border-neutral-800 bg-neutral-900/60 flex-shrink-0">
        <span className="text-xs font-semibold text-white">Hunts</span>
        <div className="flex items-center gap-1">
          <button onClick={onNewHunt} title="New hunt"
            className="text-neutral-500 hover:text-brand-400 transition-colors">
            <Plus className="w-3 h-3" />
          </button>
        </div>
      </div>

      {/* Search / filter bar */}
      <div className="flex items-center gap-1.5 px-2.5 py-1.5 border-b border-neutral-800/60 bg-neutral-950 flex-shrink-0">
        <svg className="w-2.5 h-2.5 text-neutral-700 flex-shrink-0" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2">
          <circle cx="6.5" cy="6.5" r="4"/>
          <line x1="10" y1="10" x2="14" y2="14"/>
        </svg>
        <input
          type="text"
          value={wsFilter}
          onChange={e => onFilterChange(e.target.value)}
          placeholder="filter hunts..."
          tabIndex={2}
          className="bg-transparent text-xs text-neutral-500 placeholder:text-neutral-700 outline-none flex-1 min-w-0"
        />
        <select
          value={wsSort}
          onChange={e => onSortChange(e.target.value as "newest" | "oldest" | "az" | "za")}
          className="bg-neutral-900 border border-neutral-800 text-[10px] text-neutral-500 font-sans outline-none cursor-pointer px-1 py-0.5 rounded-sm hover:border-neutral-700 transition-colors flex-shrink-0"
        >
          <option value="newest">newest</option>
          <option value="oldest">oldest</option>
          <option value="az">a-z</option>
          <option value="za">z-a</option>
        </select>
      </div>

      {/* Session list */}
      <div className="flex-1 overflow-y-auto">
        {filtered.length === 0 ? (
          <p className="text-xs text-neutral-700 px-3 py-4 text-center leading-relaxed">
            {sessions.length === 0 ? <>No hunts yet.<br />Click + to start one.</> : "No matches."}
          </p>
        ) : (
          sorted.map(session => {
            const isActive = session.id === activeSessionId
            const counts = sessionFileCounts[session.id]
            const totalFiles = counts
              ? SUBDIR_ORDER.reduce((sum, k) => sum + counts[k], 0)
              : 0

            const createdMs = new Date(session.created_at).getTime()
            const diffMin = Math.floor((Date.now() - createdMs) / 60000)
            const relTime = diffMin < 1 ? "just now"
              : diffMin < 60 ? `${diffMin}m ago`
              : diffMin < 1440 ? `${Math.floor(diffMin / 60)}h ago`
              : diffMin < 2880 ? "yesterday"
              : new Date(session.created_at).toLocaleDateString()

            // Group workspaceFiles by subdir for the active session
            const filesBySubdir: Record<string, WorkspaceFile[]> = {}
            if (isActive) {
              for (const f of workspaceFiles) {
                if (!filesBySubdir[f.subdir]) filesBySubdir[f.subdir] = []
                filesBySubdir[f.subdir].push(f)
              }
            }

            return (
              <div
                key={session.id}
                onClick={() => {
                  if (session.id === activeSessionId && selectedFilePath) {
                    onSelectFile("")
                    return
                  }
                  onSelectSession(session.id)
                }}
                className={`group flex flex-col px-2.5 py-1.5 cursor-pointer border-b border-neutral-800/40 gap-0.5 transition-colors ${
                  isActive
                    ? "bg-neutral-900 border-l-2 border-l-neutral-600 pl-[8px]"
                    : "hover:bg-neutral-900/50"
                }`}
              >
                {/* Row 1: hunt_status dot + name + delete */}
                <div className="flex items-center gap-1 min-w-0">
                  {session.hunt_status === "running" && (
                    <span className="w-1.5 h-1.5 rounded-full bg-brand-500 animate-pulse flex-shrink-0" title="Hunt running" />
                  )}
                  <span
                    className={`flex-1 text-xs font-mono truncate min-w-0 ${
                      isActive ? "text-brand-300" : "text-neutral-300"
                    }`}
                    title={session.name}
                  >
                    {session.name}
                  </span>
                  <button
                    onClick={e => onDeleteSession(session.id, e)}
                    className="opacity-0 group-hover:opacity-100 text-neutral-600 hover:text-red-400 transition-all flex-shrink-0"
                    title="Delete hunt"
                  >
                    <Trash2 className="w-2.5 h-2.5" />
                  </button>
                </div>

                {/* Row 2: timestamp + file count chips */}
                <div className="flex items-center gap-1.5">
                  <span className={`text-[10px] font-sans flex-shrink-0 ${isActive ? "text-neutral-600" : "text-neutral-700"}`}>
                    {relTime}
                  </span>
                  {counts && totalFiles > 0 && (
                    <div className="flex items-center gap-1.5 ml-auto flex-wrap justify-end">
                      {SUBDIR_ORDER.map(key => {
                        const meta = SUBDIR_META[key]
                        const count = counts[key]
                        if (!count) return null
                        return (
                          <span
                            key={key}
                            className={`flex items-center gap-0.5 text-[10px] font-sans ${isActive ? meta.activeChip : meta.inactiveChip}`}
                            title={`${count} ${meta.label.toLowerCase()}`}
                          >
                            {meta.chipIcon}{count}
                          </span>
                        )
                      })}
                    </div>
                  )}
                </div>

                {/* Row 3 (active only): grouped, expandable/collapsable file list by subdir */}
                {isActive && workspaceFiles.length > 0 && (
                  <div className="flex flex-col pt-1 mt-0.5 border-t border-neutral-700/40">
                    {SUBDIR_ORDER.map(subdir => {
                      const files = filesBySubdir[subdir]
                      if (!files || files.length === 0) return null
                      const meta = SUBDIR_META[subdir]
                      const isExpanded = getExpanded(session.id, subdir)
                      return (
                        <div key={subdir}>
                          {/* Subdir header — click to expand/collapse */}
                          <button
                            onClick={e => {
                              e.stopPropagation()
                              setExpanded(session.id, subdir, !isExpanded)
                              forceRender(n => n + 1)
                            }}
                            className="w-full flex items-center gap-1 py-0.5 text-xs text-neutral-500 hover:text-neutral-300 transition-colors"
                          >
                            {isExpanded
                              ? <ChevronDown  className="w-3 h-3 flex-shrink-0" />
                              : <ChevronRight className="w-3 h-3 flex-shrink-0" />}
                            {meta.icon(true)}
                            <span className="font-sans font-medium">{meta.label}</span>
                            <span className="ml-auto text-neutral-600 text-[10px]">{files.length}</span>
                          </button>
                          {/* File list — shown when expanded */}
                          {isExpanded && (
                            <div className="flex flex-col gap-px pl-5">
                              {files.map(file => (
                                <div
                                  key={file.path}
                                  onClick={e => { e.stopPropagation(); onSelectFile(file.path) }}
                                  className={`flex items-center gap-1 py-0.5 text-xs cursor-pointer transition-colors font-mono truncate ${
                                    selectedFilePath === file.path
                                      ? "text-brand-300"
                                      : "text-neutral-500 hover:text-neutral-300"
                                  }`}
                                >
                                  {meta.icon(selectedFilePath === file.path)}
                                  <span className="truncate">{file.name}</span>
                                </div>
                              ))}
                            </div>
                          )}
                        </div>
                      )
                    })}
                  </div>
                )}
              </div>
            )
          })
        )}
      </div>

      {/* Footer CTA */}
      <div className="border-t border-neutral-800/60 px-2.5 py-2 flex-shrink-0">
        <button
          onClick={onNewHunt}
          className="w-full border border-dashed border-neutral-800 hover:border-brand-500/30 text-neutral-600 hover:text-brand-400 text-xs font-sans flex items-center gap-1.5 px-2 py-1.5 transition-colors"
        >
          <Plus className="w-2.5 h-2.5 flex-shrink-0" />
          New hunt
        </button>
      </div>
    </div>
  )
}
