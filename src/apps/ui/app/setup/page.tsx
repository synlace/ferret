"use client"

import { apiFetch } from "@/lib/api-fetch"

import { useState, useCallback, useEffect, useRef } from "react"
import Image from "next/image"
import { useRouter } from "next/navigation"
import { Eye, EyeOff, X, Loader2, Check, Copy } from "lucide-react"
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
    icon: "/providers/openrouter.png",
    defaultModel: "x-ai/grok-4.3",
    models: [
      { id: "x-ai/grok-4.3",                    label: "Grok 4.3", note: "Recommended" },
      { id: "google/gemini-3.5-flash",          label: "Gemini 3.5 Flash" },
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
    icon: "/providers/openai.png",
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
    icon: "/providers/claude-color.png",
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
    icon: "/providers/gemini-color.png",
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
    icon: "/providers/deepseek-color.png",
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
    icon: "/providers/mistral-color.png",
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
    tag: "host-gateway:11434",
    icon: "/providers/ollama.png",
    local: true,
    // host-gateway resolves to the Docker host IP inside containers (via extra_hosts).
    // Using localhost here would point at the container itself, not the host machine.
    defaultBaseUrl: "http://host-gateway:11434/v1",
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
    tag: "host-gateway:1234",
    icon: "/providers/lmstudio.png",
    local: true,
    // host-gateway resolves to the Docker host IP inside containers (via extra_hosts).
    // Using localhost here would point at the container itself, not the host machine.
    defaultBaseUrl: "http://host-gateway:1234/v1",
    defaultModel: "local-model",
    models: [
      { id: "local-model", label: "Active model in LM Studio", note: "Recommended" },
    ],
  },
]

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000"
const SETUP_PW_KEY = "ferret:setup:pw"

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function SetupPage() {
  const router = useRouter()

  // Step 1 = provider, 2 = configure, 3 = model, 4 = den, 5 = done
  // (Step 0 / password lives at /setup/password)
  const [step, setStep]               = useState<1 | 2 | 3 | 4 | 5>(1)
  const [password, setPassword]       = useState("")
  const [confirmPassword, setConfirmPassword] = useState("")
  const [showPw, setShowPw]                 = useState(false)
  const [showConfirmPw, setShowConfirmPw]   = useState(false)
  const [pwError, setPwError]               = useState("")
  // Stays false until the sessionStorage check completes — prevents a flash
  // redirect on the initial SSR/hydration render before useEffect runs.
  const [ready, setReady]             = useState(false)
  // Guard against React StrictMode double-invocation: once we've read the key
  // we must not read it again (it will have been cleared on the first run).
  const didReadRef = useRef(false)
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

  // Den State Variables
  const [denType, setDenType]         = useState<"local" | "aws">("local")
  const [denMaxRunners, setDenMaxRunners] = useState<number>(10)
  const [denAwsKey, setDenAwsKey]     = useState("")
  const [denAwsSecret, setDenAwsSecret] = useState("")
  const [denAwsRegion, setDenAwsRegion] = useState("eu-west-1")
  const [verified, setVerified]       = useState(false)
  const [checkingExisting, setCheckingExisting] = useState(false)
  const [existingSetup, setExistingSetup] = useState<{
    exists: boolean;
    working: boolean;
    instance_id?: string;
    public_ip?: string;
    detail?: string;
  } | null>(null)
  
  // Verification Callback States
  const [verifying, setVerifying]     = useState(false)
  const [verifyLogs, setVerifyLogs]   = useState<string[]>([])
  const [wsInstance, setWsInstance]   = useState<WebSocket | null>(null)
  const [showLogsModal, setShowLogsModal] = useState(false)
  const [copiedLogs, setCopiedLogs]   = useState(false)

  // Read password from sessionStorage (written by /setup/password).
  // If missing, redirect back — user must set a password first.
  // Only runs client-side after hydration; render nothing until ready.
  // didReadRef guards against React StrictMode double-invocation in dev:
  // the first run reads+clears the key; without the guard the second run
  // would find it empty and incorrectly redirect back to /setup/password.
  useEffect(() => {
    setReady(true)
  }, [])

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

  // Fetch the model list via the API container (POST /api/setup/models) so that:
  // - Local providers (Ollama, LM Studio) are reachable via host-gateway.
  // - API keys are never sent as query-string parameters.
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

  // Early return AFTER all hooks — Rules of Hooks requires hooks before any return
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
          id: denType,
          name: denType === "local" ? "Local Den" : "Primary Fargate Den",
          den_type: denType,
          den_max_runners: denMaxRunners,
          den_aws_access_key: denAwsKey || undefined,
          den_aws_secret_key: denAwsSecret || undefined,
          den_aws_region: denAwsRegion || "eu-west-1"
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

  async function verifyAwsDen(forceFresh = false) {
    const saved = await saveDenConfig()
    if (!saved) return

    setVerifying(true)
    setSaveError("")

    if (!forceFresh) {
      setCheckingExisting(true)
      setVerifyLogs(["[Setup] Checking AWS for existing Fargate infrastructure..."])
      try {
        const checkRes = await apiFetch(`${API_BASE}/api/settings/dens/check-existing`, {
          method: "POST"
        })
        if (checkRes.ok) {
          const checkData = await checkRes.json()
          if (checkData.exists && checkData.working) {
            setExistingSetup(checkData)
            setCheckingExisting(false)
            setVerifying(false)
            setVerifyLogs(prev => [
              ...prev,
              `[Setup] ✓ Found working running instance: ${checkData.instance_id} (${checkData.public_ip})`,
              `[Setup] ✓ Tunnel is already working and connected.`
            ])
            return
          }
        }
      } catch (e) {
        // Non-fatal, fallback to full provisioning
      } finally {
        setCheckingExisting(false)
      }
    }

    setExistingSetup(null)
    setVerifyLogs(["[Setup] Deploying persistent EC2 WireGuard Hub on AWS..."])
    
    try {
      // 1. Provision the WireGuard VPN Hub first
      const wgRes = await apiFetch(`${API_BASE}/api/settings/dens/provision-wg`, {
        method: "POST",
      })
      if (!wgRes.ok) {
        const err = await wgRes.json()
        throw new Error(err.detail ?? "Failed to provision WireGuard EC2 Hub")
      }
      const wgData = await wgRes.json()
      setVerifyLogs(prev => [
        ...prev,
        `[Setup] ✓ WireGuard Hub deployed successfully (Instance: ${wgData.instance_id}).`,
        `[Setup] ✓ Gateway Public IP: ${wgData.public_ip}`,
        `[Setup] ✓ API container client tunnel is active on 10.0.0.2!`,
        `[Verification] Provisioning AWS Fargate unprivileged runner...`
      ])

      // 2. Trigger the runner_test script plan
      const runRes = await apiFetch(`${API_BASE}/api/runs`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          plan_id: "builtin:runner_test",
          target_url: "http://localhost:8000",
          den_id: "aws"
        })
      })
      
      if (!runRes.ok) {
        const err = await runRes.json()
        throw new Error(err.detail ?? "Failed to initiate verification run")
      }
      
      const runData = await runRes.json()
      const runId = runData.id
      
      // Connect WebSocket to stream logs live from verification callback
      const wsProto = window.location.protocol === "https:" ? "wss:" : "ws:"
      const apiHost = API_BASE.replace(/^https?:\/\//, "")
      const wsUrl = `${wsProto}//${apiHost}/api/runs/${runId}/ws`
      
      setVerifyLogs(prev => [...prev, `[Verification] Triggered Run ${runId}. Connecting to stream logs...`])
      const ws = new WebSocket(wsUrl)
      setWsInstance(ws)
      
      ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data)
          if (msg.line) {
            setVerifyLogs(prev => [...prev, msg.line.trim()])
          }
          if (msg.status === "done") {
             setVerifyLogs(prev => [...prev, "✓ Verification callback success! Connection established. Ready to proceed."])
             ws.close()
             setVerified(true)
             setVerifying(false)
          } else if (msg.status === "error") {
            setVerifyLogs(prev => [...prev, "✗ Verification callback failed. Check Fargate / STS logs."])
            ws.close()
            setSaveError("Verification test run failed.")
            setVerifying(false)
          }
        } catch (e) {
          // Ignore parser issues
        }
      }
      
      ws.onerror = () => {
        setVerifyLogs(prev => [...prev, "✗ WebSocket connection failed."])
        setSaveError("Failed to connect log listener stream.")
        setVerifying(false)
      }
    } catch (err: any) {
      setVerifyLogs(prev => [...prev, `✗ Deployment error: ${err.message}`])
      setSaveError(err.message)
      setVerifying(false)
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
      // Save AI setup configuration and final password
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

      setStep(5)
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
  
  // High-level AWS Den verification tracking helpers
  const hasCallbackSuccess = verifyLogs.some(l => 
    l.toLowerCase().includes("verification callback success") || 
    l.toLowerCase().includes("connection established") ||
    l.toLowerCase().includes("ready to proceed")
  );

  const hasRunnerStarted = hasCallbackSuccess || verifyLogs.some(l => 
    l.toLowerCase().includes("starting ferret") || 
    l.toLowerCase().includes("outbound runner daemon") || 
    l.toLowerCase().includes("polled") ||
    l.toLowerCase().includes("starting runner verification") ||
    l.toLowerCase().includes("[ferret-diagnostic]") ||
    l.toLowerCase().includes("runner verification completed")
  );

  const hasTriggeredRun = hasRunnerStarted || verifyLogs.some(l => 
    l.toLowerCase().includes("triggered run") || 
    l.toLowerCase().includes("fargate task spawned") ||
    l.toLowerCase().includes("provisioning aws fargate") ||
    l.toLowerCase().includes("connecting to stream logs")
  );

  const hasWgSuccess = hasTriggeredRun || verifyLogs.some(l => 
    l.toLowerCase().includes("wireguard hub deployed") || 
    l.toLowerCase().includes("gateway public ip") ||
    l.toLowerCase().includes("client tunnel is active")
  );

  const getStep1Status = () => {
    if (!verifying && verifyLogs.length === 0) return "pending";
    if (hasWgSuccess) return "success";
    return "active";
  };

  const getStep2Status = () => {
    if (!hasWgSuccess) return "pending";
    if (hasTriggeredRun) return "success";
    return "active";
  };

  const getStep3Status = () => {
    if (!hasTriggeredRun) return "pending";
    if (hasRunnerStarted) return "success";
    return "active";
  };

  const getStep4Status = () => {
    if (!hasRunnerStarted) return "pending";
    if (hasCallbackSuccess) return "success";
    return "active";
  };

  // Step indicator: Provider, Model, Den, Password, Done
  const steps = ["Provider", "Model", "Den", "Password", "Done"]

  // -------------------------------------------------------------------------
  // Layout
  // -------------------------------------------------------------------------

  return (
    // Outer: full-screen, scrollable. Content is top-aligned with fixed padding
    // so the header and step indicator never shift vertically — only the card
    // below them grows/shrinks.
    <div className="min-h-screen bg-neutral-950 flex flex-col items-center pt-4 pb-6 px-4 animate-fade-in">
      <div className={`w-full transition-all duration-300 ${(step === 1 || step === 3) ? "max-w-4xl" : "max-w-lg"}`}>

        {/* Header — mascot to the side of text — always at the same Y position */}
        <div className="flex items-center gap-3 mb-5">
          <Image src="/ferret.png" alt="Ferret" width={40} height={40} className="rounded-lg flex-shrink-0" />
          <div>
            <h1 className="text-xl font-bold text-white">Welcome to Ferret</h1>
            <p className="text-xs text-neutral-400">
              Set up your AI provider to get started
            </p>
          </div>
        </div>

        {/* Step indicator — always at the same Y position */}
        <div className="mb-4 flex items-center">
          {steps.map((label, i) => {
            const active = step === i + 1
            const done   = step > i + 1
            return (
              <div key={label} className="flex items-center flex-1 last:flex-none">
                <div className="flex flex-col items-center gap-0.5">
                  <div className={`flex h-6 w-6 items-center justify-center rounded-full text-[11px] font-bold transition-colors
                    ${done   ? "bg-brand-500 text-neutral-900"
                    : active ? "border-2 border-brand-500 text-brand-400"
                    :          "border border-neutral-700 text-neutral-600"}`}
                  >
                    {done ? "✓" : i + 1}
                  </div>
                  <span className={`text-[9px] ${active ? "text-brand-400" : done ? "text-neutral-400" : "text-neutral-600"}`}>
                    {label}
                  </span>
                </div>
                {i < steps.length - 1 && (
                  <div className={`flex-1 h-px mx-1.5 mb-3.5 ${done ? "bg-brand-500" : "bg-neutral-700"}`} />
                )}
              </div>
            )
          })}
        </div>

        {/* Card — card title and subtitle have fixed heights so the step content
            below them starts at a consistent Y position across all steps */}
        <div className="rounded-xl border border-neutral-800 bg-neutral-900 p-5 shadow-2xl">
          {/* Fixed-height card header — 2 lines reserved so content never shifts */}
          <div className="mb-4 h-[44px] flex flex-col justify-center">
            <h2 className="text-base font-semibold text-white leading-tight animate-fade-in">
              {step === 1 && `Choose & Configure ${provider.name}`}
              {step === 2 && "Choose a Default Model"}
              {step === 3 && "Configure Den (Runner Provider)"}
              {step === 4 && "Set Instance Password"}
              {step === 5 && "Setup complete"}
            </h2>
            <p className="mt-0.5 text-xs text-neutral-500 leading-tight">
              {step === 1 && (provider.local ? "Select provider on the left. No API key required for local server." : "Select provider on the left and enter credentials on the right.")}
              {step === 2 && "Used for all AI features. You can change it per-project later."}
              {step === 3 && "Select how Ferret spins up unprivileged scanning environments on-demand."}
              {step === 4 && "Protect your Ferret instance with a password. Minimum 8 characters."}
              {step === 5 && "\u00a0"}
            </p>
          </div>

          {/* ----------------------------------------------------------------
              Step 1 — Choose & Configure AI Provider
          ---------------------------------------------------------------- */}
          {step === 1 && (
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
              <div className="flex justify-between pt-4 border-t border-neutral-800">
                <button
                  type="button"
                  onClick={() => router.push("/setup/password")}
                  className="rounded-md border border-neutral-700 px-4 py-2 text-sm text-neutral-400 hover:text-white transition-colors"
                >
                  Back
                </button>
                <button
                  type="button"
                  onClick={() => setStep(2)}
                  disabled={!provider.local && !testResult?.ok}
                  className="rounded-md bg-brand-500 px-5 py-2 text-sm font-semibold text-neutral-900 hover:bg-brand-400 disabled:opacity-40 transition-colors"
                >
                  Continue
                </button>
              </div>
            </div>
          )}

          {/* ----------------------------------------------------------------
              Step 2 — Select default model
          ---------------------------------------------------------------- */}
          {step === 2 && (
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
                  onClick={() => setStep(1)}
                  className="rounded-md border border-neutral-700 px-4 py-2 text-sm text-neutral-400 hover:text-white transition-colors"
                >
                  Back
                </button>
                <button
                  type="button"
                  onClick={() => setStep(3)}
                  disabled={!model}
                  className="rounded-md bg-brand-500 px-5 py-2 text-sm font-semibold text-neutral-900 hover:bg-brand-400 disabled:opacity-40 transition-colors"
                >
                  Continue
                </button>
              </div>
            </div>
          )}

          {/* ----------------------------------------------------------------
              Step 3 — Configure Den
          ---------------------------------------------------------------- */}
          {step === 3 && (
            <div className="space-y-5 animate-fade-in">
              <div className="grid grid-cols-2 gap-3">
                <button
                  type="button"
                  onClick={() => setDenType("local")}
                  className={`flex items-center gap-3 rounded-lg border p-3 text-left transition-all w-full
                    ${denType === "local"
                      ? "border-brand-500 bg-brand-500/10 text-white"
                      : "border-neutral-700 bg-neutral-800/50 text-neutral-300 hover:border-neutral-500 hover:bg-neutral-800"
                    }`}
                >
                  <Image src="/providers/docker.svg" alt="Local Den" width={28} height={28} className="flex-shrink-0" />
                  <div className="min-w-0">
                    <span className="block text-sm font-semibold text-white leading-tight">Local Den</span>
                    <span className="block text-[10px] text-neutral-500 leading-normal mt-0.5">Runs tasks directly on your local sandbox (Default)</span>
                  </div>
                </button>

                <button
                  type="button"
                  onClick={() => setDenType("aws")}
                  className={`flex items-center gap-3 rounded-lg border p-3 text-left transition-all w-full
                    ${denType === "aws"
                      ? "border-brand-500 bg-brand-500/10 text-white"
                      : "border-neutral-700 bg-neutral-800/50 text-neutral-300 hover:border-neutral-500 hover:bg-neutral-800"
                    }`}
                >
                  <Image src="/providers/aws.svg" alt="AWS Fargate Den" width={28} height={28} className="flex-shrink-0" />
                  <div className="min-w-0">
                    <span className="block text-sm font-semibold text-white leading-tight">AWS Fargate Den</span>
                    <span className="block text-[10px] text-neutral-500 leading-normal mt-0.5">Dynamically spins up unprivileged cloud-native tasks</span>
                  </div>
                </button>
              </div>

              {denType === "local" ? (
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
                      onClick={() => setStep(2)}
                      className="rounded-md border border-neutral-700 px-4 py-2 text-sm text-neutral-400 hover:text-white transition-colors"
                    >
                      Back
                    </button>
                    <button
                      type="button"
                      onClick={async () => {
                        const ok = await saveDenConfig()
                        if (ok) setStep(4)
                      }}
                      disabled={saving}
                      className="rounded-md bg-brand-500 px-5 py-2 text-sm font-semibold text-neutral-900 hover:bg-brand-400 disabled:opacity-40 transition-colors"
                    >
                      {saving ? "Saving..." : "Continue"}
                    </button>
                  </div>
                </div>
              ) : (
                <div className="space-y-5">
                  <div className="flex flex-col md:flex-row gap-6 border-t border-neutral-800 pt-4">
                    {/* Left Column: Form Settings */}
                    <div className="flex-1 space-y-4">
                      <p className="text-[10px] font-semibold uppercase tracking-widest text-neutral-500">AWS Credentials</p>
                      
                      <div className="space-y-2">
                        <label className="block text-xs font-semibold text-neutral-300">AWS Access Key ID</label>
                        <input
                          type="text"
                          value={denAwsKey}
                          onChange={e => setDenAwsKey(e.target.value)}
                          placeholder="AKIAIOSFODNN7EXAMPLE"
                          className="w-full rounded-md border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm text-white placeholder-neutral-600 focus:border-brand-500 focus:outline-none"
                        />
                      </div>
                      <div className="space-y-2">
                        <label className="block text-xs font-semibold text-neutral-300">AWS Secret Access Key</label>
                        <input
                          type="password"
                          value={denAwsSecret}
                          onChange={e => setDenAwsSecret(e.target.value)}
                          placeholder="wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY"
                          className="w-full rounded-md border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm text-white placeholder-neutral-600 focus:border-brand-500 focus:outline-none"
                        />
                      </div>
                      <div className="grid grid-cols-2 gap-4">
                        <div className="space-y-2">
                          <label className="block text-xs font-semibold text-neutral-300">AWS Region</label>
                          <input
                            type="text"
                            value={denAwsRegion}
                            onChange={e => setDenAwsRegion(e.target.value)}
                            placeholder="eu-west-1"
                            className="w-full rounded-md border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm text-white placeholder-neutral-600 focus:border-brand-500 focus:outline-none"
                          />
                        </div>
                        <div className="space-y-2">
                          <label className="block text-xs font-semibold text-neutral-300">Max Runners</label>
                          <input
                            type="number"
                            value={denMaxRunners}
                            onChange={e => setDenMaxRunners(Math.max(1, parseInt(e.target.value) || 1))}
                            className="w-full rounded-md border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm text-white placeholder-neutral-600 focus:border-brand-500 focus:outline-none"
                          />
                        </div>
                      </div>
                      <p className="text-[10px] text-neutral-500 leading-normal">
                        Caps active cloud task counts concurrently to manage AWS compute budgets.
                      </p>
                    </div>

                    {/* Right Column: Verification & Checklist */}
                    <div className="flex-1 border-t md:border-t-0 md:border-l border-neutral-800 pt-6 md:pt-0 md:pl-6 space-y-4">
                      <p className="text-[10px] font-semibold uppercase tracking-widest text-neutral-500">Verification Progress</p>
                      
                      {checkingExisting ? (
                        <div className="flex flex-col items-center justify-center py-12 text-center space-y-3">
                          <Loader2 className="w-8 h-8 text-brand-500 animate-spin" />
                          <p className="text-xs font-semibold text-neutral-300">Checking for existing Fargate infrastructure...</p>
                          <p className="text-[10px] text-neutral-500">Checking EC2 instance status and local WireGuard tunnel</p>
                        </div>
                      ) : existingSetup && existingSetup.exists && existingSetup.working ? (
                        <div className="p-4 rounded-lg border border-brand-500/20 bg-brand-950/20 text-left space-y-3">
                          <div className="flex items-center gap-2 text-brand-400">
                            <Check className="h-4 w-4 text-brand-400 animate-bounce-slow" />
                            <span className="font-semibold text-xs uppercase tracking-wider">Active Setup Found</span>
                          </div>
                          <p className="text-xs text-neutral-300 leading-normal">
                            We detected a running WireGuard VM (<code className="text-xs bg-neutral-900 px-1 py-0.5 rounded text-white">{existingSetup.instance_id}</code>) with an active secure tunnel connection.
                          </p>
                          <p className="text-[10px] text-neutral-500">
                            You can reuse this existing infrastructure safely to avoid duplicate AWS resource charges.
                          </p>
                          <div className="flex gap-2 pt-2">
                            <button
                              type="button"
                              onClick={() => {
                                setVerified(true);
                                setStep(4);
                              }}
                              className="flex-1 py-2 px-3 text-xs bg-brand-500 hover:bg-brand-400 text-neutral-900 rounded font-semibold transition-colors"
                            >
                              Reuse Setup (Recommended)
                            </button>
                            <button
                              type="button"
                              onClick={() => verifyAwsDen(true)}
                              className="py-2 px-3 text-xs bg-neutral-800 hover:bg-neutral-700 text-neutral-300 rounded font-semibold transition-colors"
                            >
                              Deploy Fresh VM
                            </button>
                          </div>
                        </div>
                      ) : (
                        <>
                          {/* Interactive checklist block */}
                          <div className="space-y-4">
                            {/* High-level Step 1 */}
                            <div className={`flex items-start gap-3 transition-opacity duration-200 ${getStep1Status() === "pending" ? "opacity-35" : "opacity-100"}`}>
                              <div className="flex h-5 w-5 items-center justify-center flex-shrink-0">
                                {getStep1Status() === "success" ? (
                                  <div className="flex h-5 w-5 items-center justify-center rounded-full bg-green-500/10 border border-green-500 text-green-400">
                                    <Check className="w-3 h-3" />
                                  </div>
                                ) : getStep1Status() === "active" ? (
                                  <Loader2 className="w-4 h-4 text-brand-500 animate-spin" />
                                ) : (
                                  <div className="flex h-5 w-5 items-center justify-center rounded-full border border-neutral-700 text-[10px] font-bold text-neutral-500">
                                    1
                                  </div>
                                )}
                              </div>
                              <div className="space-y-0.5">
                                <p className={`text-xs font-semibold ${getStep1Status() === "active" ? "text-brand-400" : "text-neutral-200"}`}>Deploy WireGuard EC2 VPN Hub</p>
                                <p className="text-[10px] text-neutral-500 leading-tight">Provisioning gateway instance and tunnel interface</p>
                              </div>
                            </div>

                            {/* High-level Step 2 */}
                            <div className={`flex items-start gap-3 transition-opacity duration-200 ${getStep2Status() === "pending" ? "opacity-35" : "opacity-100"}`}>
                              <div className="flex h-5 w-5 items-center justify-center flex-shrink-0">
                                {getStep2Status() === "success" ? (
                                  <div className="flex h-5 w-5 items-center justify-center rounded-full bg-green-500/10 border border-green-500 text-green-400">
                                    <Check className="w-3 h-3" />
                                  </div>
                                ) : getStep2Status() === "active" ? (
                                  <Loader2 className="w-4 h-4 text-brand-500 animate-spin" />
                                ) : (
                                  <div className="flex h-5 w-5 items-center justify-center rounded-full border border-neutral-700 text-[10px] font-bold text-neutral-500">
                                    2
                                  </div>
                                )}
                              </div>
                              <div className="space-y-0.5">
                                <p className={`text-xs font-semibold ${getStep2Status() === "active" ? "text-brand-400" : "text-neutral-200"}`}>Configure Network Security & Roles</p>
                                <p className="text-[10px] text-neutral-500 leading-tight">Setting up secure outbound runner isolation policies</p>
                              </div>
                            </div>

                            {/* High-level Step 3 */}
                            <div className={`flex items-start gap-3 transition-opacity duration-200 ${getStep3Status() === "pending" ? "opacity-35" : "opacity-100"}`}>
                              <div className="flex h-5 w-5 items-center justify-center flex-shrink-0">
                                {getStep3Status() === "success" ? (
                                  <div className="flex h-5 w-5 items-center justify-center rounded-full bg-green-500/10 border border-green-500 text-green-400">
                                    <Check className="w-3 h-3" />
                                  </div>
                                ) : getStep3Status() === "active" ? (
                                  <Loader2 className="w-4 h-4 text-brand-500 animate-spin" />
                                ) : (
                                  <div className="flex h-5 w-5 items-center justify-center rounded-full border border-neutral-700 text-[10px] font-bold text-neutral-500">
                                    3
                                  </div>
                                )}
                              </div>
                              <div className="space-y-0.5">
                                <p className={`text-xs font-semibold ${getStep3Status() === "active" ? "text-brand-400" : "text-neutral-200"}`}>Launch Serverless Fargate Task</p>
                                <p className="text-[10px] text-neutral-500 leading-tight">Spawning runner container client task on ECS</p>
                              </div>
                            </div>

                            {/* High-level Step 4 */}
                            <div className={`flex items-start gap-3 transition-opacity duration-200 ${getStep4Status() === "pending" ? "opacity-35" : "opacity-100"}`}>
                              <div className="flex h-5 w-5 items-center justify-center flex-shrink-0">
                                {getStep4Status() === "success" ? (
                                  <div className="flex h-5 w-5 items-center justify-center rounded-full bg-green-500/10 border border-green-500 text-green-400">
                                    <Check className="w-3 h-3" />
                                  </div>
                                ) : getStep4Status() === "active" ? (
                                  <Loader2 className="w-4 h-4 text-brand-500 animate-spin" />
                                ) : (
                                  <div className="flex h-5 w-5 items-center justify-center rounded-full border border-neutral-700 text-[10px] font-bold text-neutral-500">
                                    4
                                  </div>
                                )}
                              </div>
                              <div className="space-y-0.5">
                                <p className={`text-xs font-semibold ${getStep4Status() === "active" ? "text-brand-400" : "text-neutral-200"}`}>Verify Tunnel Connection Callback</p>
                                <p className="text-[10px] text-neutral-500 leading-tight">Awaiting runner daemon polling handshake via VPN</p>
                              </div>
                            </div>
                          </div>

                          {/* Trigger button for raw logs popup modal */}
                          {(verifying || verifyLogs.length > 0) && (
                            <div className="border-t border-neutral-800 pt-3 flex items-center justify-between">
                              <span className="text-[11px] text-neutral-500 font-medium">Deployment & runner logs</span>
                              <button
                                type="button"
                                onClick={() => setShowLogsModal(true)}
                                className="rounded border border-neutral-700 bg-neutral-800/40 px-2.5 py-1 text-[11px] font-medium text-neutral-300 hover:border-neutral-500 hover:text-white transition-colors"
                              >
                                View Logs ({verifyLogs.length})
                              </button>
                            </div>
                          )}
                        </>
                      )}
                    </div>
                  </div>

                  {saveError && (
                    <p className="rounded-md border border-red-800 bg-red-900/30 px-3 py-2 text-xs text-red-400 mt-4">
                      {saveError}
                    </p>
                  )}

                  <div className="flex justify-between pt-4 border-t border-neutral-800 mt-4">
                    <button
                      type="button"
                      onClick={() => setStep(2)}
                      disabled={verifying}
                      className="rounded-md border border-neutral-700 px-4 py-2 text-sm text-neutral-400 hover:text-white transition-colors disabled:opacity-40"
                    >
                      Back
                    </button>
                    {verified ? (
                      <button
                        type="button"
                        onClick={() => setStep(4)}
                        className="rounded-md bg-brand-500 px-5 py-2 text-sm font-semibold text-neutral-900 hover:bg-brand-400 transition-colors animate-pulse"
                      >
                        Continue to Password
                      </button>
                    ) : (
                      <button
                        type="button"
                        onClick={verifyAwsDen}
                        disabled={saving || verifying}
                        className="rounded-md bg-brand-500 px-5 py-2 text-sm font-semibold text-neutral-900 hover:bg-brand-400 disabled:opacity-40 transition-colors"
                      >
                        {verifying ? "Verifying..." : "Verify AWS Den"}
                      </button>
                    )}
                  </div>
                </div>
              )}
            </div>
          )}

          {/* ----------------------------------------------------------------
              Step 4 — Set Instance Password
          ---------------------------------------------------------------- */}
          {step === 4 && (
            <form className="space-y-4 animate-fade-in" autoComplete="on" onSubmit={e => { e.preventDefault(); saveFinalSetup(); }}>
              {/* Password */}
              <div className="space-y-1.5">
                <label className="block text-xs font-medium text-neutral-300">Password</label>
                <div className="relative">
                  <input
                    type={showPw ? "text" : "password"}
                    value={password}
                    onChange={e => setPassword(e.target.value)}
                    placeholder="Min. 8 characters"
                    autoComplete="new-password"
                    className="w-full bg-neutral-900 border border-neutral-700 rounded-lg px-3 py-2
                               text-neutral-100 text-sm placeholder-neutral-600
                               focus:outline-none focus:ring-1 focus:ring-brand-500 focus:border-brand-500"
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
                    placeholder="Re-enter password"
                    autoComplete="new-password"
                    className="w-full bg-neutral-900 border border-neutral-700 rounded-lg px-3 py-2
                               text-neutral-100 text-sm placeholder-neutral-600
                               focus:outline-none focus:ring-1 focus:ring-brand-500 focus:border-brand-500"
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

              {saveError && (
                <p className="text-red-400 text-xs bg-red-950/40 border border-red-900/50 rounded-lg px-3 py-2">
                  {saveError}
                </p>
              )}

              <div className="flex justify-between pt-2 border-t border-neutral-800">
                <button
                  type="button"
                  onClick={() => setStep(3)}
                  disabled={saving}
                  className="rounded-md border border-neutral-700 px-4 py-2 text-sm text-neutral-400 hover:text-white transition-colors disabled:opacity-40"
                >
                  Back
                </button>
                <button
                  type="submit"
                  disabled={saving || !password || !confirmPassword}
                  className="rounded-md bg-brand-500 px-5 py-2 text-sm font-semibold text-neutral-900 hover:bg-brand-400 disabled:opacity-40 transition-colors"
                >
                  {saving ? "Completing setup..." : "Finish Setup"}
                </button>
              </div>
            </form>
          )}

          {/* ----------------------------------------------------------------
              Step 5 — Done
          ---------------------------------------------------------------- */}
          {step === 5 && (
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
              <div className="rounded-lg border border-neutral-700 bg-neutral-800/50 divide-y divide-neutral-700 text-sm w-full max-w-xs">
                <div className="flex justify-between px-4 py-2.5">
                  <span className="text-neutral-400">Provider</span>
                  <span className="text-white font-medium">{provider.name}</span>
                </div>
                <div className="flex justify-between px-4 py-2.5">
                  <span className="text-neutral-400">Model</span>
                  <span className="text-white font-medium">{model}</span>
                </div>
                <div className="flex justify-between px-4 py-2.5">
                  <span className="text-neutral-400">Den Type</span>
                  <span className="text-white font-medium capitalize">{denType}</span>
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
                className="rounded-md bg-brand-500 px-6 py-2.5 text-sm font-semibold text-neutral-900 hover:bg-brand-400 transition-colors"
              >
                Sign in to Ferret
              </button>
            </div>
          )}
        </div>
      </div>

      {/* Footer — pinned to bottom of viewport */}
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

      {showLogsModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          {/* Backdrop */}
          <div 
            className="fixed inset-0 bg-black/70 backdrop-blur-sm cursor-pointer" 
            onClick={() => setShowLogsModal(false)}
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
                onClick={() => setShowLogsModal(false)}
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
                  onClick={() => setShowLogsModal(false)}
                  className="rounded bg-brand-500 px-4 py-1.5 text-xs font-semibold text-neutral-900 hover:bg-brand-400 transition-colors"
                >
                  Dismiss
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
