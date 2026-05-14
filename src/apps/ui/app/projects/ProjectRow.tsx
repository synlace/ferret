"use client"

import React, { useState, useEffect } from "react"
import { Star, Settings2, Trash2, Key, Tag } from "lucide-react"
import { Project } from "../context/project-context"
import { ProjectStats, fetchStats, fetchSpend } from "./types"

export interface ProjectRowProps {
  project: Project
  isActive: boolean
  onSetActive: (id: string) => void
  onEdit: (project: Project) => void
  onDelete: (id: string) => void
  onKeys: (project: Project) => void
  onPromote: (project: Project) => void
}

export function ProjectRow({
  project,
  isActive,
  onSetActive,
  onEdit,
  onDelete,
  onKeys,
  onPromote,
}: ProjectRowProps) {
  const [stats, setStats] = useState<ProjectStats>({ requests: 0, findings: 0 })
  const [spend, setSpend] = useState<number | null>(null)

  useEffect(() => {
    fetchStats(project.id).then(setStats)
    fetchSpend(project.id).then((s) => setSpend(s?.total_usd ?? null))
  }, [project.id])

  return (
    <tr
      className={`border-b border-neutral-800/60 hover:bg-neutral-800/30 transition-colors ${
        isActive ? "bg-orange-500/[0.03]" : ""
      }`}
    >
      {/* Emoji */}
      <td className="px-3 py-2.5 w-10">
        <div className="w-7 h-7 rounded flex items-center justify-center text-base bg-neutral-800/60 flex-shrink-0">
          {project.emoji || "📁"}
        </div>
      </td>

      {/* Name + labels */}
      <td className="px-3 py-2.5">
        <div className="flex items-center gap-1.5 mb-0.5">
          <span className="text-sm font-medium text-neutral-100">{project.name}</span>
          {isActive && (
            <span className="text-[10px] bg-orange-500/15 text-orange-400 border border-orange-500/30 rounded px-1.5 py-0.5 leading-none">
              Active
            </span>
          )}
        </div>
        {(project.labels ?? []).length > 0 && (
          <div className="flex items-center gap-1 flex-wrap">
            {(project.labels ?? []).map((l: string) => (
              <span
                key={l}
                className="flex items-center gap-0.5 text-[10px] text-neutral-500 bg-neutral-800/60 border border-neutral-700/50 rounded px-1.5 py-0.5 leading-none"
              >
                <Tag className="w-2 h-2 shrink-0" />
                {l}
              </span>
            ))}
          </div>
        )}
      </td>

      {/* Description */}
      <td className="px-3 py-2.5 max-w-[200px]">
        <span className="text-xs text-neutral-500 truncate block">
          {project.description || <span className="text-neutral-700 italic">—</span>}
        </span>
      </td>

      {/* Created */}
      <td className="px-3 py-2.5 whitespace-nowrap">
        <span className="text-xs text-neutral-600">
          {new Date(project.created_at).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" })}
        </span>
      </td>

      {/* Requests */}
      <td className="px-3 py-2.5 text-right">
        <span className={`text-xs font-mono ${stats.requests > 0 ? "text-neutral-300" : "text-neutral-700"}`}>
          {stats.requests.toLocaleString()}
        </span>
      </td>

      {/* Findings */}
      <td className="px-3 py-2.5 text-right">
        <span className={`text-xs font-mono ${stats.findings > 0 ? "text-orange-400" : "text-neutral-700"}`}>
          {stats.findings.toLocaleString()}
        </span>
      </td>

      {/* Spend */}
      <td className="px-3 py-2.5 text-right">
        {spend != null && spend > 0 ? (
          <span className="text-xs font-mono text-green-400">${spend.toFixed(4)}</span>
        ) : (
          <span className="text-xs text-neutral-700">—</span>
        )}
      </td>

      {/* Actions */}
      <td className="px-3 py-2.5">
        <div className="flex items-center gap-0.5 justify-end">
          {/* Keys */}
          <button
            onClick={() => onKeys(project)}
            title="API Keys"
            className="p-1.5 rounded text-neutral-600 hover:text-orange-400 hover:bg-neutral-800 transition-colors"
          >
            <Key className="w-3.5 h-3.5" />
          </button>

          {/* Edit */}
          <button
            onClick={() => onEdit(project)}
            title="Edit project"
            className="p-1.5 rounded text-neutral-600 hover:text-blue-400 hover:bg-neutral-800 transition-colors"
          >
            <Settings2 className="w-3.5 h-3.5" />
          </button>

          {/* Set active / active indicator */}
          <button
            onClick={() => onSetActive(project.id)}
            title={isActive ? "Active project" : "Set as active"}
            className={`p-1.5 rounded transition-colors ${
              isActive
                ? "text-orange-500 bg-orange-500/10"
                : "text-neutral-600 hover:text-orange-400 hover:bg-neutral-800"
            }`}
          >
            <Star className="w-3.5 h-3.5" fill={isActive ? "currentColor" : "none"} />
          </button>

          {/* Promote (temp only) */}
          {project.is_temp && (
            <button
              onClick={() => onPromote(project)}
              title="Promote to permanent project"
              className="px-2 py-1 text-[10px] bg-amber-500/15 text-amber-400 border border-amber-500/30 rounded hover:bg-amber-500/25 transition-colors"
            >
              Promote
            </button>
          )}

          {/* Delete */}
          <button
            onClick={() => onDelete(project.id)}
            disabled={project.is_temp}
            title={project.is_temp ? "Cannot delete temporary workspace" : "Delete project"}
            className="p-1.5 rounded text-neutral-600 hover:text-red-400 hover:bg-neutral-800 transition-colors disabled:opacity-25 disabled:cursor-not-allowed"
          >
            <Trash2 className="w-3.5 h-3.5" />
          </button>
        </div>
      </td>
    </tr>
  )
}
