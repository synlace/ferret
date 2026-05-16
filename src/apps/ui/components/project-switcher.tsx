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
      className="w-full flex items-center gap-2 px-3 py-2 hover:bg-neutral-800 transition-colors text-left border-b border-neutral-800 flex-shrink-0 overflow-hidden"
      title={collapsed ? displayName : undefined}
    >
      <span className="text-base leading-none flex-shrink-0">{displayEmoji}</span>
      <span
        className={`flex-1 text-xs text-white font-medium whitespace-nowrap transition-opacity duration-150 ${
          collapsed ? "opacity-0 pointer-events-none delay-0" : "opacity-100 delay-150"
        }`}
      >
        {displayName}
      </span>
      <ChevronDown
        className={`w-3 h-3 text-neutral-400 flex-shrink-0 transition-opacity duration-150 ${
          collapsed ? "opacity-0 pointer-events-none delay-0" : "opacity-100 delay-150"
        }`}
      />
    </button>
  )
}
