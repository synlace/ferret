"use client"

import React, { useState } from "react"
import { Plus, RefreshCw, Terminal, FileCode, FileText, FolderOpen, FolderClosed } from "lucide-react"

const SUBDIR_ICONS: Record<string, React.ReactNode> = {
  scripts: <Terminal className="w-3 h-3 text-brand-400" />,
  tests: <FileCode className="w-3 h-3 text-blue-400" />,
  notes: <FileText className="w-3 h-3 text-green-400" />,
}

export interface WorkspaceFile {
  path: string; subdir: string; name: string; size: number; modified_at: string
}

interface FileTreeProps {
  files: WorkspaceFile[]; selectedPath: string | null
  onSelectFile: (path: string) => void; onRefresh: () => void; onNewFile: () => void
}

export function FileTree({ files, selectedPath, onSelectFile, onRefresh, onNewFile }: FileTreeProps) {
  const [openDirs, setOpenDirs] = useState<Record<string, boolean>>({ scripts: true, tests: true, notes: true })
  const bySubdir: Record<string, WorkspaceFile[]> = {}
  for (const f of files) { if (!bySubdir[f.subdir]) bySubdir[f.subdir] = []; bySubdir[f.subdir].push(f) }

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
        {(["scripts", "tests", "notes"] as const).map(subdir => {
          const dirFiles = bySubdir[subdir] ?? []
          const isOpen = openDirs[subdir] ?? true
          return (
            <div key={subdir}>
              <button onClick={() => setOpenDirs(prev => ({ ...prev, [subdir]: !prev[subdir] }))}
                className="w-full flex items-center gap-1.5 px-3 py-1 text-left hover:bg-neutral-800/40 transition-colors">
                {isOpen ? <FolderOpen className="w-3 h-3 text-neutral-500" /> : <FolderClosed className="w-3 h-3 text-neutral-500" />}
                {SUBDIR_ICONS[subdir]}
                <span className="text-xs text-neutral-400 font-medium capitalize">{subdir}</span>
                <span className="ml-auto text-[10px] text-neutral-600">{dirFiles.length}</span>
              </button>
              {isOpen && dirFiles.map(f => (
                <button key={f.path} onClick={() => onSelectFile(f.path)}
                  className={`w-full flex items-center gap-1.5 pl-7 pr-3 py-0.5 text-left transition-colors text-xs truncate ${selectedPath === f.path ? "bg-brand-500/20 text-brand-300" : "text-neutral-400 hover:text-white hover:bg-neutral-800/40"}`}
                  title={f.name}>
                  <FileCode className="w-3 h-3 flex-shrink-0 text-neutral-600" />
                  <span className="truncate">{f.name}</span>
                </button>
              ))}
              {isOpen && dirFiles.length === 0 && <div className="pl-7 pr-3 py-0.5 text-[10px] text-neutral-600 italic">empty</div>}
            </div>
          )
        })}
      </div>
    </div>
  )
}
