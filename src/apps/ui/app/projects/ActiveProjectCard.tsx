"use client"

import React, { useState, useEffect } from "react"
import { Cpu, Zap, AlertTriangle, DollarSign } from "lucide-react"
import { Project } from "../context/project-context"
import { DEFAULT_MODEL, fetchStats, fetchSpend } from "./types"

export function ActiveProjectCard({ project }: { project: Project }) {
  const [stats, setStats] = useState({ requests: 0, findings: 0 })
  const [spend, setSpend] = useState<number | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    setLoading(true)
    Promise.all([fetchStats(project.id), fetchSpend(project.id)]).then(([s, sp]) => {
      setStats(s)
      setSpend(sp?.total_usd ?? null)
      setLoading(false)
    })
  }, [project.id])

  return (
    <div className="flex items-center h-8 border-b border-neutral-800 bg-neutral-900 flex-shrink-0 overflow-x-auto scrollbar-none text-xs">
      {/* Identity */}
      <div className="flex items-center gap-1.5 px-3 h-full border-r border-neutral-800 flex-shrink-0">
        <span className="w-1.5 h-1.5 rounded-full bg-orange-500 flex-shrink-0" />
        <span className="text-base leading-none flex-shrink-0">{project.emoji || "📁"}</span>
        <span className="font-semibold text-white truncate max-w-36">{project.name}</span>
      </div>

      {/* Model */}
      <div className="flex items-center gap-1.5 px-3 h-full border-r border-neutral-800 flex-shrink-0">
        <Cpu className="w-3 h-3 text-neutral-600 flex-shrink-0" />
        <span className="text-neutral-400 font-mono truncate max-w-40">
          {(project.default_model || DEFAULT_MODEL).split("/").slice(-1)[0]}
        </span>
      </div>

      {loading ? (
        <div className="px-3 h-full flex items-center text-neutral-700">—</div>
      ) : (
        <>
          <div className="flex items-center gap-1.5 px-3 h-full border-r border-neutral-800 flex-shrink-0">
            <Zap className="w-3 h-3 text-neutral-600 flex-shrink-0" />
            <span className="text-neutral-500">Req</span>
            <span className="font-mono text-white">{stats.requests.toLocaleString()}</span>
          </div>
          <div className="flex items-center gap-1.5 px-3 h-full border-r border-neutral-800 flex-shrink-0">
            <AlertTriangle className="w-3 h-3 text-neutral-600 flex-shrink-0" />
            <span className="text-neutral-500">Findings</span>
            <span className={`font-mono ${stats.findings > 0 ? "text-orange-400" : "text-white"}`}>
              {stats.findings.toLocaleString()}
            </span>
          </div>
          <div className="flex items-center gap-1.5 px-3 h-full flex-shrink-0">
            <DollarSign className="w-3 h-3 text-neutral-600 flex-shrink-0" />
            <span className="text-neutral-500">Spend</span>
            <span className={`font-mono ${spend != null ? "text-green-400" : "text-neutral-600"}`}>
              {spend != null ? `$${spend.toFixed(4)}` : "—"}
            </span>
          </div>
        </>
      )}
    </div>
  )
}
