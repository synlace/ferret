"use client"

/**
 * ProjectSwitcher
 *
 * Renders at the top of the sidebar — a compact trigger button only.
 * Opening/closing the project sheet is controlled by the parent (app-shell).
 *
 * Collapsed sidebar: shows only the emoji.
 * Expanded sidebar: shows emoji + project name + chevron.
 */

import React from "react"
import { ChevronDown } from "lucide-react"
import { useProject } from "@/app/context/project-context"

interface ProjectSwitcherProps {
  collapsed: boolean
  onOpen: () => void
}

export default function ProjectSwitcher({ collapsed, onOpen }: ProjectSwitcherProps) {
  const { activeProject } = useProject()

  const displayName  = activeProject?.name  ?? "Temporary Workspace"
  const displayEmoji = activeProject?.emoji || "📁"

  return (
    <button
      onClick={onOpen}
      className="w-full flex items-center gap-2 px-3 py-2 hover:bg-neutral-800 transition-colors text-left border-b border-neutral-800 flex-shrink-0"
      title={collapsed ? displayName : undefined}
    >
      <span className="text-base leading-none flex-shrink-0">{displayEmoji}</span>
      {!collapsed && (
        <>
          <span className="flex-1 text-xs text-white truncate font-medium">{displayName}</span>
          <ChevronDown className="w-3 h-3 text-neutral-400 flex-shrink-0" />
        </>
      )}
    </button>
  )
}
