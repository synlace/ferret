import { useState } from "react"
import { X, Loader2, Upload } from "lucide-react"
import { apiFetch } from "@/lib/api-fetch"

interface ImportBackupModalProps {
  isOpen: boolean
  onClose: () => void
  apiBase: string
  onSuccess: () => void
}

export default function ImportBackupModal({
  isOpen,
  onClose,
  apiBase,
  onSuccess
}: ImportBackupModalProps) {
  const [importFile, setImportFile] = useState<File | null>(null)
  const [passphrase, setPassphrase] = useState("")
  const [importError, setImportError] = useState<string | null>(null)
  const [importing, setImporting] = useState(false)

  if (!isOpen) return null

  const handleWizardImport = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!importFile) return
    setImporting(true)
    setImportError(null)

    try {
      const reader = new FileReader()
      reader.onload = async () => {
        const base64Content = (reader.result as string).split(",")[1]
        try {
          const res = await apiFetch(`${apiBase}/api/settings/import`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              file_content: base64Content,
              passphrase: passphrase || undefined
            }),
          })

          if (!res.ok) {
            const d = await res.json()
            throw new Error(d.detail ?? "Import failed")
          }

          onSuccess()
        } catch (err) {
          setImportError(err instanceof Error ? err.message : "Import failed")
          setImporting(false)
        }
      }
      reader.readAsDataURL(importFile)
    } catch (err) {
      setImportError("Failed to read the file.")
      setImporting(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      {/* Backdrop */}
      <div 
        className="fixed inset-0 bg-black/80 backdrop-blur-sm cursor-pointer" 
        onClick={onClose}
      />
      
      {/* Modal Content */}
      <div className="relative bg-neutral-900 border border-neutral-800 rounded-xl max-w-sm w-full p-5 space-y-4 shadow-2xl z-10 animate-fade-in">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-semibold text-white">Import Configuration</h3>
          <button onClick={onClose} className="text-neutral-500 hover:text-neutral-300">
            <X className="w-4 h-4" />
          </button>
        </div>

        <form onSubmit={handleWizardImport} className="space-y-4">
          <p className="text-xs text-neutral-400">Select a Ferret config backup to restore API keys and AWS credentials.</p>
          
          <input
            type="file"
            accept=".json"
            onChange={e => setImportFile(e.target.files?.[0] ?? null)}
            className="block w-full text-xs text-neutral-400 file:mr-4 file:py-1 file:px-2 file:border file:border-neutral-800 file:text-xs file:font-semibold file:bg-neutral-900 file:text-neutral-200 hover:file:bg-neutral-800 cursor-pointer"
          />

          <div className="space-y-1">
            <label className="text-[10px] text-neutral-500 uppercase tracking-wider font-semibold">Passphrase (if encrypted)</label>
            <input
              type="password"
              placeholder="Decryption passphrase"
              value={passphrase}
              onChange={e => setPassphrase(e.target.value)}
              className="w-full bg-neutral-800 border border-neutral-700 rounded-lg px-3 py-2 text-neutral-100 text-xs placeholder-neutral-600 focus:outline-none focus:ring-1 focus:ring-brand-500"
            />
          </div>

          {importError && (
            <div className="text-xs text-red-400 bg-red-950/20 border border-red-900 px-3 py-2 rounded">
              {importError}
            </div>
          )}

          <button 
            type="submit" 
            disabled={!importFile || importing} 
            className="w-full rounded bg-brand-500 py-2 text-xs font-semibold text-neutral-900 hover:bg-brand-400 disabled:opacity-40 transition-colors flex items-center justify-center gap-1.5"
          >
            {importing ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Upload className="w-3.5 h-3.5" />}
            Restore Settings
          </button>
        </form>
      </div>
    </div>
  )
}
