import { useState } from "react"
import { X, Check, Copy } from "lucide-react"

interface LogsModalProps {
  isOpen: boolean
  onClose: () => void
  verifying: boolean
  verifyLogs: string[]
}

export default function LogsModal({
  isOpen,
  onClose,
  verifying,
  verifyLogs
}: LogsModalProps) {
  const [copiedLogs, setCopiedLogs] = useState(false)

  if (!isOpen) return null

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      {/* Backdrop */}
      <div 
        className="fixed inset-0 bg-black/70 backdrop-blur-sm cursor-pointer" 
        onClick={onClose}
      />
      
      {/* Modal Content */}
      <div className="relative bg-neutral-900 border border-neutral-800 rounded-xl max-w-2xl w-full flex flex-col max-h-[75vh] overflow-hidden shadow-2xl animate-fade-in z-10">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-3.5 border-b border-neutral-800 bg-neutral-900/50">
          <div className="flex items-center gap-2">
            <span className="text-xs font-semibold uppercase tracking-widest text-neutral-400">AWS Den Deployment Logs</span>
            {verifying && (
              <span className="inline-flex h-2 w-2 rounded-full bg-brand-500 animate-ping" />
            )}
          </div>
          <button
            type="button"
            onClick={onClose}
            className="text-neutral-400 hover:text-white rounded-md p-1 hover:bg-neutral-800 transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
        
        {/* Log Stream Area */}
        <div className="flex-1 overflow-y-auto p-4 bg-neutral-950 font-mono text-[11px] text-neutral-300 space-y-1 select-text scrollbar-thin">
          {verifyLogs.length === 0 ? (
            <p className="text-neutral-600 italic">No logs available yet. Click &ldquo;Verify AWS Den&rdquo; to start.</p>
          ) : (
            verifyLogs.map((l, i) => (
              <p key={i} className="whitespace-pre-wrap leading-relaxed border-l-2 border-transparent hover:border-brand-500 pl-2 transition-colors">{l}</p>
            ))
          )}
        </div>

        {/* Footer */}
        <div className="flex justify-between items-center px-5 py-3 border-t border-neutral-800 bg-neutral-900/50">
          <span className="text-[10px] text-neutral-500">{verifyLogs.length} lines logged</span>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => {
                navigator.clipboard.writeText(verifyLogs.join("\n")).then(() => {
                  setCopiedLogs(true)
                  setTimeout(() => setCopiedLogs(false), 2000)
                })
              }}
              className={`rounded border px-3 py-1.5 text-xs font-medium transition-colors flex items-center gap-1.5
                ${copiedLogs 
                  ? "border-green-500/30 bg-green-500/10 text-green-400" 
                  : "border-neutral-700 bg-neutral-800/30 text-neutral-300 hover:border-neutral-500 hover:text-white"}`}
            >
              {copiedLogs ? (
                <>
                  <Check className="w-3.5 h-3.5" />
                  <span>Copied</span>
                </>
              ) : (
                <>
                  <Copy className="w-3.5 h-3.5" />
                  <span>Copy Logs</span>
                </>
              )}
            </button>
            <button
              type="button"
              onClick={onClose}
              className="rounded bg-brand-500 px-4 py-1.5 text-xs font-semibold text-neutral-900 hover:bg-brand-400 transition-colors"
            >
              Dismiss
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
