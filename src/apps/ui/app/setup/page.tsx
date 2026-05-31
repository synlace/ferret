"use client"

import { apiFetch } from "@/lib/api-fetch"

import { useState, useCallback, useEffect } from "react"
import Image from "next/image"
import { useRouter } from "next/navigation"
import { FileJson } from "lucide-react"

import { PROVIDERS, Provider } from "./providers"
import ImportBackupModal from "./ImportBackupModal"
import LogsModal from "./LogsModal"
import Step1Provider from "./Step1Provider"
import Step2Model from "./Step2Model"
import Step3Den from "./Step3Den"
import Step4Password from "./Step4Password"

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000"

export default function SetupPage() {
  const router = useRouter()

  // Step 1 = provider, 2 = configure, 3 = model, 4 = den, 5 = done
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

  // Den State Variables
  const [denType, setDenTypeState] = useState<"local" | "aws">((() => {
    if (typeof window !== "undefined") {
      const saved = sessionStorage.getItem("ferret:setup:denType")
      if (saved === "local" || saved === "aws") return saved as any
    }
    return "local"
  }))
  const [denMaxRunners, setDenMaxRunners] = useState<number>(10)
  const [denAwsKey, setDenAwsKey] = useState("")
  const [denAwsSecret, setDenAwsSecret] = useState("")
  const [denAwsRegion, setDenAwsRegion] = useState("eu-west-1")
  const [denRunnerImage, setDenRunnerImage] = useState("")
  const [denWarmRunners, setDenWarmRunners] = useState<number>(0)
  const [denKillIfUnreachable, setDenKillIfUnreachable] = useState<boolean>(true)
  
  const [verified, setVerifiedState] = useState<boolean>(() => {
    if (typeof window !== "undefined") {
      const saved = sessionStorage.getItem("ferret:setup:verified")
      if (saved) return saved === "true"
    }
    return false
  })
  const [checkingExisting, setCheckingExisting] = useState(false)
  const [existingSetup, setExistingSetupState] = useState<{
    exists: boolean
    working: boolean
    instance_id?: string
    public_ip?: string
    detail?: string
  } | null>(() => {
    if (typeof window !== "undefined") {
      const saved = sessionStorage.getItem("ferret:setup:existingSetup")
      if (saved) return JSON.parse(saved)
    }
    return null
  })
  
  // Verification Callback States
  const [verifying, setVerifyingState] = useState<boolean>(() => {
    if (typeof window !== "undefined") {
      const saved = sessionStorage.getItem("ferret:setup:verifying")
      if (saved) return saved === "true"
    }
    return false
  })
  const [verifyLogs, setVerifyLogsState] = useState<string[]>(() => {
    if (typeof window !== "undefined") {
      const saved = sessionStorage.getItem("ferret:setup:verifyLogs")
      if (saved) return JSON.parse(saved)
    }
    return []
  })
  const [, setWsInstance] = useState<WebSocket | null>(null)
  const [showLogsModal, setShowLogsModal] = useState(false)
  const [hasAutoChecked, setHasAutoChecked] = useState(false)
  const [activeRunId, setActiveRunIdState] = useState<string | null>(() => {
    if (typeof window !== "undefined") {
      const saved = sessionStorage.getItem("ferret:setup:activeRunId")
      if (saved) return saved
    }
    return null
  })
  const [corrupted, setCorruptedState] = useState(false)

  // Helper to save setup progress to database settings table
  const saveProgressToDb = async (patch: {
    step?: number
    den_type?: string
    verified?: boolean
    verifying?: boolean
    verify_logs?: string[]
    active_run_id?: string | null
    corrupted?: boolean
  }) => {
    try {
      await apiFetch(`${API_BASE}/api/setup/progress`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch)
      })
    } catch (e) {
      console.error("Failed to save progress to DB:", e)
    }
  }

  // Wrapper setters to sync state to sessionStorage and DB settings table
  const setStep = (s: 1 | 2 | 3 | 4 | 5) => {
    setStepState(s)
    if (typeof window !== "undefined") {
      sessionStorage.setItem("ferret:setup:step", String(s))
    }
    saveProgressToDb({ step: s })
  }

  const setDenType = (type: "local" | "aws") => {
    setDenTypeState(type)
    if (typeof window !== "undefined") {
      sessionStorage.setItem("ferret:setup:denType", type)
    }
    saveProgressToDb({ den_type: type })
  }

  const setVerified = (v: boolean) => {
    setVerifiedState(v)
    if (typeof window !== "undefined") {
      sessionStorage.setItem("ferret:setup:verified", String(v))
    }
    saveProgressToDb({ verified: v })
  }

  const setVerifying = (v: boolean) => {
    setVerifyingState(v)
    if (typeof window !== "undefined") {
      sessionStorage.setItem("ferret:setup:verifying", String(v))
    }
    saveProgressToDb({ verifying: v })
  }

  const setVerifyLogs = (logs: string[] | ((prev: string[]) => string[])) => {
    if (typeof logs === "function") {
      setVerifyLogsState(prev => {
        const next = logs(prev)
        if (typeof window !== "undefined") {
          sessionStorage.setItem("ferret:setup:verifyLogs", JSON.stringify(next))
        }
        saveProgressToDb({ verify_logs: next })
        return next
      })
    } else {
      setVerifyLogsState(logs)
      if (typeof window !== "undefined") {
        sessionStorage.setItem("ferret:setup:verifyLogs", JSON.stringify(logs))
      }
      saveProgressToDb({ verify_logs: logs })
    }
  }

  const setExistingSetup = (setup: any) => {
    setExistingSetupState(setup)
    if (typeof window !== "undefined") {
      if (setup) {
        sessionStorage.setItem("ferret:setup:existingSetup", JSON.stringify(setup))
      } else {
        sessionStorage.removeItem("ferret:setup:existingSetup")
      }
    }
  }

  const setActiveRunId = (runId: string | null) => {
    setActiveRunIdState(runId)
    if (typeof window !== "undefined") {
      if (runId) {
        sessionStorage.setItem("ferret:setup:activeRunId", runId)
      } else {
        sessionStorage.removeItem("ferret:setup:activeRunId")
      }
    }
    saveProgressToDb({ active_run_id: runId ?? "" })
  }

  const setCorrupted = (c: boolean) => {
    setCorruptedState(c)
    saveProgressToDb({ corrupted: c })
  }

  // Clear setup storage on successful complete
  const clearSetupStorage = () => {
    if (typeof window !== "undefined") {
      sessionStorage.removeItem("ferret:setup:step")
      sessionStorage.removeItem("ferret:setup:denType")
      sessionStorage.removeItem("ferret:setup:verified")
      sessionStorage.removeItem("ferret:setup:verifying")
      sessionStorage.removeItem("ferret:setup:verifyLogs")
      sessionStorage.removeItem("ferret:setup:existingSetup")
      sessionStorage.removeItem("ferret:setup:activeRunId")
    }
    apiFetch(`${API_BASE}/api/setup/progress`, {
      method: "DELETE"
    }).catch(() => {})
  }

  useEffect(() => {
    setReady(true)

    // Load any saved setup progress from database table
    apiFetch(`${API_BASE}/api/setup/progress`)
      .then(r => r.ok ? r.json() : null)
      .then(p => {
        if (p) {
          if (p.step) setStepState(p.step)
          if (p.den_type === "local" || p.den_type === "aws") setDenTypeState(p.den_type)
          if (p.verified !== null) setVerifiedState(p.verified)
          if (p.verifying !== null) setVerifyingState(p.verifying)
          if (p.verify_logs) setVerifyLogsState(p.verify_logs)
          if (p.active_run_id) setActiveRunIdState(p.active_run_id)
          if (p.corrupted !== null) setCorruptedState(p.corrupted)
        }
      })
      .catch(() => {})

    // Check if there is pre-existing configuration from a restored backup
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

    // Check for Den configuration from the restored backup
    apiFetch(`${API_BASE}/api/settings/dens`)
      .then(r => r.ok ? r.json() : [])
      .then(dens => {
        if (Array.isArray(dens) && dens.length > 0) {
          // Look for an imported 'aws' den or fall back to the first available
          const awsDen = dens.find(d => d.den_type === "aws")
          const activeDen = awsDen || dens[0]
          
          if (activeDen) {
            setDenType(activeDen.den_type)
            setDenMaxRunners(activeDen.den_max_runners || 10)
            if (activeDen.den_aws_access_key) {
              setDenAwsKey(activeDen.den_aws_access_key)
            }
            if (activeDen.den_aws_secret_key && activeDen.den_aws_secret_key !== "••••••••" && activeDen.den_aws_secret_key !== "") {
              setDenAwsSecret(activeDen.den_aws_secret_key)
            }
            if (activeDen.den_aws_region) {
              setDenAwsRegion(activeDen.den_aws_region)
            }
            if (activeDen.den_runner_image) {
              setDenRunnerImage(activeDen.den_runner_image)
            }
            if (activeDen.den_warm_runners) {
              setDenWarmRunners(activeDen.den_warm_runners)
            }
            if (activeDen.den_kill_if_unreachable !== undefined) {
              setDenKillIfUnreachable(activeDen.den_kill_if_unreachable)
            }
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

  useEffect(() => {
    if (step === 3 && denType === "aws" && !hasAutoChecked && !verifying && denAwsKey && denAwsSecret) {
      setHasAutoChecked(true)
      setCheckingExisting(true)
      setVerifyLogs(["[Setup] Restored credentials detected. Synchronizing settings to backend..."])

      // 1. Sync restored Den credentials to database
      apiFetch(`${API_BASE}/api/settings/dens`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: "aws",
          name: "Primary Fargate Den",
          den_type: "aws",
          den_max_runners: denMaxRunners,
          den_aws_access_key: denAwsKey,
          den_aws_secret_key: denAwsSecret,
          den_aws_region: denAwsRegion || "eu-west-1",
          den_runner_image: denRunnerImage || undefined,
          den_warm_runners: denWarmRunners,
          den_kill_if_unreachable: denKillIfUnreachable
        }),
      })
        .then(res => {
          if (!res.ok) {
            throw new Error("Failed to save restored Den configuration");
          }
          setVerifyLogs(prev => [...prev, "[Setup] Settings synchronized successfully. Probing AWS for existing Fargate infrastructure..."])
          
          // 2. Perform the liveness check
          return apiFetch(`${API_BASE}/api/settings/dens/check-existing`, {
            method: "POST"
          })
        })
        .then(r => r && r.ok ? r.json() : null)
        .then(checkData => {
          if (checkData) {
            setExistingSetup(checkData)
            if (checkData.exists && checkData.working) {
              setVerified(true)
              setVerifyLogs(prev => [
                ...prev,
                `[Setup] ✓ Found working running instance: ${checkData.instance_id} (${checkData.public_ip})`,
                `[Setup] ✓ Tunnel is already working and connected.`
              ])
            } else if (checkData.exists && !checkData.working) {
              setVerifyLogs(prev => [
                ...prev,
                `[Setup] ⚠ Found existing VM (${checkData.instance_id}) but local client tunnel is offline/misconfigured.`,
                `[Setup] Click "Verify AWS Den" to sync settings and restore the connection.`
              ])
            } else {
              setVerifyLogs(prev => [
                ...prev,
                `[Setup] No existing Fargate VM found. Click "Verify AWS Den" to deploy new infrastructure.`
              ])
            }
          }
        })
        .catch((err) => {
          setVerifyLogs(prev => [...prev, `[Setup] ⚠ Sync / probe warning: ${err instanceof Error ? err.message : String(err)}`])
        })
        .finally(() => {
          setCheckingExisting(false)
        })
    }
  }, [step, denType, hasAutoChecked, verifying, denAwsKey, denAwsSecret, denMaxRunners, denAwsRegion, denRunnerImage, denWarmRunners, denKillIfUnreachable])

  // Reset auto-check trigger whenever leaving the Den step
  useEffect(() => {
    if (step !== 3) {
      setHasAutoChecked(false)
    }
  }, [step])

  // Reconnect active verification log stream if page was reloaded or navigated back
  useEffect(() => {
    if (!ready || !verifying || !activeRunId) return

    let isMounted = true
    let isUnloading = false

    const handleBeforeUnload = () => {
      isUnloading = true
    }
    if (typeof window !== "undefined") {
      window.addEventListener("beforeunload", handleBeforeUnload)
    }

    const wsProto = window.location.protocol === "https:" ? "wss:" : "ws:"
    const apiHost = API_BASE.replace(/^https?:\/\//, "")
    const wsUrl = `${wsProto}//${apiHost}/api/runs/${activeRunId}/ws`

    const ws = new WebSocket(wsUrl)
    setWsInstance(ws)

    ws.onmessage = (event) => {
      if (!isMounted || isUnloading) return
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
          setActiveRunId(null)
          setCorrupted(false)
        } else if (msg.status === "error") {
          setVerifyLogs(prev => [...prev, "✗ Verification callback failed. Check Fargate / STS logs."])
          ws.close()
          setSaveError("Verification test run failed.")
          setCorrupted(true) // Mark deployment corrupted on test run failure
          setVerifying(false)
          setActiveRunId(null)
        }
      } catch (e) {
        // Ignore parser issues
      }
    }

    ws.onerror = () => {
      if (!isMounted || isUnloading) return
      setVerifyLogs(prev => [...prev, "✗ WebSocket connection failed. API may have restarted/failed."])
      setSaveError("Failed to connect log listener stream.")
      setCorrupted(true) // API went down/restarted mid-deploy
      setVerifying(false)
      setActiveRunId(null)
      ws.close()
    }

    ws.onclose = (event) => {
      if (!isMounted || isUnloading || event.code === 1001) return
      setWsInstance(prev => {
        if (prev === ws) {
          if (verifying) {
            setCorrupted(true)
            setVerifying(false)
          }
          setActiveRunId(null)
        }
        return prev
      })
    }

    return () => {
      isMounted = false
      if (typeof window !== "undefined") {
        window.removeEventListener("beforeunload", handleBeforeUnload)
      }
      ws.close()
    }
  }, [ready, verifying, activeRunId])

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
          den_aws_region: denAwsRegion || "eu-west-1",
          den_runner_image: denRunnerImage || undefined,
          den_warm_runners: denWarmRunners,
          den_kill_if_unreachable: denKillIfUnreachable
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
    setCorrupted(false)
    setVerifyLogs(["[Setup] Deploying persistent EC2 WireGuard Hub on AWS..."])
    
    try {
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
      
      setVerifyLogs(prev => [...prev, `[Verification] Triggered Run ${runId}. Connecting to stream logs...`])
      setActiveRunId(runId)
    } catch (err: any) {
      setVerifyLogs(prev => [...prev, `✗ Deployment error: ${err.message}`])
      setSaveError(err.message)
      setVerifying(false)
      setActiveRunId(null)
    }
  }

  async function teardownAwsDen() {
    setVerifying(true)
    setSaveError("")
    setVerifyLogs(prev => [...prev, "[Teardown] Initiating AWS resource teardown (Terraform Destroy)..."])
    try {
      const res = await apiFetch(`${API_BASE}/api/settings/dens/teardown-wg`, {
        method: "POST"
      })
      if (!res.ok) {
        const err = await res.json()
        throw new Error(err.detail ?? "Teardown failed")
      }
      setVerifyLogs(prev => [...prev, "[Teardown] ✓ AWS resources destroyed successfully.", "[Setup] Launching fresh deployment..."])
      setCorrupted(false)
      setVerified(false)
      setExistingSetup(null)
      // Call verifyAwsDen to start fresh
      await verifyAwsDen(true)
    } catch (err: any) {
      setVerifyLogs(prev => [...prev, `✗ Teardown error: ${err.message}`])
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

        {/* Header & Step indicator */}
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

          {/* Step indicator */}
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
          {/* Step 1 */}
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

          {/* Step 2 */}
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

          {/* Step 3 */}
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
                  Select how Ferret spins up unprivileged scanning environments on-demand.
                </p>
              </div>
              <Step3Den
                denType={denType}
                setDenType={setDenType}
                denMaxRunners={denMaxRunners}
                setDenMaxRunners={setDenMaxRunners}
                denAwsKey={denAwsKey}
                setDenAwsKey={setDenAwsKey}
                denAwsSecret={denAwsSecret}
                setDenAwsSecret={setDenAwsSecret}
                denAwsRegion={denAwsRegion}
                setDenAwsRegion={setDenAwsRegion}
                denRunnerImage={denRunnerImage}
                setDenRunnerImage={setDenRunnerImage}
                denWarmRunners={denWarmRunners}
                setDenWarmRunners={setDenWarmRunners}
                denKillIfUnreachable={denKillIfUnreachable}
                setDenKillIfUnreachable={setDenKillIfUnreachable}
                saving={saving}
                verifying={verifying}
                checkingExisting={checkingExisting}
                existingSetup={existingSetup}
                setVerified={setVerified}
                verified={verified}
                corrupted={corrupted}
                teardownAwsDen={teardownAwsDen}
                saveError={saveError}
                verifyLogs={verifyLogs}
                setShowLogsModal={setShowLogsModal}
                verifyAwsDen={verifyAwsDen}
                saveDenConfig={saveDenConfig}
                onBack={() => setStep(2)}
                onContinue={() => setStep(4)}
              />
            </div>
          </div>

          {/* Step 4 */}
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

          {/* Step 5 */}
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
                  className="rounded-md bg-brand-500 px-6 py-2.5 text-sm font-semibold text-neutral-900 hover:bg-brand-400 transition-colors mx-auto"
                >
                  Sign in to Ferret
                </button>
              </div>
            </div>
          </div>
        </div>

        {/* Import existing backup profile button */}
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

      {/* Footer */}
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

      <LogsModal
        isOpen={showLogsModal}
        onClose={() => setShowLogsModal(false)}
        verifying={verifying}
        verifyLogs={verifyLogs}
      />

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
