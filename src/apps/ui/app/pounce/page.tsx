"use client"

import { Target } from "lucide-react"

export default function PouncePage() {
  return (
    <div className="flex flex-col h-full overflow-hidden relative">
      {/* Page header strip */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-neutral-800 flex-shrink-0 bg-neutral-900">
        <h1 className="text-sm font-bold text-white">Pounce</h1>
        <span className="px-2 py-0.5 border text-xs bg-neutral-800 border-neutral-700 text-neutral-500">
          Coming Soon
        </span>
      </div>

      {/* Empty / placeholder state */}
      <div className="flex-1 min-h-0 overflow-y-auto flex flex-col items-center justify-center py-16 text-neutral-500">
        <Target className="w-10 h-10 mb-4 opacity-30" />
        <p className="text-sm font-medium text-neutral-400">Pounce</p>
        <p className="text-xs text-neutral-600 mt-1 max-w-xs text-center">
          Automated payload fuzzing and attack module. Coming soon.
        </p>
      </div>
    </div>
  )
}
