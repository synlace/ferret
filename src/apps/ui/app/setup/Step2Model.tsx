import { useState } from "react"
import { Provider } from "./providers"
import { ModelPickerModal } from "../projects/ModelPickerModal"

interface Step2ModelProps {
  model: string
  setModel: (m: string) => void
  provider: Provider
  getModelsForProvider: () => Promise<{ id: string; name: string }[]>
  saveError: string
  baseUrl: string
  onBack: () => void
  onContinue: () => void
}

export default function Step2Model({
  model,
  setModel,
  provider,
  getModelsForProvider,
  saveError,
  baseUrl,
  onBack,
  onContinue
}: Step2ModelProps) {
  const [showModelPicker, setShowModelPicker] = useState(false)

  return (
    <div className="space-y-5">
      <div className="space-y-2">
        <label className="block text-xs font-medium text-neutral-300">Model</label>
        <button
          type="button"
          onClick={() => setShowModelPicker(true)}
          className="w-full rounded-md border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm text-left flex items-center justify-between hover:border-neutral-500 focus:border-brand-500 focus:outline-none transition-colors"
        >
          <span className={model ? "text-white" : "text-neutral-500"}>
            {model || "Select a model..."}
          </span>
          <span className="text-neutral-500 text-xs">▾</span>
        </button>
        <p className="text-xs text-neutral-500">
          Used for all AI features. You can change it per-project later.
        </p>
      </div>

      {showModelPicker && (
        <ModelPickerModal
          currentModel={model}
          onSelect={id => { setModel(id); setShowModelPicker(false) }}
          onClose={() => setShowModelPicker(false)}
          getModels={getModelsForProvider}
        />
      )}

      <div className="rounded-lg border border-neutral-700 bg-neutral-800/50 divide-y divide-neutral-700 text-sm">
        <div className="flex justify-between px-4 py-2.5">
          <span className="text-neutral-400">Provider</span>
          <span className="text-white font-medium">{provider.name}</span>
        </div>
        <div className="flex justify-between px-4 py-2.5">
          <span className="text-neutral-400">Model</span>
          <span className="text-white font-medium">{model}</span>
        </div>
        {provider.local && (
          <div className="flex justify-between px-4 py-2.5">
            <span className="text-neutral-400">Base URL</span>
            <span className="text-white font-medium text-xs">{baseUrl || provider.defaultBaseUrl}</span>
          </div>
        )}
      </div>

      {saveError && (
        <p className="rounded-md border border-red-800 bg-red-900/30 px-3 py-2 text-xs text-red-400">
          {saveError}
        </p>
      )}

      <div className="flex justify-between pt-1">
        <button
          type="button"
          onClick={onBack}
          className="rounded-md border border-neutral-700 px-4 py-2 text-sm text-neutral-400 hover:text-white transition-colors"
        >
          Back
        </button>
        <button
          type="button"
          onClick={onContinue}
          disabled={!model}
          className="rounded-md bg-brand-500 px-5 py-2 text-sm font-semibold text-neutral-900 hover:bg-brand-400 disabled:opacity-40 transition-colors"
        >
          Continue
        </button>
      </div>
    </div>
  )
}
