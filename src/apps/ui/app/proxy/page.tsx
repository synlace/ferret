"use client"

import { Activity } from "lucide-react"

export default function ProxyPage() {
  return (
    <div className="flex flex-col h-full overflow-hidden relative">
      {/* Page header strip */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-neutral-800 flex-shrink-0 bg-neutral-900">
        <h1 className="text-sm font-bold text-white">Proxy Settings</h1>
        <div className="flex items-center gap-1">
          <span className="px-2 py-0.5 bg-green-900/40 border border-green-700 text-green-300 text-xs flex items-center gap-1">
            <Activity className="w-3 h-3" />
            Active
          </span>
        </div>
      </div>

      {/* Content area */}
      <div className="flex-1 min-h-0 overflow-y-auto">
        {/* Proxy Configuration section */}
        <div className="border-b border-neutral-800">
          <div className="px-3 py-1.5 bg-neutral-900/50 border-b border-neutral-800">
            <span className="text-[10px] font-semibold text-neutral-500 uppercase tracking-wider">
              Proxy Configuration
            </span>
          </div>

          {/* Config rows */}
          <div className="px-3 py-2 text-xs border-b border-neutral-800 flex items-center gap-4">
            <span className="text-neutral-500 w-32 shrink-0">Listen Address</span>
            <span className="text-white font-mono">127.0.0.1:8080</span>
          </div>
          <div className="px-3 py-2 text-xs flex items-center gap-4">
            <span className="text-neutral-500 w-32 shrink-0">Status</span>
            <span className="text-green-400 font-mono">Running</span>
          </div>
        </div>
      </div>
    </div>
  )
}
