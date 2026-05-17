"use client"

import React from "react"
import { Plus, Trash2, Terminal, FileCode, FileText } from "lucide-react"
import type { WorkspaceSession } from "./types"
import type { WorkspaceFile } from "./FileTree"

interface HuntsListProps {
  sessions: WorkspaceSession[]
  activeSessionId: string | null
  selectedFilePath: string | null
  workspaceFiles: WorkspaceFile[]
  sessionFileCounts: Record<string, { scripts: number; tests: number; notes: number }>
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
            className="text-neutral-500 hover:text-orange-400 transition-colors">
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
          className="bg-transparent text-[10px] text-neutral-500 placeholder:text-neutral-700 outline-none flex-1 min-w-0"
        />
        <select
          value={wsSort}
          onChange={e => onSortChange(e.target.value as "newest" | "oldest" | "az" | "za")}
          className="bg-neutral-900 border border-neutral-800 text-[9px] text-neutral-500 font-sans outline-none cursor-pointer px-1 py-0.5 rounded-sm hover:border-neutral-700 transition-colors flex-shrink-0"
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
          <p className="text-[10px] text-neutral-700 px-3 py-4 text-center leading-relaxed">
            {sessions.length === 0 ? <>No hunts yet.<br />Click + to start one.</> : "No matches."}
          </p>
        ) : (
          sorted.map(session => {
            const isActive = session.id === activeSessionId
            const counts = sessionFileCounts[session.id]

            const createdMs = new Date(session.created_at).getTime()
            const diffMin = Math.floor((Date.now() - createdMs) / 60000)
            const relTime = diffMin < 1 ? "just now"
              : diffMin < 60 ? `${diffMin}m ago`
              : diffMin < 1440 ? `${Math.floor(diffMin / 60)}h ago`
              : diffMin < 2880 ? "yesterday"
              : new Date(session.created_at).toLocaleDateString()

            const activeFiles = isActive ? workspaceFiles.slice(0, 4) : []
            const extraFileCount = isActive ? Math.max(0, workspaceFiles.length - 4) : 0

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
                    <span className="w-1.5 h-1.5 rounded-full bg-orange-500 animate-pulse flex-shrink-0" title="Hunt running" />
                  )}
                  <span
                    className={`flex-1 text-[10px] font-mono truncate min-w-0 ${
                      isActive ? "text-orange-300" : "text-neutral-300"
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
                  <span className={`text-[9px] font-sans flex-shrink-0 ${isActive ? "text-neutral-600" : "text-neutral-700"}`}>
                    {relTime}
                  </span>
                  {counts && (counts.scripts + counts.tests + counts.notes) > 0 && (
                    <div className="flex items-center gap-1.5 ml-auto">
                      {counts.scripts > 0 && (
                        <span className={`flex items-center gap-0.5 text-[9px] font-sans ${isActive ? "text-neutral-500" : "text-neutral-600"}`}>
                          <Terminal className="w-2 h-2 flex-shrink-0" />{counts.scripts}
                        </span>
                      )}
                      {counts.tests > 0 && (
                        <span className={`flex items-center gap-0.5 text-[9px] font-sans ${isActive ? "text-neutral-500" : "text-neutral-600"}`}>
                          <FileCode className="w-2 h-2 flex-shrink-0" />{counts.tests}
                        </span>
                      )}
                      {counts.notes > 0 && (
                        <span className={`flex items-center gap-0.5 text-[9px] font-sans ${isActive ? "text-neutral-500" : "text-neutral-600"}`}>
                          <FileText className="w-2 h-2 flex-shrink-0" />{counts.notes}
                        </span>
                      )}
                    </div>
                  )}
                </div>

                {/* Row 3 (active only): inline flat file list */}
                {isActive && workspaceFiles.length > 0 && (
                  <div className="flex flex-col gap-px pt-1 mt-0.5 border-t border-neutral-700/40">
                    {activeFiles.map(file => {
                      const isScript = file.subdir === "scripts"
                      const isTest = file.subdir === "tests"
                      const Icon = isScript ? Terminal : isTest ? FileCode : FileText
                      const iconClass = isScript
                        ? "text-blue-400/40 group-hover:text-blue-400"
                        : isTest
                        ? "text-green-400/40 group-hover:text-green-400"
                        : "text-yellow-400/40 group-hover:text-yellow-400"
                      return (
                        <div
                          key={file.path}
                          onClick={e => { e.stopPropagation(); onSelectFile(file.path) }}
                          className="group flex items-center gap-1 py-0.5 text-[9px] text-neutral-600 hover:text-neutral-400 cursor-pointer transition-colors"
                        >
                          <Icon className={`w-2 h-2 flex-shrink-0 transition-colors ${iconClass}`} />
                          <span className="truncate font-mono">{file.path}</span>
                        </div>
                      )
                    })}
                    {extraFileCount > 0 && (
                      <span className="text-[9px] text-neutral-700 font-sans py-0.5">+{extraFileCount} more</span>
                    )}
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
          className="w-full border border-dashed border-neutral-800 hover:border-orange-500/30 text-neutral-600 hover:text-orange-400 text-[10px] font-sans flex items-center gap-1.5 px-2 py-1.5 transition-colors"
        >
          <Plus className="w-2.5 h-2.5 flex-shrink-0" />
          New hunt
        </button>
      </div>
    </div>
  )
}
