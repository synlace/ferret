"use client"

import { apiFetch } from "@/lib/api-fetch"

import { useState, useCallback, useRef, useEffect } from "react"
import Image from "next/image"
import { useRouter } from "next/navigation"
import { Eye, EyeOff } from "lucide-react"
import { ModelPickerModal } from "../projects/ModelPickerModal"

// ---------------------------------------------------------------------------
// Provider definitions
// ---------------------------------------------------------------------------

type ProviderKey =
  | "openrouter" | "openai" | "anthropic" | "gemini"
  | "deepseek" | "mistral" | "ollama" | "lmstudio"

interface Provider {
  key: ProviderKey
  name: string
  tag: string
  icon: string   // LobeHub CDN PNG (colour variant where available)
  local?: boolean
  defaultBaseUrl?: string
  defaultModel: string
  models: { id: string; label: string; note?: string }[]
}

const PROVIDERS: Provider[] = [
  {
    key: "openrouter",
    name: "OpenRouter",
    tag: "200+ models",
    icon: "https://unpkg.com/@lobehub/icons-static-png@latest/dark/openrouter.png",
    defaultModel: "google/gemini-3-flash-preview",
    models: [
      { id: "google/gemini-3-flash-preview",    label: "Gemini 3 Flash",   note: "Recommended" },
      { id: "google/gemini-2.5-flash-preview",  label: "Gemini 2.5 Flash" },
      { id: "google/gemini-2.5-pro-preview",    label: "Gemini 2.5 Pro" },
      { id: "anthropic/claude-sonnet-4-5",      label: "Claude Sonnet 4.5" },
      { id: "openai/gpt-4o",                    label: "GPT-4o" },
      { id: "deepseek/deepseek-r1",             label: "DeepSeek R1" },
    ],
  },
  {
    key: "openai",
    name: "OpenAI",
    tag: "Direct API",
    icon: "https://unpkg.com/@lobehub/icons-static-png@latest/dark/openai.png",
    defaultModel: "gpt-4o",
    models: [
      { id: "gpt-4o",      label: "GPT-4o",      note: "Recommended" },
      { id: "gpt-4o-mini", label: "GPT-4o Mini" },
      { id: "o3-mini",     label: "o3 Mini" },
      { id: "o4-mini",     label: "o4 Mini" },
    ],
  },
  {
    key: "anthropic",
    name: "Anthropic",
    tag: "Direct API",
    icon: "https://unpkg.com/@lobehub/icons-static-png@latest/dark/claude-color.png",
    defaultModel: "claude-sonnet-4-5",
    models: [
      { id: "claude-sonnet-4-5", label: "Claude Sonnet 4.5", note: "Recommended" },
      { id: "claude-opus-4",     label: "Claude Opus 4" },
      { id: "claude-haiku-3-5",  label: "Claude Haiku 3.5" },
    ],
  },
  {
    key: "gemini",
    name: "Gemini",
    tag: "Google AI",
    icon: "https://unpkg.com/@lobehub/icons-static-png@latest/dark/gemini-color.png",
    defaultModel: "gemini-2.5-flash-preview-05-20",
    models: [
      { id: "gemini-2.5-flash-preview-05-20", label: "Gemini 2.5 Flash", note: "Recommended" },
      { id: "gemini-2.5-pro-preview-05-06",   label: "Gemini 2.5 Pro" },
    ],
  },
  {
    key: "deepseek",
    name: "DeepSeek",
    tag: "Cost-effective",
    icon: "https://unpkg.com/@lobehub/icons-static-png@latest/dark/deepseek-color.png",
    defaultModel: "deepseek-reasoner",
    models: [
      { id: "deepseek-reasoner", label: "DeepSeek R1",  note: "Recommended" },
      { id: "deepseek-chat",     label: "DeepSeek V3" },
    ],
  },
  {
    key: "mistral",
    name: "Mistral",
    tag: "European AI",
    icon: "https://unpkg.com/@lobehub/icons-static-png@latest/dark/mistral-color.png",
    defaultModel: "mistral-large-latest",
    models: [
      { id: "mistral-large-latest", label: "Mistral Large", note: "Recommended" },
      { id: "mistral-small-latest", label: "Mistral Small" },
      { id: "codestral-latest",     label: "Codestral" },
    ],
  },
  {
    key: "ollama",
    name: "Ollama",
    tag: "localhost:11434",
    icon: "https://unpkg.com/@lobehub/icons-static-png@latest/dark/ollama.png",
    local: true,
    defaultBaseUrl: "http://localhost:11434/v1",
    defaultModel: "llama3.3",
    models: [
      { id: "llama3.3",       label: "Llama 3.3",       note: "Recommended" },
      { id: "llama3.1:8b",    label: "Llama 3.1 8B" },
      { id: "mistral",        label: "Mistral 7B" },
      { id: "qwen2.5-coder",  label: "Qwen 2.5 Coder" },
    ],
  },
  {
    key: "lmstudio",
    name: "LM Studio",
    tag: "localhost:1234",
    icon: "https://unpkg.com/@lobehub/icons-static-png@latest/dark/lmstudio.png",
    local: true,
    defaultBaseUrl: "http://localhost:1234/v1",
    defaultModel: "local-model",
    models: [
      { id: "local-model", label: "Active model in LM Studio", note: "Recommended" },
    ],
  },
]

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000"

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function SetupPage() {
  const router = useRouter()

  // Step 0 = password, 1 = provider, 2 = configure, 3 = model, 4 = done
  const [step, setStep]               = useState<0 | 1 | 2 | 3 | 4>(0)
  const [password, setPassword]       = useState("")
  const [confirmPassword, setConfirmPassword] = useState("")
  const [showPw, setShowPw]           = useState(false)
  const [showConfirmPw, setShowConfirmPw] = useState(false)
  const [pwError, setPwError]         = useState("")
  const [provider, setProvider]       = useState<Provider>(PROVIDERS[0])
  const [apiKey, setApiKey]           = useState("")
  const [provisioningKey, setProvisioningKey] = useState("")
  const [baseUrl, setBaseUrl]         = useState("")
  const [model, setModel]             = useState(PROVIDERS[0].defaultModel)
  const [testing, setTesting]         = useState(false)
  const [testResult, setTestResult]   = useState<{
    ok: boolean
    error?: string
    key_results?: { label: string; ok: boolean; error?: string }[]
  } | null>(null)
  const [saving, setSaving]           = useState(false)
  const [saveError, setSaveError]     = useState("")
  const [showModelPicker, setShowModelPicker] = useState(false)

  const passwordRef = useRef<HTMLInputElement>(null)
  useEffect(() => { passwordRef.current?.focus() }, [])

  function advanceFromPassword() {
    setPwError("")
    if (password.length < 8) {
      setPwError("Password must be at least 8 characters.")
      return
    }
    if (password !== confirmPassword) {
      setPwError("Passwords do not match.")
      return
    }
    setStep(1)
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  function selectProvider(p: Provider) {
    setProvider(p)
    setModel(p.defaultModel)
    setBaseUrl(p.defaultBaseUrl ?? "")
    setApiKey("")
    setProvisioningKey("")
    setTestResult(null)
  }

  // ---------------------------------------------------------------------------
  // Live model fetching — key is already validated before Step 3 is reached
  // ---------------------------------------------------------------------------

  const getModelsForProvider = useCallback(async (): Promise<{ id: string; name: string }[]> => {
    const resolvedBase = baseUrl || provider.defaultBaseUrl || ""

    // OpenRouter: public endpoint, no key needed
    if (provider.key === "openrouter") {
      const r = await apiFetch("https://openrouter.ai/api/v1/models")
      if (!r.ok) throw new Error(`OpenRouter returned ${r.status}`)
      const d = await r.json()
      return (d.data ?? []).map((m: { id: string; name: string }) => ({ id: m.id, name: m.name }))
    }

    // Ollama: GET {base}/api/tags (no key)
    if (provider.key === "ollama") {
      const tagsUrl = resolvedBase.replace(/\/v1\/?$/, "") + "/api/tags"
      const r = await apiFetch(tagsUrl)
      if (!r.ok) throw new Error(`Ollama returned ${r.status}`)
      const d = await r.json()
      return (d.models ?? []).map((m: { name: string }) => ({ id: m.name, name: m.name }))
    }

    // LM Studio: GET {base}/models (no key)
    if (provider.key === "lmstudio") {
      const r = await apiFetch(`${resolvedBase}/models`)
      if (!r.ok) throw new Error(`LM Studio returned ${r.status}`)
      const d = await r.json()
      return (d.data ?? []).map((m: { id: string }) => ({ id: m.id, name: m.id }))
    }

    // Anthropic: uses x-api-key header and returns display_name
    if (provider.key === "anthropic") {
      const r = await apiFetch("https://api.anthropic.com/v1/models", {
        headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
      })
      if (!r.ok) throw new Error(`Anthropic returned ${r.status}`)
      const d = await r.json()
      return (d.data ?? []).map((m: { id: string; display_name?: string }) => ({
        id: m.id,
        name: m.display_name || m.id,
      }))
    }

    // All other OpenAI-compatible cloud providers (openai, gemini, deepseek, mistral)
    const r = await apiFetch(`${resolvedBase}/models`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    })
    if (!r.ok) throw new Error(`${provider.name} returned ${r.status}`)
    const d = await r.json()
    return (d.data ?? []).map((m: { id: string }) => ({ id: m.id, name: m.id }))
  }, [provider, apiKey, baseUrl])

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

  async function saveSetup() {
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
        setSaveError(err.detail ?? "Failed to save configuration")
        return
      }
      setStep(4)
    } catch (e) {
      setSaveError(String(e))
    } finally {
      setSaving(false)
    }
  }

  // -------------------------------------------------------------------------
  // Derived
  // -------------------------------------------------------------------------

  const cloudProviders = PROVIDERS.filter(p => !p.local)
  const localProviders = PROVIDERS.filter(p => p.local)
  const steps = ["Password", "Provider", "Configure", "Model", "Done"]

  // -------------------------------------------------------------------------
  // Layout
  // -------------------------------------------------------------------------

  return (
    // Outer: full-screen, scrollable. Content is top-aligned with fixed padding
    // so the header and step indicator never shift vertically — only the card
    // below them grows/shrinks.
    <div className="min-h-screen bg-neutral-950 flex flex-col items-center pt-8 pb-12 px-4">
      <div className="w-full max-w-lg">

        {/* Header — mascot to the side of text — always at the same Y position */}
        <div className="flex items-center gap-4 mb-8">
          <Image src="/ferret.png" alt="FERRET" width={56} height={56} className="rounded-xl flex-shrink-0" />
          <div>
            <h1 className="text-2xl font-bold text-white">Welcome to FERRET</h1>
            <p className="mt-0.5 text-sm text-neutral-400">
              Set up your AI provider to get started
            </p>
          </div>
        </div>

        {/* Step indicator — always at the same Y position */}
        <div className="mb-6 flex items-center">
          {steps.map((label, i) => {
            const active = step === i
            const done   = step > i
            return (
              <div key={label} className="flex items-center flex-1 last:flex-none">
                <div className="flex flex-col items-center gap-1">
                  <div className={`flex h-7 w-7 items-center justify-center rounded-full text-xs font-bold transition-colors
                    ${done   ? "bg-orange-500 text-white"
                    : active ? "border-2 border-orange-500 text-orange-400"
                    :          "border border-neutral-700 text-neutral-600"}`}
                  >
                    {done ? "✓" : i + 1}
                  </div>
                  <span className={`text-[10px] ${active ? "text-orange-400" : done ? "text-neutral-400" : "text-neutral-600"}`}>
                    {label}
                  </span>
                </div>
                {i < steps.length - 1 && (
                  <div className={`flex-1 h-px mx-2 mb-4 ${step > i ? "bg-orange-500" : "bg-neutral-700"}`} />
                )}
              </div>
            )
          })}
        </div>

        {/* Card — card title and subtitle have fixed heights so the step content
            below them starts at a consistent Y position across all steps */}
        <div className="rounded-xl border border-neutral-800 bg-neutral-900 p-6 shadow-2xl">
          {/* Fixed-height card header — 2 lines reserved so content never shifts */}
          <div className="mb-5 h-[52px] flex flex-col justify-center">
            <h2 className="text-base font-semibold text-white leading-tight">
              {step === 0 && "Set a Password"}
              {step === 1 && "Choose an AI Provider"}
              {step === 2 && `Configure ${provider.name}`}
              {step === 3 && "Choose a Default Model"}
              {step === 4 && "Setup complete"}
            </h2>
            <p className="mt-0.5 text-xs text-neutral-500 leading-tight">
              {step === 0 && "Protect your Ferret instance with a password. Minimum 8 characters."}
              {step === 1 && "Select how FERRET calls the AI for chat, annotations, and findings."}
              {step === 2 && (provider.local ? "No API key required — FERRET connects directly to your local server." : "Enter your API key to authenticate with the provider.")}
              {step === 3 && "Used for all AI features. You can change it per-project later."}
              {step === 4 && "\u00a0"}
            </p>
          </div>

          {/* ----------------------------------------------------------------
              Step 0 — Set password
          ---------------------------------------------------------------- */}
          {step === 0 && (
            <div className="space-y-4">
              {/* Password */}
              <div className="space-y-1.5">
                <label className="block text-xs font-medium text-neutral-300">Password</label>
                <div className="relative">
                  <input
                    ref={passwordRef}
                    type={showPw ? "text" : "password"}
                    value={password}
                    onChange={e => setPassword(e.target.value)}
                    onKeyDown={e => e.key === "Enter" && advanceFromPassword()}
                    placeholder="Min. 8 characters"
                    autoComplete="new-password"
                    className="w-full bg-neutral-800 border border-neutral-700 rounded-lg px-3 py-2.5 pr-10
                               text-neutral-100 text-sm placeholder-neutral-600
                               focus:outline-none focus:ring-1 focus:ring-orange-500 focus:border-orange-500"
                  />
                  <button type="button" onClick={() => setShowPw(v => !v)} tabIndex={-1}
                    className="absolute right-3 top-1/2 -translate-y-1/2 text-neutral-500 hover:text-neutral-300">
                    {showPw ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                  </button>
                </div>
              </div>

              {/* Confirm password */}
              <div className="space-y-1.5">
                <label className="block text-xs font-medium text-neutral-300">Confirm password</label>
                <div className="relative">
                  <input
                    type={showConfirmPw ? "text" : "password"}
                    value={confirmPassword}
                    onChange={e => setConfirmPassword(e.target.value)}
                    onKeyDown={e => e.key === "Enter" && advanceFromPassword()}
                    placeholder="Re-enter password"
                    autoComplete="new-password"
                    className="w-full bg-neutral-800 border border-neutral-700 rounded-lg px-3 py-2.5 pr-10
                               text-neutral-100 text-sm placeholder-neutral-600
                               focus:outline-none focus:ring-1 focus:ring-orange-500 focus:border-orange-500"
                  />
                  <button type="button" onClick={() => setShowConfirmPw(v => !v)} tabIndex={-1}
                    className="absolute right-3 top-1/2 -translate-y-1/2 text-neutral-500 hover:text-neutral-300">
                    {showConfirmPw ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                  </button>
                </div>
              </div>

              {pwError && (
                <p className="text-red-400 text-xs bg-red-950/40 border border-red-900/50 rounded-lg px-3 py-2">
                  {pwError}
                </p>
              )}

              <div className="flex justify-end pt-1">
                <button
                  onClick={advanceFromPassword}
                  disabled={!password || !confirmPassword}
                  className="rounded-md bg-orange-500 px-5 py-2 text-sm font-semibold text-white hover:bg-orange-400 disabled:opacity-40 transition-colors"
                >
                  Continue →
                </button>
              </div>
            </div>
          )}

          {/* ----------------------------------------------------------------
              Step 1 — Choose provider
          ---------------------------------------------------------------- */}
          {step === 1 && (
            <div className="space-y-5">
              <div>
                <p className="text-[10px] font-semibold uppercase tracking-widest text-neutral-500 mb-2">Cloud providers</p>
                <div className="grid grid-cols-2 gap-2">
                  {cloudProviders.map(p => (
                    <button
                      key={p.key}
                      onClick={() => selectProvider(p)}
                      className={`flex items-center gap-3 rounded-lg border px-3 py-2.5 text-left transition-all w-full
                        ${provider.key === p.key
                          ? "border-orange-500 bg-orange-500/10 text-white"
                          : "border-neutral-700 bg-neutral-800/50 text-neutral-300 hover:border-neutral-500 hover:bg-neutral-800"
                        }`}
                    >
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img src={p.icon} alt={p.name} width={28} height={28} className="rounded flex-shrink-0" />
                      <span className="flex-1 min-w-0">
                        <span className="block text-sm font-medium leading-tight">{p.name}</span>
                        <span className="block text-[11px] text-neutral-500 leading-tight mt-0.5">{p.tag}</span>
                      </span>
                      {provider.key === p.key && (
                        <span className="text-orange-400 text-xs flex-shrink-0">✓</span>
                      )}
                    </button>
                  ))}
                </div>
              </div>

              <div>
                <p className="text-[10px] font-semibold uppercase tracking-widest text-neutral-500 mb-2">Local providers</p>
                <div className="grid grid-cols-2 gap-2">
                  {localProviders.map(p => (
                    <button
                      key={p.key}
                      onClick={() => selectProvider(p)}
                      className={`flex items-center gap-3 rounded-lg border px-3 py-2.5 text-left transition-all w-full
                        ${provider.key === p.key
                          ? "border-orange-500 bg-orange-500/10 text-white"
                          : "border-neutral-700 bg-neutral-800/50 text-neutral-300 hover:border-neutral-500 hover:bg-neutral-800"
                        }`}
                    >
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img src={p.icon} alt={p.name} width={28} height={28} className="rounded flex-shrink-0" />
                      <span className="flex-1 min-w-0">
                        <span className="block text-sm font-medium leading-tight">{p.name}</span>
                        <span className="block text-[11px] text-neutral-500 leading-tight mt-0.5">{p.tag}</span>
                      </span>
                      {provider.key === p.key && (
                        <span className="text-orange-400 text-xs flex-shrink-0">✓</span>
                      )}
                    </button>
                  ))}
                </div>
              </div>

              <div className="flex justify-between pt-1">
                <button
                  onClick={() => setStep(0)}
                  className="rounded-md border border-neutral-700 px-4 py-2 text-sm text-neutral-400 hover:text-white transition-colors"
                >
                  ← Back
                </button>
                <button
                  onClick={() => setStep(2)}
                  className="rounded-md bg-orange-500 px-5 py-2 text-sm font-semibold text-white hover:bg-orange-400 transition-colors"
                >
                  Continue →
                </button>
              </div>
            </div>
          )}

          {/* ----------------------------------------------------------------
              Step 2 — Configure credentials
          ---------------------------------------------------------------- */}
          {step === 2 && (
            <div className="space-y-5">
              <div className="flex items-center gap-3 rounded-lg border border-neutral-700 bg-neutral-800/50 px-4 py-3">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={provider.icon} alt={provider.name} width={28} height={28} className="rounded flex-shrink-0" />
                <div>
                  <p className="text-sm font-semibold text-white">{provider.name}</p>
                  <p className="text-xs text-neutral-400">{provider.tag}</p>
                </div>
              </div>

              {provider.local ? (
                <div className="space-y-3">
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
                      className="w-full rounded-md border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm text-white placeholder-neutral-600 focus:border-orange-500 focus:outline-none"
                    />
                    <p className="text-xs text-neutral-500">
                      Make sure {provider.name} is running and accessible from this container.
                    </p>
                  </div>
                  <div className="space-y-1">
                    <button
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
                <div className="space-y-2">
                  <label className="block text-xs font-medium text-neutral-300">
                    API Key{" "}
                    {provider.key === "openrouter"
                      ? <span className="ml-1 text-neutral-500">(optional if provisioning key provided)</span>
                      : <span className="text-red-400">*</span>
                    }
                  </label>
                  <input
                    type="password"
                    value={apiKey}
                    onChange={e => setApiKey(e.target.value)}
                    placeholder="sk-..."
                    autoComplete="off"
                    className="w-full rounded-md border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm text-white placeholder-neutral-600 focus:border-orange-500 focus:outline-none"
                  />
                  <p className="text-xs text-neutral-500">
                    Your key is stored locally and only sent to the provider&apos;s API.
                    {provider.key === "openrouter" && (
                      <> Get a free key at{" "}
                        <a href="https://openrouter.ai/keys" target="_blank" rel="noreferrer" className="text-orange-400 hover:underline">
                          openrouter.ai/keys
                        </a>.
                      </>
                    )}
                  </p>
                </div>
              )}

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
                    className="w-full rounded-md border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm text-white placeholder-neutral-600 focus:border-orange-500 focus:outline-none"
                  />
                  <p className="text-xs text-neutral-500">
                    Enables auto-creation of per-project sub-keys via the{" "}
                    <a href="https://openrouter.ai/docs/provisioned-keys" target="_blank" rel="noreferrer" className="text-orange-400 hover:underline">
                      OpenRouter provisioning API
                    </a>. Leave blank to use your main key for all projects.
                  </p>
                </div>
              )}

              {/* Test connection — single button below all credential fields */}
              {!provider.local && (
                <div className="space-y-1">
                  <button
                    onClick={testConnection}
                    disabled={testing || (!apiKey && !provisioningKey)}
                    className="rounded-md border border-neutral-600 px-4 py-2 text-xs font-medium text-neutral-300 hover:border-neutral-400 hover:text-white disabled:opacity-40 transition-colors"
                  >
                    {testing ? "Testing connection..." : "Test connection"}
                  </button>
                  {/* Per-key results (OpenRouter with both keys) */}
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
              )}

              <div className="flex justify-between pt-1">
                <button
                  onClick={() => setStep(1)}
                  className="rounded-md border border-neutral-700 px-4 py-2 text-sm text-neutral-400 hover:text-white transition-colors"
                >
                  ← Back
                </button>
                <button
                  onClick={() => setStep(3)}
                  disabled={!provider.local && !testResult?.ok}
                  className="rounded-md bg-orange-500 px-5 py-2 text-sm font-semibold text-white hover:bg-orange-400 disabled:opacity-40 transition-colors"
                >
                  Continue →
                </button>
              </div>
            </div>
          )}

          {/* ----------------------------------------------------------------
              Step 3 — Select default model
          ---------------------------------------------------------------- */}
          {step === 3 && (
            <div className="space-y-5">
              <div className="space-y-2">
                <label className="block text-xs font-medium text-neutral-300">Model</label>
                <button
                  type="button"
                  onClick={() => setShowModelPicker(true)}
                  className="w-full rounded-md border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm text-left flex items-center justify-between hover:border-neutral-500 focus:border-orange-500 focus:outline-none transition-colors"
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
                  onClick={() => setStep(2)}
                  className="rounded-md border border-neutral-700 px-4 py-2 text-sm text-neutral-400 hover:text-white transition-colors"
                >
                  ← Back
                </button>
                <button
                  onClick={saveSetup}
                  disabled={saving || !model}
                  className="rounded-md bg-orange-500 px-5 py-2 text-sm font-semibold text-white hover:bg-orange-400 disabled:opacity-40 transition-colors"
                >
                  {saving ? "Saving..." : "Finish setup →"}
                </button>
              </div>
            </div>
          )}

          {/* ----------------------------------------------------------------
              Step 4 — Done
          ---------------------------------------------------------------- */}
          {step === 4 && (
            <div className="flex flex-col items-center gap-6 py-4 text-center">
              <div className="flex h-16 w-16 items-center justify-center rounded-full bg-green-500/20 text-4xl">
                ✓
              </div>
              <div>
                <h3 className="text-lg font-semibold text-white">You&apos;re all set!</h3>
                <p className="mt-1 text-sm text-neutral-400">
                  FERRET is configured to use <span className="text-white font-medium">{provider.name}</span> with model{" "}
                  <span className="text-white font-medium">{model}</span>.
                </p>
              </div>
              <div className="rounded-lg border border-neutral-700 bg-neutral-800/50 divide-y divide-neutral-700 text-sm w-full max-w-xs">
                <div className="flex justify-between px-4 py-2.5">
                  <span className="text-neutral-400">Provider</span>
                  <span className="text-white font-medium">{provider.name}</span>
                </div>
                <div className="flex justify-between px-4 py-2.5">
                  <span className="text-neutral-400">Model</span>
                  <span className="text-white font-medium">{model}</span>
                </div>
              </div>
              <p className="text-xs text-neutral-500">
                You can change these settings at any time from the Settings page.
              </p>
              <button
                onClick={() => router.replace("/login")}
                className="rounded-md bg-orange-500 px-6 py-2.5 text-sm font-semibold text-white hover:bg-orange-400 transition-colors"
              >
                Sign in to FERRET →
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
