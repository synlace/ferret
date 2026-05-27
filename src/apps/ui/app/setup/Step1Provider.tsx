import { useRouter } from "next/navigation"
import { useRef, useEffect } from "react"
import { Provider } from "./providers"

interface Step1ProviderProps {
  provider: Provider
  cloudProviders: Provider[]
  localProviders: Provider[]
  selectProvider: (p: Provider) => void
  apiKey: string
  setApiKey: (key: string) => void
  provisioningKey: string
  setProvisioningKey: (key: string) => void
  baseUrl: string
  setBaseUrl: (url: string) => void
  testConnection: () => void
  testing: boolean
  testResult: {
    ok: boolean
    error?: string
    key_results?: { label: string; ok: boolean; error?: string }[]
  } | null
  onContinue: () => void
}

export default function Step1Provider({
  provider,
  cloudProviders,
  localProviders,
  selectProvider,
  apiKey,
  setApiKey,
  provisioningKey,
  setProvisioningKey,
  baseUrl,
  setBaseUrl,
  testConnection,
  testing,
  testResult,
  onContinue
}: Step1ProviderProps) {
  const router = useRouter()
  const apiKeyInputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (!provider.local) {
      const timer = setTimeout(() => {
        if (apiKeyInputRef.current) {
          apiKeyInputRef.current.focus()
        }
      }, 50)
      return () => clearTimeout(timer)
    }
  }, [provider])

  return (
    <div className="space-y-6">
      <div className="flex flex-col md:flex-row gap-6">
        {/* Left column: Provider Selection */}
        <div className="flex-1 space-y-5">
          <div>
            <p className="text-[10px] font-semibold uppercase tracking-widest text-neutral-500 mb-2">Cloud providers</p>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              {cloudProviders.map(p => (
                <button
                  key={p.key}
                  type="button"
                  onClick={() => selectProvider(p)}
                  className={`flex items-center gap-3 rounded-lg border px-3 py-2.5 text-left transition-all w-full
                    ${provider.key === p.key
                      ? "border-brand-500 bg-brand-500/10 text-white"
                      : "border-neutral-700 bg-neutral-800/50 text-neutral-300 hover:border-neutral-500 hover:bg-neutral-800"
                    }`}
                >
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={p.icon} alt={p.name} width={28} height={28} className="rounded flex-shrink-0" />
                  <span className="flex-1 min-w-0">
                    <span className={`block text-sm font-medium leading-tight ${provider.key === p.key ? "text-white" : "text-neutral-200"}`}>{p.name}</span>
                    <span className="block text-[11px] text-neutral-500 leading-tight mt-0.5">{p.tag}</span>
                  </span>
                  <span className={`text-brand-400 text-xs flex-shrink-0 transition-opacity duration-200 ${provider.key === p.key ? "opacity-100" : "opacity-0 pointer-events-none"}`}>✓</span>
                </button>
              ))}
            </div>
          </div>

          <div>
            <p className="text-[10px] font-semibold uppercase tracking-widest text-neutral-500 mb-2">Local providers</p>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              {localProviders.map(p => (
                <button
                  key={p.key}
                  type="button"
                  onClick={() => selectProvider(p)}
                  className={`flex items-center gap-3 rounded-lg border px-3 py-2.5 text-left transition-all w-full
                    ${provider.key === p.key
                      ? "border-brand-500 bg-brand-500/10 text-white"
                      : "border-neutral-700 bg-neutral-800/50 text-neutral-300 hover:border-neutral-500 hover:bg-neutral-800"
                    }`}
                >
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={p.icon} alt={p.name} width={28} height={28} className="rounded flex-shrink-0" />
                  <span className="flex-1 min-w-0">
                    <span className={`block text-sm font-medium leading-tight ${provider.key === p.key ? "text-white" : "text-neutral-200"}`}>{p.name}</span>
                    <span className="block text-[11px] text-neutral-500 leading-tight mt-0.5">{p.tag}</span>
                  </span>
                  <span className={`text-brand-400 text-xs flex-shrink-0 transition-opacity duration-200 ${provider.key === p.key ? "opacity-100" : "opacity-0 pointer-events-none"}`}>✓</span>
                </button>
              ))}
            </div>
          </div>
        </div>

        {/* Right column: Credentials & Configuration */}
        <div className="flex-1 border-t md:border-t-0 md:border-l border-neutral-800 pt-6 md:pt-0 md:pl-6 space-y-5">
          <div>
            <p className="text-[10px] font-semibold uppercase tracking-widest text-neutral-500 mb-3">Credentials & Connection</p>

            {provider.local ? (
              <div className="space-y-4">
                <div className="space-y-2">
                  <label className="block text-xs font-medium text-neutral-300">
                    Base URL
                    <span className="ml-1 text-neutral-500">(optional — defaults to {provider.defaultBaseUrl})</span>
                  </label>
                  <input
                    type="url"
                    value={baseUrl}
                    onChange={e => setBaseUrl(e.target.value)}
                    placeholder={provider.defaultBaseUrl}
                    className="w-full rounded-md border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm text-white placeholder-neutral-600 focus:border-brand-500 focus:outline-none"
                  />
                  <p className="text-xs text-neutral-500">
                    Make sure {provider.name} is running and accessible from this container.
                  </p>
                </div>
                <div className="space-y-1">
                  <button
                    type="button"
                    onClick={testConnection}
                    disabled={testing}
                    className="rounded-md border border-neutral-600 px-4 py-2 text-xs font-medium text-neutral-300 hover:border-neutral-400 hover:text-white disabled:opacity-40 transition-colors"
                  >
                    {testing ? "Testing connection..." : "Test connection"}
                  </button>
                  <p className="h-4 text-xs font-medium">
                    {testResult && (
                      <span className={testResult.ok ? "text-green-400" : "text-red-400"}>
                        {testResult.ok ? "✓ Connected" : `✗ ${testResult.error ?? "Connection failed"}`}
                      </span>
                    )}
                  </p>
                </div>
              </div>
            ) : (
              <div className="space-y-4">
                <div className="space-y-2">
                  <label className="block text-xs font-medium text-neutral-300">
                    API Key{" "}
                    {provider.key === "openrouter"
                      ? <span className="ml-1 text-neutral-500">(optional if provisioning key provided)</span>
                      : <span className="text-red-400">*</span>
                    }
                  </label>
                  <input
                    ref={apiKeyInputRef}
                    type="password"
                    value={apiKey}
                    onChange={e => setApiKey(e.target.value)}
                    placeholder="sk-..."
                    autoComplete="off"
                    data-bwignore="true"
                    data-lpignore="true"
                    data-1p-ignore
                    data-form-type="other"
                    data-keeper-ignore="true"
                    className="w-full rounded-md border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm text-white placeholder-neutral-600 focus:border-brand-500 focus:outline-none"
                  />
                  <p className="text-xs text-neutral-500 leading-normal">
                    Your key is stored locally and only sent to the provider&apos;s API.
                    {provider.key === "openrouter" && (
                      <> Get a free key at{" "}
                        <a href="https://openrouter.ai/keys" target="_blank" rel="noreferrer" className="text-brand-400 hover:underline">
                          openrouter.ai/keys
                        </a>.
                      </>
                    )}
                  </p>
                </div>

                {/* OpenRouter optional provisioning key */}
                {provider.key === "openrouter" && (
                  <div className="space-y-2 border-t border-neutral-800 pt-4">
                    <label className="block text-xs font-medium text-neutral-300">
                      Provisioning Key{" "}
                      <span className="ml-1 rounded bg-yellow-900/50 px-1.5 py-0.5 text-[10px] font-semibold text-yellow-400 uppercase tracking-wide">Optional</span>
                    </label>
                    <input
                      type="password"
                      value={provisioningKey}
                      onChange={e => setProvisioningKey(e.target.value)}
                      placeholder="sk-or-v1-... (master account key)"
                      autoComplete="off"
                      data-bwignore="true"
                      data-lpignore="true"
                      data-1p-ignore
                      data-form-type="other"
                      data-keeper-ignore="true"
                      className="w-full rounded-md border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm text-white placeholder-neutral-600 focus:border-brand-500 focus:outline-none"
                    />
                    <p className="text-xs text-neutral-500">
                      Enables auto-creation of per-project sub-keys via the{" "}
                      <a href="https://openrouter.ai/docs/provisioned-keys" target="_blank" rel="noreferrer" className="text-brand-400 hover:underline">
                        OpenRouter provisioning API
                      </a>. Leave blank to use your main key for all projects.
                    </p>
                  </div>
                )}

                {/* Test connection */}
                <div className="space-y-1">
                  <button
                    type="button"
                    onClick={testConnection}
                    disabled={testing || (!apiKey && !provisioningKey)}
                    className="rounded-md border border-neutral-600 px-4 py-2 text-xs font-medium text-neutral-300 hover:border-neutral-400 hover:text-white disabled:opacity-40 transition-colors"
                  >
                    {testing ? "Testing connection..." : "Test connection"}
                  </button>
                  {testResult?.key_results ? (
                    <div className="space-y-0.5 pt-0.5">
                      {testResult.key_results.map(kr => (
                        <p key={kr.label} className={`text-xs font-medium ${kr.ok ? "text-green-400" : "text-red-400"}`}>
                          {kr.ok ? `✓ ${kr.label}: Connected` : `✗ ${kr.label}: ${kr.error ?? "Failed"}`}
                        </p>
                      ))}
                    </div>
                  ) : (
                    <p className="h-4 text-xs font-medium">
                      {testResult && (
                        <span className={testResult.ok ? "text-green-400" : "text-red-400"}>
                          {testResult.ok ? "✓ Connected" : `✗ ${testResult.error ?? "Connection failed"}`}
                        </span>
                      )}
                    </p>
                  )}
                </div>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Step footer buttons */}
      <div className="flex justify-end pt-4 border-t border-neutral-800">
        <button
          type="button"
          onClick={onContinue}
          disabled={!provider.local && !testResult?.ok}
          className="rounded-md bg-brand-500 px-5 py-2 text-sm font-semibold text-neutral-900 hover:bg-brand-400 disabled:opacity-40 transition-colors"
        >
          Continue
        </button>
      </div>
    </div>
  )
}
