import { Loader2 } from "lucide-react"

interface Step3DenProps {
  denMaxRunners: number
  setDenMaxRunners: (count: number) => void
  saving: boolean
  saveDenConfig: () => Promise<boolean>
  onBack: () => void
  onContinue: () => void
}

export default function Step3Den({
  denMaxRunners,
  setDenMaxRunners,
  saving,
  saveDenConfig,
  onBack,
  onContinue,
}: Step3DenProps) {
  return (
    <div className="space-y-5 animate-fade-in">
      <div className="space-y-4">
        <div className="space-y-2 border-t border-neutral-800 pt-4">
          <label className="block text-xs font-semibold text-neutral-300">Global Max Concurrent Runners</label>
          <input
            type="number"
            value={denMaxRunners}
            onChange={e => setDenMaxRunners(Math.max(1, parseInt(e.target.value) || 1))}
            className="w-full rounded-md border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm text-white placeholder-neutral-600 focus:border-brand-500 focus:outline-none"
          />
          <p className="text-[10px] text-neutral-500">
            Caps the maximum number of concurrent running tasks to protect your system performance.
          </p>
        </div>

        <div className="flex justify-between pt-1 border-t border-neutral-800">
          <button
            type="button"
            onClick={onBack}
            className="rounded-md border border-neutral-700 px-4 py-2 text-sm text-neutral-400 hover:text-white transition-colors"
          >
            Back
          </button>
          <button
            type="button"
            onClick={async () => {
              const ok = await saveDenConfig()
              if (ok) onContinue()
            }}
            disabled={saving}
            className="rounded-md bg-brand-500 px-5 py-2 text-sm font-semibold text-neutral-900 hover:bg-brand-400 disabled:opacity-40 transition-colors"
          >
            {saving ? "Saving..." : "Continue"}
          </button>
        </div>
      </div>
    </div>
  )
}