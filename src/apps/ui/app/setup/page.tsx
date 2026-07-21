"use client"

import { apiFetch } from "@/lib/api-fetch"

import { useState, useCallback, useEffect } from "react"
import Image from "next/image"
import { useRouter } from "next/navigation"
import { FileJson } from "lucide-react"

import { PROVIDERS, Provider } from "./providers"
import ImportBackupModal from "./ImportBackupModal"
import Step1Provider from "./Step1Provider"
import Step2Model from "./Step2Model"
import Step3Den from "./Step3Den"
import Step4Password from "./Step4Password"

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000"

export default function SetupPage() {
  const router = useRouter()

  const [step, setStepState] = useState<1 | 2 | 3 | 4 | 5>(() => {
    if (typeof window !== "undefined") {
      const saved = sessionStorage.getItem("ferret:setup:step")
      if (saved) return Number(saved) as any
    }
    return 1
  })

  const [showImportModal, setShowImportModal] = useState(false)
  const [password, setPassword] = useState("")
  const [confirmPassword, setConfirmPassword] = useState("")
  const [pwError, setPwError] = useState("")
  const [ready, setReady] = useState(false)

  const [provider, setProvider] = useState<Provider>(PROVIDERS[0])
  const [apiKey, setApiKey] = useState("")
  const [provisioningKey, setProvisioningKey] = useState("")
  const [baseUrl, setBaseUrl] = useState("")
  const [model, setModel] = useState(PROVIDERS[0].defaultModel)

  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<{
    ok: boolean
    error?: string
    key_results?: { label: string; ok: boolean; error?: string }[]
  } | null>(null)

  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState("")

  const [denMaxRunners, setDenMaxRunners] = useState<number>(10)

  const setStep = (s: 1 | 2 | 3 | 4 | 5) => {
    setStepState(s)
    if (typeof window !== "undefined") {
      sessionStorage.setItem("ferret:setup:step", String(s))
    }
  }

  const clearSetupStorage = () => {
    if (typeof window !== "undefined") {
      sessionStorage.removeItem("ferret:setup:step")
    }
    apiFetch(`${API_BASE}/api/setup/progress`, {
      method: "DELETE"
    }).catch(() => {})
  }

  useEffect(() => {
    setReady(true)

    apiFetch(`${API_BASE}/api/setup/progress`)
      .then(r => r.ok ? r.json() : null)
      .then(p => {
        if (p && p.step) setStepState(p.step)
      })
      .catch(() => {})

    apiFetch(`${API_BASE}/api/setup/config`)
      .then(r => r.ok ? r.json() : null)
      .then(d => {
        if (d && d.ai_provider) {
          const matchedProv = PROVIDERS.find(p => p.key === d.ai_provider)
          if (matchedProv) {
            setProvider(matchedProv)
            if (d.ai_api_key && d.ai_api_key !== "••••••••") {
              setApiKey(d.ai_api_key)
            }
            if (d.ai_provisioning_key) {
              setProvisioningKey(d.ai_provisioning_key)
            }
            if (d.ai_base_url) {
              setBaseUrl(d.ai_base_url)
            }
            if (d.ai_model) {
              setModel(d.ai_model)
            }
          }
        }
      })
      .catch(() => {})

    apiFetch(`${API_BASE}/api/settings/dens`)
      .then(r => r.ok ? r.json() : [])
      .then(dens => {
        if (Array.isArray(dens) && dens.length > 0) {
          const local = dens.find(d => d.id === "local") || dens[0]
          if (local) {
            setDenMaxRunners(local.den_max_runners || 10)
          }
        }
      })
      .catch(() => {})
  }, [])

  function selectProvider(p: Provider) {
    setProvider(p)
    setModel(p.defaultModel)
    setBaseUrl(p.defaultBaseUrl ?? "")
    setApiKey("")
    setProvisioningKey("")
    setTestResult(null)
  }

  const getModelsForProvider = useCallback(async (): Promise<{ id: string; name: string }[]> => {
    const r = await apiFetch(`${API_BASE}/api/setup/models`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        provider: provider.key,
        api_key: apiKey || undefined,
        base_url: baseUrl || undefined,
      }),
    })
    if (!r.ok) throw new Error(`Model list fetch returned ${r.status}`)
    const d = await r.json()
    return (d.models ?? []) as { id: string; name: string }[]
  }, [provider, apiKey, baseUrl])

  if (!ready) return null

  async function testConnection() {
    setTesting(true)
    setTestResult(null)
    try {
      const res = await apiFetch(`${API_BASE}/api/setup/test`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          provider: provider.key,
          api_key: apiKey || undefined,
          provisioning_key: provisioningKey || undefined,
          base_url: baseUrl || undefined,
          model,
        }),
      })
      const data = await res.json()
      setTestResult(data)
    } catch (e) {
      setTestResult({ ok: false, error: String(e) })
    } finally {
      setTesting(false)
    }
  }

  async function saveDenConfig() {
    setSaving(true)
    setSaveError("")
    try {
      const denRes = await apiFetch(`${API_BASE}/api/settings/dens`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: "local",
          name: "Local Den",
          den_max_runners: denMaxRunners,
        }),
      })
      if (!denRes.ok) {
        const err = await denRes.json()
        setSaveError(err.detail ?? "Failed to save Den configuration")
        setSaving(false)
        return false
      }
      return true
    } catch (e) {
      setSaveError(String(e))
      setSaving(false)
      return false
    } finally {
      setSaving(false)
    }
  }

  async function saveFinalSetup() {
    setPwError("")
    if (password.length < 8) {
      setPwError("Password must be at least 8 characters.")
      return
    }
    if (password !== confirmPassword) {
      setPwError("Passwords do not match.")
      return
    }

    setSaving(true)
    setSaveError("")
    try {
      const res = await apiFetch(`${API_BASE}/api/setup`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          password,
          provider: provider.key,
          api_key: apiKey || undefined,
          provisioning_key: provisioningKey || undefined,
          base_url: baseUrl || undefined,
          model,
        }),
      })
      if (!res.ok) {
        const err = await res.json()
        setSaveError(err.detail ?? "Failed to save AI configuration")
        setSaving(false)
        return
      }

      clearSetupStorage()
      setStep(5)
    } catch (e) {
      setSaveError(String(e))
    } finally {
      setSaving(false)
    }
  }

  const cloudProviders = PROVIDERS.filter(p => !p.local)
  const localProviders = PROVIDERS.filter(p => p.local)
  const steps = ["Provider", "Model", "Den", "Password", "Done"]

  return (
    <div className="min-h-screen bg-neutral-950 flex flex-col items-center pt-4 pb-6 px-4 animate-fade-in">
      <div className="w-full max-w-4xl transition-all duration-300">

        <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 mb-6 pb-4 border-b border-neutral-800">
          <div className="flex items-center gap-3">
            <Image src="/ferret.png" alt="Ferret" width={40} height={40} className="rounded-lg flex-shrink-0" />
            <div>
              <h1 className="text-xl font-bold text-white">Welcome to Ferret</h1>
              <p className="text-xs text-neutral-400">
                Set up your AI provider to get started
              </p>
            </div>
          </div>
          <div className="flex items-center gap-1.5 sm:gap-2">
            {steps.map((label, i) => {
              const active = step === i + 1
              const done   = step > i + 1
              return (
                <div key={label} className="flex items-center gap-1.5 sm:gap-2">
                  <div className="flex items-center gap-1.5">
                    <div className={`flex h-5 w-5 items-center justify-center rounded-full text-[10px] font-semibold transition-all duration-300
                      ${done   ? "bg-brand-500 text-neutral-950"
                      : active ? "bg-brand-500/10 border border-brand-500 text-brand-400 shadow-[0_0_8px_rgba(245,158,11,0.2)]"
                      :          "border border-neutral-800 text-neutral-500"}`}
                    >
                      {done ? "✓" : i + 1}
                    </div>
                    <span className={`text-xs font-medium transition-colors duration-300 ${active ? "text-neutral-200" : done ? "text-neutral-400" : "text-neutral-600"}`}>
                      {label}
                    </span>
                  </div>
                  {i < steps.length - 1 && (
                    <div className={`w-3 sm:w-6 h-[2px] rounded-full transition-colors duration-300 ${done ? "bg-brand-500" : "bg-neutral-800"}`} />
                  )}
                </div>
              )
            })}
          </div>
        </div>

        <div className="relative w-full">
          <div
            className={`w-full transition-all duration-300 ${
              step === 1 ? "opacity-100 scale-100 relative pointer-events-auto" : "opacity-0 scale-[0.98] absolute inset-x-0 top-0 pointer-events-none"
            }`}
          >
            <div className="rounded-xl border border-neutral-800 bg-neutral-900 p-5 shadow-2xl w-full">
              <div className="mb-4 h-[44px] flex flex-col justify-center">
                <h2 className="text-base font-semibold text-white leading-tight">
                  Choose & Configure {provider.name}
                </h2>
                <p className="mt-0.5 text-xs text-neutral-500 leading-tight">
                  {provider.local ? "Select provider on the left. No API key required for local server." : "Select provider on the left and enter credentials on the right."}
                </p>
              </div>
              <Step1Provider
                provider={provider}
                cloudProviders={cloudProviders}
                localProviders={localProviders}
                selectProvider={selectProvider}
                apiKey={apiKey}
                setApiKey={setApiKey}
                provisioningKey={provisioningKey}
                setProvisioningKey={setProvisioningKey}
                baseUrl={baseUrl}
                setBaseUrl={setBaseUrl}
                testConnection={testConnection}
                testing={testing}
                testResult={testResult}
                onContinue={() => setStep(2)}
              />
            </div>
          </div>

          <div
            className={`w-full transition-all duration-300 ${
              step === 2 ? "opacity-100 scale-100 relative pointer-events-auto" : "opacity-0 scale-[0.98] absolute inset-x-0 top-0 pointer-events-none"
            }`}
          >
            <div className="rounded-xl border border-neutral-800 bg-neutral-900 p-5 shadow-2xl max-w-lg w-full mx-auto">
              <div className="mb-4 h-[44px] flex flex-col justify-center">
                <h2 className="text-base font-semibold text-white leading-tight">
                  Choose a Default Model
                </h2>
                <p className="mt-0.5 text-xs text-neutral-500 leading-tight">
                  Used for all AI features. You can change it per-project later.
                </p>
              </div>
              <Step2Model
                model={model}
                setModel={setModel}
                provider={provider}
                getModelsForProvider={getModelsForProvider}
                saveError={saveError}
                baseUrl={baseUrl}
                onBack={() => setStep(1)}
                onContinue={() => setStep(3)}
              />
            </div>
          </div>

          <div
            className={`w-full transition-all duration-300 ${
              step === 3 ? "opacity-100 scale-100 relative pointer-events-auto" : "opacity-0 scale-[0.98] absolute inset-x-0 top-0 pointer-events-none"
            }`}
          >
            <div className="rounded-xl border border-neutral-800 bg-neutral-900 p-5 shadow-2xl w-full">
              <div className="mb-4 h-[44px] flex flex-col justify-center">
                <h2 className="text-base font-semibold text-white leading-tight">
                  Configure Den (Runner Provider)
                </h2>
                <p className="mt-0.5 text-xs text-neutral-500 leading-tight">
                  Ferret runs scanning tasks in a local Docker sandbox container.
                </p>
              </div>
              <Step3Den
                denMaxRunners={denMaxRunners}
                setDenMaxRunners={setDenMaxRunners}
                saving={saving}
                saveDenConfig={saveDenConfig}
                onBack={() => setStep(2)}
                onContinue={() => setStep(4)}
              />
            </div>
          </div>

          <div
            className={`w-full transition-all duration-300 ${
              step === 4 ? "opacity-100 scale-100 relative pointer-events-auto" : "opacity-0 scale-[0.98] absolute inset-x-0 top-0 pointer-events-none"
            }`}
          >
            <div className="rounded-xl border border-neutral-800 bg-neutral-900 p-5 shadow-2xl max-w-lg w-full mx-auto">
              <div className="mb-4 h-[44px] flex flex-col justify-center">
                <h2 className="text-base font-semibold text-white leading-tight">
                  Set Instance Password
                </h2>
                <p className="mt-0.5 text-xs text-neutral-500 leading-tight">
                  Protect your Ferret instance with a password. Minimum 8 characters.
                </p>
              </div>
              <Step4Password
                password={password}
                setPassword={setPassword}
                confirmPassword={confirmPassword}
                setConfirmPassword={setConfirmPassword}
                pwError={pwError}
                saveError={saveError}
                saving={saving}
                onBack={() => setStep(3)}
                onSubmit={saveFinalSetup}
              />
            </div>
          </div>

          <div
            className={`w-full transition-all duration-300 ${
              step === 5 ? "opacity-100 scale-100 relative pointer-events-auto" : "opacity-0 scale-[0.98] absolute inset-x-0 top-0 pointer-events-none"
            }`}
          >
            <div className="rounded-xl border border-neutral-800 bg-neutral-900 p-5 shadow-2xl max-w-lg w-full mx-auto">
              <div className="mb-4 h-[44px] flex flex-col justify-center">
                <h2 className="text-base font-semibold text-white leading-tight">
                  Setup complete
                </h2>
                <p className="mt-0.5 text-xs text-neutral-500 leading-tight">
                  &nbsp;
                </p>
              </div>
              <div className="flex flex-col items-center gap-6 py-4 text-center">
                <div className="flex h-16 w-16 items-center justify-center rounded-full bg-green-500/20 text-4xl">
                  ✓
                </div>
                <div>
                  <h3 className="text-lg font-semibold text-white">You&apos;re all set!</h3>
                  <p className="mt-1 text-sm text-neutral-400">
                    Ferret is configured to use <span className="text-white font-medium">{provider.name}</span> with model{" "}
                    <span className="text-white font-medium">{model}</span>.
                  </p>
                </div>
                <div className="rounded-lg border border-neutral-700 bg-neutral-800/50 divide-y divide-neutral-700 text-sm w-full max-w-xs mx-auto">
                  <div className="flex justify-between px-4 py-2.5">
                    <span className="text-neutral-400">Provider</span>
                    <span className="text-white font-medium">{provider.name}</span>
                  </div>
                  <div className="flex justify-between px-4 py-2.5">
                    <span className="text-neutral-400">Model</span>
                    <span className="text-white font-medium">{model}</span>
                  </div>
                  <div className="flex justify-between px-4 py-2.5">
                    <span className="text-neutral-400">Max Runners</span>
                    <span className="text-white font-medium">{denMaxRunners}</span>
                  </div>
                </div>
                <p className="text-xs text-neutral-500">
                  You can change these settings at any time from the Settings page.
                </p>
                <button
                  onClick={() => router.replace("/login")}
                  className="rounded-md bg-brand-500 px-6 py-2.5 text-sm font-semibold text-neutral-900 hover:bg-brand-400 transition-colors mx-auto"
                >
                  Sign in to Ferret
                </button>
              </div>
            </div>
          </div>
        </div>

        {step === 1 && (
          <button
            type="button"
            onClick={() => setShowImportModal(true)}
            className="mt-4 text-xs text-brand-400 hover:text-brand-300 flex items-center gap-1.5 transition-colors mx-auto animate-fade-in"
          >
            <FileJson className="w-3.5 h-3.5" />
            Import existing backup profile
          </button>
        )}
      </div>

      <footer className="fixed bottom-0 left-0 right-0 flex justify-center pb-4">
        <p className="text-neutral-600 text-xs">
          by{" "}
          <a
            href="https://synlace.ai/"
            target="_blank"
            rel="noopener noreferrer"
            className="hover:text-neutral-400 transition-colors"
          >
            Synlace
          </a>
        </p>
      </footer>

      <ImportBackupModal
        isOpen={showImportModal}
        onClose={() => setShowImportModal(false)}
        apiBase={API_BASE}
        onSuccess={() => {
          window.location.href = "/setup"
        }}
      />
    </div>
  )
}