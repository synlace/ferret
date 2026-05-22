"use client"

import React, { useState } from "react"
import { Plus, RefreshCw, Terminal, FileCode, FileText, FolderOpen, FolderClosed, KeyRound, Code2, BookOpen, Layers, MoveRight } from "lucide-react"

// Ordered display list — workspace first (scratch area), then polished, then reference
const SUBDIRS = ["workspace", "scripts", "tests", "notes", "credentials", "source", "docs"] as const
type Subdir = typeof SUBDIRS[number]

const SUBDIR_META: Record<Subdir, { icon: React.ReactNode; label: string; color: string }> = {
  workspace:   { icon: <Layers   className="w-3 h-3 text-orange-400" />,  label: "Workspace",   color: "text-orange-400" },
  scripts:     { icon: <Terminal className="w-3 h-3 text-brand-400" />,   label: "Scripts",     color: "text-brand-400" },
  tests:       { icon: <FileCode className="w-3 h-3 text-blue-400" />,    label: "Tests",       color: "text-blue-400" },
  notes:       { icon: <FileText className="w-3 h-3 text-green-400" />,   label: "Notes",       color: "text-green-400" },
  credentials: { icon: <KeyRound className="w-3 h-3 text-red-400" />,     label: "Credentials", color: "text-red-400" },
  source:      { icon: <Code2    className="w-3 h-3 text-purple-400" />,  label: "Source",      color: "text-purple-400" },
  docs:        { icon: <BookOpen className="w-3 h-3 text-yellow-400" />,  label: "Docs",        color: "text-yellow-400" },
}

// Subdirs whose files can be promoted (moved) to scripts/ or tests/
const PROMOTABLE_SUBDIRS = new Set<Subdir>(["workspace"])
const PROMOTION_TARGETS: Partial<Record<Subdir, Subdir[]>> = {
  workspace: ["scripts", "tests"],
}

export interface WorkspaceFile {
  path: string; subdir: string; name: string; size: number; modified_at: string
}

interface FileTreeProps {
  files: WorkspaceFile[]
  selectedPath: string | null
  onSelectFile: (path: string) => void
  onRefresh: () => void
  onNewFile: () => void
  onMoveFile?: (srcPath: string, dstSubdir: Subdir) => void
}

export function FileTree({ files, selectedPath, onSelectFile, onRefresh, onNewFile, onMoveFile }: FileTreeProps) {
  const [openDirs, setOpenDirs] = useState<Record<string, boolean>>({
    workspace: true,
    scripts: true,
    tests: true,
    notes: true,
    credentials: false,
    source: false,
    docs: false,
  })
  const [promotingFile, setPromotingFile] = useState<string | null>(null)

  const bySubdir: Record<string, WorkspaceFile[]> = {}
  for (const f of files) { if (!bySubdir[f.subdir]) bySubdir[f.subdir] = []; bySubdir[f.subdir].push(f) }

  const handlePromote = (file: WorkspaceFile, target: Subdir, e: React.MouseEvent) => {
    e.stopPropagation()
    setPromotingFile(null)
    if (onMoveFile) onMoveFile(file.path, target)
  }

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center justify-between px-3 py-2 border-b border-neutral-800 flex-shrink-0">
        <span className="text-[10px] text-neutral-500 uppercase tracking-wider font-medium">Files</span>
        <div className="flex items-center gap-1">
          <button onClick={onNewFile} className="text-neutral-500 hover:text-brand-400 transition-colors" title="New file"><Plus className="w-3 h-3" /></button>
          <button onClick={onRefresh} className="text-neutral-500 hover:text-neutral-300 transition-colors" title="Refresh"><RefreshCw className="w-3 h-3" /></button>
        </div>
      </div>
      <div className="flex-1 overflow-y-auto py-1">
        {SUBDIRS.map(subdir => {
          const meta = SUBDIR_META[subdir]
          const dirFiles = bySubdir[subdir] ?? []
          const isOpen = openDirs[subdir] ?? true
          const canPromote = PROMOTABLE_SUBDIRS.has(subdir)
          const targets = PROMOTION_TARGETS[subdir] ?? []
          return (
            <div key={subdir}>
              <button onClick={() => setOpenDirs(prev => ({ ...prev, [subdir]: !prev[subdir] }))}
                className="w-full flex items-center gap-1.5 px-3 py-1 text-left hover:bg-neutral-800/40 transition-colors">
                {isOpen ? <FolderOpen className="w-3 h-3 text-neutral-500" /> : <FolderClosed className="w-3 h-3 text-neutral-500" />}
                {meta.icon}
                <span className="text-xs text-neutral-400 font-medium">{meta.label}</span>
                <span className="ml-auto text-[10px] text-neutral-600">{dirFiles.length}</span>
              </button>
              {isOpen && dirFiles.map(f => (
                <div key={f.path} className="relative group/file">
                  <button onClick={() => onSelectFile(f.path)}
                    className={`w-full flex items-center gap-1.5 pl-7 pr-3 py-0.5 text-left transition-colors text-xs truncate ${selectedPath === f.path ? "bg-brand-500/20 text-brand-300" : "text-neutral-400 hover:text-white hover:bg-neutral-800/40"}`}
                    title={f.name}>
                    <FileCode className="w-3 h-3 flex-shrink-0 text-neutral-600" />
                    <span className="truncate">{f.name}</span>
                    {canPromote && onMoveFile && (
                      <button
                        onClick={e => { e.stopPropagation(); setPromotingFile(promotingFile === f.path ? null : f.path) }}
                        className="ml-auto opacity-0 group-hover/file:opacity-100 text-neutral-600 hover:text-orange-400 transition-all flex-shrink-0"
                        title="Promote to scripts/ or tests/"
                      >
                        <MoveRight className="w-2.5 h-2.5" />
                      </button>
                    )}
                  </button>
                  {/* Promotion target picker */}
                  {promotingFile === f.path && canPromote && (
                    <div className="absolute right-0 top-full z-10 bg-neutral-800 border border-neutral-700 rounded shadow-lg py-0.5 min-w-[100px]">
                      {targets.map(target => (
                        <button
                          key={target}
                          onClick={e => handlePromote(f, target, e)}
                          className="w-full flex items-center gap-1.5 px-2.5 py-1 text-xs text-neutral-300 hover:bg-neutral-700 hover:text-white transition-colors"
                        >
                          {SUBDIR_META[target].icon}
                          <span>→ {SUBDIR_META[target].label}</span>
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              ))}
              {isOpen && dirFiles.length === 0 && <div className="pl-7 pr-3 py-0.5 text-[10px] text-neutral-600 italic">empty</div>}
            </div>
          )
        })}
      </div>
    </div>
  )
}
