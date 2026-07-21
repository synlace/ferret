"use client"

import { apiFetch } from "@/lib/api-fetch"
import React, { useState, useEffect, useCallback, useRef } from "react"
import Link from "next/link"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  ShieldCheck,
  Download,
  CheckCircle,
  AlertCircle,
  Loader2,
  Cpu,
  Activity,
  KeyRound,
  ShieldAlert,
  X,
  Upload,
  ChevronRight,
} from "lucide-react"

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000"

const LIST_WIDTH_KEY = "ferret_settings_list_width"
const DEFAULT_LIST_WIDTH = 240
const MIN_LIST_WIDTH = 160
const MAX_LIST_WIDTH = 400

interface ProxyStatus {
  running: boolean
  uptime: number
  listen_address: string
  intercepted: number
}

type SettingsSection = "ca-cert" | "security" | "ai-proxy" | "den" | "backup"

// ---------------------------------------------------------------------------
// MFA Setup Modal
// ---------------------------------------------------------------------------
function MfaSetupModal({
  onClose,
  onEnabled,
}: {
  onClose: () => void
  onEnabled: () => void
}) {
  const [step, setStep] = useState<"loading" | "qr" | "verify" | "done">("loading")
  const [secret, setSecret] = useState("")
  const [qrB64, setQrB64] = useState("")
  const [otpauthUri, setOtpauthUri] = useState("")
  const [code, setCode] = useState("")
  const [error, setError] = useState("")
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    const setup = async () => {
      try {
        const res = await apiFetch(`${API_BASE}/api/auth/mfa/setup`, { method: "POST" })
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const data = await res.json()
        setSecret(data.secret)
        setQrB64(data.qr_png_b64)
        setOtpauthUri(data.otpauth_uri)
        setStep("qr")
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to generate QR code")
        setStep("qr")
      }
    }
    setup()
  }, [])

  const handleVerify = async (e: React.FormEvent) => {
    e.preventDefault()
    if (code.length !== 6) return
    setLoading(true)
    setError("")
    try {
      const res = await apiFetch(`${API_BASE}/api/auth/mfa/verify-setup`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code }),
      })
      if (!res.ok) {
        const body = await res.json().catch(() => ({ detail: "Invalid code" }))
        throw new Error(body.detail ?? "Invalid code")
      }
      setStep("done")
      onEnabled()
    } catch (err) {
      setError(err instanceof Error ? err.message : "Verification failed")
      setCode("")
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4">
      <div className="bg-neutral-900 border border-neutral-700 rounded-xl shadow-2xl w-full max-w-sm">
        <div className="flex items-center justify-between px-4 py-3 border-b border-neutral-800">
          <div className="flex items-center gap-2">
            <ShieldCheck className="w-4 h-4 text-brand-400" />
            <span className="text-sm font-semibold text-white">Set up two-factor authentication</span>
          </div>
          <button onClick={onClose} className="text-neutral-500 hover:text-neutral-300 transition-colors">
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="p-4 space-y-4">
          {step === "loading" && (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="w-6 h-6 text-brand-400 animate-spin" />
            </div>
          )}

          {step === "qr" && (
            <>
              <p className="text-xs text-neutral-400">
                Scan this QR code with your authenticator app (Google Authenticator, Authy, etc.), then enter the 6-digit code to confirm.
              </p>

              {qrB64 ? (
                <div className="flex justify-center">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={`data:image/png;base64,${qrB64}`}
                    alt="TOTP QR code"
                    width={180}
                    height={180}
                    className="rounded border border-neutral-700 bg-white p-1"
                  />
                </div>
              ) : error ? (
                <div className="flex items-start gap-2 bg-red-900/20 border border-red-800 text-red-300 px-3 py-2 text-xs">
                  <AlertCircle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
                  <span>{error}</span>
                </div>
              ) : null}

              {secret && (
                <div className="space-y-1">
                  <p className="text-[10px] text-neutral-500 uppercase tracking-wider font-semibold">Manual entry key</p>
                  <code className="block text-xs text-emerald-400 bg-neutral-800 px-3 py-2 rounded font-mono tracking-widest break-all">
                    {secret}
                  </code>
                </div>
              )}

              <button
                onClick={() => { setStep("verify"); setError("") }}
                disabled={!secret}
                className="w-full bg-brand-500 hover:bg-brand-600 disabled:opacity-50 text-neutral-900 text-xs font-medium rounded-lg py-2 transition-colors"
              >
                I&apos;ve scanned the code →
              </button>
            </>
          )}

          {step === "verify" && (
            <form onSubmit={handleVerify} className="space-y-4">
              <p className="text-xs text-neutral-400">
                Enter the 6-digit code from your authenticator app to confirm setup.
              </p>

              <div className="space-y-1.5">
                <label className="text-neutral-400 text-xs font-medium">Authentication code</label>
                <input
                  type="text"
                  inputMode="numeric"
                  pattern="[0-9]{6}"
                  maxLength={6}
                  value={code}
                  onChange={e => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
                  placeholder="000000"
                  autoFocus
                  autoComplete="one-time-code"
                  disabled={loading}
                  className="w-full bg-neutral-800 border border-neutral-700 rounded-lg px-3 py-2.5
                             text-neutral-100 text-sm text-center tracking-[0.4em] placeholder-neutral-600
                             focus:outline-none focus:ring-1 focus:ring-brand-500 focus:border-brand-500
                             disabled:opacity-50"
                />
              </div>

              {error && (
                <div className="flex items-start gap-2 bg-red-900/20 border border-red-800 text-red-300 px-3 py-2 text-xs">
                  <AlertCircle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
                  <span>{error}</span>
                </div>
              )}

              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => setStep("qr")}
                  className="flex-1 text-neutral-400 hover:text-neutral-200 text-xs border border-neutral-700 rounded-lg py-2 transition-colors"
                >
                  ← Back
                </button>
                <button
                  type="submit"
                  disabled={loading || code.length !== 6}
                  className="flex-1 bg-brand-500 hover:bg-brand-600 disabled:opacity-50 text-neutral-900 text-xs font-medium rounded-lg py-2 transition-colors"
                >
                  {loading ? <Loader2 className="w-3.5 h-3.5 animate-spin mx-auto" /> : "Enable MFA"}
                </button>
              </div>
            </form>
          )}

          {step === "done" && (
            <div className="space-y-4">
              <div className="flex items-center gap-2 bg-green-900/20 border border-green-800 text-green-300 px-3 py-2 text-xs">
                <CheckCircle className="w-3.5 h-3.5 shrink-0" />
                <span>Two-factor authentication is now enabled.</span>
              </div>
              <button
                onClick={onClose}
                className="w-full bg-neutral-700 hover:bg-neutral-600 text-white text-xs font-medium rounded-lg py-2 transition-colors"
              >
                Close
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Main settings page
// ---------------------------------------------------------------------------
export default function SettingsPage() {
  const [activeSection, setActiveSection] = useState<SettingsSection>("ca-cert")
  const [isMounted, setIsMounted] = useState(false)
  const [panelOpacity, setPanelOpacity] = useState("opacity-100")
  const [transitionClass, setTransitionClass] = useState("transition-opacity duration-150")

  const handleSectionChange = async (section: SettingsSection) => {
    if (section === activeSection) return

    setTransitionClass("")
    setPanelOpacity("opacity-0")
    await new Promise(resolve => setTimeout(resolve, 16))

    setActiveSection(section)

    try {
      if (section === "security") {
        setMfaLoading(true)
        apiFetch(`${API_BASE}/api/auth/mfa/status`)
          .then(res => res.ok ? res.json() : null)
          .then(data => {
            if (data) setMfaEnabled(data.mfa_enabled)
            setMfaLoading(false)
          })
          .catch(() => setMfaLoading(false))
      } else if (section === "ai-proxy") {
        apiFetch(`${API_BASE}/api/setup`)
          .then(res => res.ok ? res.json() : null)
          .then(d => { if (d) setAiConfig({ provider: d.provider, model: d.model }) })
          .catch(() => {})

        apiFetch(`${API_BASE}/api/proxy/status`)
          .then(res => res.ok ? res.json() : null)
          .then(d => { if (d) setProxyStatus(d) })
          .catch(() => {})
      } else if (section === "den") {
        apiFetch(`${API_BASE}/api/settings/den`)
          .then(res => res.ok ? res.json() : null)
          .then(d => {
            if (d) {
              setDenMaxRunners(d.den_max_runners)
            }
          })
          .catch(() => {})
      }
    } catch {
      // ignore
    }

    setTransitionClass("transition-opacity duration-150")
    setPanelOpacity("opacity-100")
  }

  const [certStatus, setCertStatus] = useState<"idle" | "downloading" | "ok" | "error">("idle")
  const [certError, setCertError] = useState<string | null>(null)
  const [aiConfig, setAiConfig] = useState<{ provider?: string; model?: string } | null>(null)
  const [proxyStatus, setProxyStatus] = useState<ProxyStatus | null>(null)

  // Change password state
  const [currentPw, setCurrentPw] = useState("")
  const [newPw, setNewPw] = useState("")
  const [confirmPw, setConfirmPw] = useState("")
  const [pwStatus, setPwStatus] = useState<"idle" | "saving" | "ok" | "error">("idle")
  const [pwError, setPwError] = useState<string | null>(null)

  // MFA state
  const [mfaEnabled, setMfaEnabled] = useState(false)
  const [mfaLoading, setMfaLoading] = useState(true)
  const [showMfaSetup, setShowMfaSetup] = useState(false)
  const [disablePw, setDisablePw] = useState("")
  const [disableCode, setDisableCode] = useState("")
  const [disableStatus, setDisableStatus] = useState<"idle" | "saving" | "ok" | "error">("idle")
  const [disableError, setDisableError] = useState<string | null>(null)

  // Den State Variables
  const [denMaxRunners, setDenMaxRunners] = useState<number>(10)
  const [denStatus, setDenStatus]         = useState<"idle" | "saving" | "ok" | "error">("idle")
  const [denError, setDenError]       = useState<string | null>(null)

  const [testingDen, setTestingDen]   = useState(false)
  const [testDenResult, setTestDenResult] = useState<{ ok: boolean; detail: string } | null>(null)

  // Backup / Restore state variables
  const [includeSettings, setIncludeSettings] = useState(true)
  const [includeDens, setIncludeDens] = useState(true)
  const [includeProjects, setIncludeProjects] = useState(true)
  const [backupPassphrase, setBackupPassphrase] = useState("")
  const [importPassphrase, setImportPassphrase] = useState("")
  const [importFile, setImportFile] = useState<File | null>(null)
  const [backupStatus, setBackupStatus] = useState<"idle" | "loading" | "ok" | "error">("idle")
  const [backupError, setBackupError] = useState<string | null>(null)

  // ── Resizable list panel ──────────────────────────────────────────────────
  const [listWidth, setListWidth] = useState(DEFAULT_LIST_WIDTH)
  const [isDragging, setIsDragging] = useState(false)
  const listWidthRef = useRef(DEFAULT_LIST_WIDTH)
  const dragging = useRef(false)
  const dragStartX = useRef(0)
  const dragStartWidth = useRef(DEFAULT_LIST_WIDTH)

  useEffect(() => {
    const saved = parseInt(localStorage.getItem(LIST_WIDTH_KEY) ?? "", 10)
    if (!isNaN(saved) && saved >= MIN_LIST_WIDTH && saved <= MAX_LIST_WIDTH) {
      listWidthRef.current = saved; setListWidth(saved)
    }
    setIsMounted(true)
  }, [])

  const handleDragStart = (e: React.MouseEvent) => {
    dragging.current = true; dragStartX.current = e.clientX
    dragStartWidth.current = listWidthRef.current; setIsDragging(true); e.preventDefault()
  }

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (!dragging.current) return
      const next = Math.max(MIN_LIST_WIDTH, Math.min(MAX_LIST_WIDTH, dragStartWidth.current + (e.clientX - dragStartX.current)))
      listWidthRef.current = next; setListWidth(next)
    }
    const onUp = () => {
      if (!dragging.current) return
      dragging.current = false; setIsDragging(false)
      localStorage.setItem(LIST_WIDTH_KEY, String(listWidthRef.current))
    }
    document.addEventListener("mousemove", onMove)
    document.addEventListener("mouseup", onUp)
    return () => { document.removeEventListener("mousemove", onMove); document.removeEventListener("mouseup", onUp) }
  }, [])

  const handleExport = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!includeSettings && !includeDens && !includeProjects) {
      setBackupError("Please select at least one component to export.")
      return
    }
    setBackupStatus("loading")
    setBackupError(null)
    try {
      const res = await apiFetch(`${API_BASE}/api/settings/export`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          passphrase: backupPassphrase || undefined,
          export_settings: includeSettings,
          export_dens: includeDens,
          export_projects: includeProjects
        }),
      })
      if (!res.ok) {
        const d = await res.json()
        throw new Error(d.detail ?? "Export failed")
      }
      const data = await res.json()
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" })
      const url = URL.createObjectURL(blob)
      const a = document.createElement("a")
      a.href = url
      a.download = `ferret-backup-${new Date().toISOString().slice(0, 10)}${backupPassphrase ? "-encrypted" : ""}.json`
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
      setBackupStatus("ok")
    } catch (err) {
      setBackupError(err instanceof Error ? err.message : "Export failed")
      setBackupStatus("error")
    }
  }

  const handleImport = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!importFile) return
    setBackupStatus("loading")
    setBackupError(null)
    try {
      const reader = new FileReader()
      reader.onload = async () => {
        const base64Content = (reader.result as string).split(",")[1]
        try {
          const res = await apiFetch(`${API_BASE}/api/settings/import`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              file_content: base64Content,
              passphrase: importPassphrase || undefined
            }),
          })
          if (!res.ok) {
            const d = await res.json()
            throw new Error(d.detail ?? "Import failed")
          }
          setBackupStatus("ok")
          window.location.reload()
        } catch (err) {
          setBackupError(err instanceof Error ? err.message : "Import failed")
          setBackupStatus("error")
        }
      }
      reader.readAsDataURL(importFile)
    } catch (err) {
      setBackupError("Failed to read file.")
      setBackupStatus("error")
    }
  }

  // Fetch current den settings on mount
  useEffect(() => {
    apiFetch(`${API_BASE}/api/settings/den`)
      .then(r => r.ok ? r.json() : null)
.then(d => {
            if (d) {
              setDenMaxRunners(d.den_max_runners)
            }
          })
      .catch(() => {})
  }, [])

  const saveDenSettings = async (e: React.FormEvent) => {
    e.preventDefault()
    setDenError(null)
    setDenStatus("saving")
    try {
      const res = await apiFetch(`${API_BASE}/api/settings/den`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          den_max_runners: denMaxRunners,
        }),
      })
      if (!res.ok) {
        const body = await res.json().catch(() => ({ detail: "Unknown error" }))
        throw new Error(body.detail ?? `HTTP ${res.status}`)
      }
      setDenStatus("ok")
    } catch (err) {
      setDenError(err instanceof Error ? err.message : "Failed to update Den settings")
      setDenStatus("error")
    }
  }

  const testDenSettings = async () => {
    setTestingDen(true)
    setTestDenResult(null)
    try {
      const res = await apiFetch(`${API_BASE}/api/settings/den/test`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          den_max_runners: denMaxRunners,
        }),
      })
      const d = await res.json()
      if (res.ok) {
        setTestDenResult({ ok: d.ok, detail: d.detail })
      } else {
        const detail = typeof d.detail === "string" ? d.detail : JSON.stringify(d)
        setTestDenResult({ ok: false, detail })
      }
    } catch (err) {
      setTestDenResult({ ok: false, detail: err instanceof Error ? err.message : "Test request failed" })
    } finally {
      setTestingDen(false)
    }
  }

  useEffect(() => {
    apiFetch(`${API_BASE}/api/setup`)
      .then(r => r.ok ? r.json() : null)
      .then(d => { if (d) setAiConfig({ provider: d.provider, model: d.model }) })
      .catch(() => {})
  }, [])

  useEffect(() => {
    const fetchProxy = async () => {
      try {
        const res = await apiFetch(`${API_BASE}/api/proxy/status`)
        if (res.ok) setProxyStatus(await res.json())
      } catch {
        // silently ignore
      }
    }
    fetchProxy()
    const id = setInterval(fetchProxy, 5000)
    return () => clearInterval(id)
  }, [])

  const fetchMfaStatus = useCallback(async () => {
    try {
      const res = await apiFetch(`${API_BASE}/api/auth/mfa/status`)
      if (res.ok) {
        const data = await res.json()
        setMfaEnabled(data.mfa_enabled)
      }
    } catch {
      // silently ignore
    } finally {
      setMfaLoading(false)
    }
  }, [])

  useEffect(() => { fetchMfaStatus() }, [fetchMfaStatus])

  const changePassword = async (e: React.FormEvent) => {
    e.preventDefault()
    setPwError(null)
    if (newPw.length < 8) {
      setPwError("New password must be at least 8 characters.")
      return
    }
    if (newPw !== confirmPw) {
      setPwError("New passwords do not match.")
      return
    }
    setPwStatus("saving")
    try {
      const res = await apiFetch(`${API_BASE}/api/auth/password`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ current_password: currentPw, new_password: newPw }),
      })
      if (!res.ok) {
        const body = await res.json().catch(() => ({ detail: "Unknown error" }))
        throw new Error(body.detail ?? `HTTP ${res.status}`)
      }
      setPwStatus("ok")
      setCurrentPw("")
      setNewPw("")
      setConfirmPw("")
    } catch (err) {
      setPwError(err instanceof Error ? err.message : "Failed to change password")
      setPwStatus("error")
    }
  }

  const disableMfa = async (e: React.FormEvent) => {
    e.preventDefault()
    setDisableError(null)
    setDisableStatus("saving")
    try {
      const res = await apiFetch(`${API_BASE}/api/auth/mfa/disable`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ current_password: disablePw, code: disableCode }),
      })
      if (!res.ok) {
        const body = await res.json().catch(() => ({ detail: "Unknown error" }))
        throw new Error(body.detail ?? `HTTP ${res.status}`)
      }
      setDisableStatus("ok")
      setMfaEnabled(false)
      setDisablePw("")
      setDisableCode("")
    } catch (err) {
      setDisableError(err instanceof Error ? err.message : "Failed to disable MFA")
      setDisableStatus("error")
    }
  }

  const downloadCert = async () => {
    setCertStatus("downloading")
    setCertError(null)
    try {
      const res = await apiFetch(`${API_BASE}/api/ca-cert`)
      if (!res.ok) {
        const body = await res.json().catch(() => ({ detail: res.statusText }))
        throw new Error(body.detail ?? `HTTP ${res.status}`)
      }
      const blob = await res.blob()
      const url = URL.createObjectURL(blob)
      const a = document.createElement("a")
      a.href = url
      a.download = "ferret-ca-cert.pem"
      document.body.appendChild(a)
      a.click()
      a.remove()
      URL.revokeObjectURL(url)
      setCertStatus("ok")
    } catch (err) {
      setCertError(err instanceof Error ? err.message : "Download failed")
      setCertStatus("error")
    }
  }

  const proxyBadge = proxyStatus ? (
    <span className={`px-2 py-0.5 text-xs flex items-center gap-1 border ${
      proxyStatus.running
        ? "bg-green-900/40 border-green-700 text-green-300"
        : "bg-red-900/40 border-red-700 text-red-300"
    }`}>
      <span className={`w-1.5 h-1.5 rounded-full ${proxyStatus.running ? "bg-green-400 animate-pulse" : "bg-red-400"}`} />
      {proxyStatus.running ? "Active" : "Stopped"}
    </span>
  ) : null

  const mfaBadge = mfaLoading ? null : (
    <span className={`px-2 py-0.5 text-xs flex items-center gap-1 border ${
      mfaEnabled
        ? "bg-green-900/40 border-green-700 text-green-300"
        : "bg-neutral-800 border-neutral-700 text-neutral-400"
    }`}>
      {mfaEnabled ? "Enabled" : "Disabled"}
    </span>
  )

  return (
    <div className={`flex h-full bg-neutral-950 text-white overflow-hidden transition-opacity duration-150 ${isDragging ? "select-none" : ""} ${isMounted ? "opacity-100" : "opacity-0"}`}>
      {/* Left: settings navigation list */}
      <div
        className="flex-shrink-0 border-r border-neutral-800 flex flex-col overflow-hidden"
        style={{ width: `${listWidth}px` }}
      >
        {/* Left Nav Header */}
        <div className="flex items-center justify-between px-3 h-[48px] border-b border-neutral-800 bg-[#171717] flex-shrink-0">
          <div className="flex flex-col min-w-0">
            <span className="text-sm font-bold tracking-wider text-white">Settings</span>
            <span className="text-[10px] text-neutral-500 mt-0.5 leading-none whitespace-nowrap truncate">Global preferences</span>
          </div>
        </div>

        {/* Sidebar Nav Buttons */}
        <div className="flex-1 overflow-y-auto">
          <button
            onClick={() => handleSectionChange("ca-cert")}
            className={`w-full text-left px-3 py-2.5 border-b border-neutral-800/60 transition-colors ${
              activeSection === "ca-cert" ? "bg-neutral-800 text-white" : "hover:bg-neutral-900/80 text-neutral-300"
            }`}
          >
            <div className="flex items-center gap-1.5">
              <ShieldCheck className="w-3.5 h-3.5 text-brand-400 shrink-0" />
              <span className="text-xs font-medium truncate flex-1">CA Certificate</span>
              <ChevronRight className={`w-3 h-3 flex-shrink-0 ${activeSection === "ca-cert" ? "text-brand-400" : "text-neutral-700"}`} />
            </div>
          </button>

          <button
            onClick={() => handleSectionChange("security")}
            className={`w-full text-left px-3 py-2.5 border-b border-neutral-800/60 transition-colors ${
              activeSection === "security" ? "bg-neutral-800 text-white" : "hover:bg-neutral-900/80 text-neutral-300"
            }`}
          >
            <div className="flex items-center gap-1.5">
              <ShieldAlert className="w-3.5 h-3.5 text-brand-400 shrink-0" />
              <span className="text-xs font-medium truncate flex-1">Security & Auth</span>
              <ChevronRight className={`w-3 h-3 flex-shrink-0 ${activeSection === "security" ? "text-brand-400" : "text-neutral-700"}`} />
            </div>
          </button>

          <button
            onClick={() => handleSectionChange("ai-proxy")}
            className={`w-full text-left px-3 py-2.5 border-b border-neutral-800/60 transition-colors ${
              activeSection === "ai-proxy" ? "bg-neutral-800 text-white" : "hover:bg-neutral-900/80 text-neutral-300"
            }`}
          >
            <div className="flex items-center gap-1.5">
              <Activity className="w-3.5 h-3.5 text-brand-400 shrink-0" />
              <span className="text-xs font-medium truncate flex-1">AI & Proxy</span>
              <ChevronRight className={`w-3 h-3 flex-shrink-0 ${activeSection === "ai-proxy" ? "text-brand-400" : "text-neutral-700"}`} />
            </div>
          </button>

          <button
            onClick={() => handleSectionChange("den")}
            className={`w-full text-left px-3 py-2.5 border-b border-neutral-800/60 transition-colors ${
              activeSection === "den" ? "bg-neutral-800 text-white" : "hover:bg-neutral-900/80 text-neutral-300"
            }`}
          >
            <div className="flex items-center gap-1.5">
              <Cpu className="w-3.5 h-3.5 text-brand-400 shrink-0" />
              <span className="text-xs font-medium truncate flex-1">Runner Provider</span>
              <ChevronRight className={`w-3 h-3 flex-shrink-0 ${activeSection === "den" ? "text-brand-400" : "text-neutral-700"}`} />
            </div>
          </button>

          <button
            onClick={() => handleSectionChange("backup")}
            className={`w-full text-left px-3 py-2.5 border-b border-neutral-800/60 last:border-b-0 transition-colors ${
              activeSection === "backup" ? "bg-neutral-800 text-white" : "hover:bg-neutral-900/80 text-neutral-300"
            }`}
          >
            <div className="flex items-center gap-1.5">
              <Download className="w-3.5 h-3.5 text-brand-400 shrink-0" />
              <span className="text-xs font-medium truncate flex-1">Backup & Restore</span>
              <ChevronRight className={`w-3 h-3 flex-shrink-0 ${activeSection === "backup" ? "text-brand-400" : "text-neutral-700"}`} />
            </div>
          </button>
        </div>
      </div>

      {/* Drag handle */}
      <div
        onMouseDown={handleDragStart}
        className="w-1 flex-shrink-0 bg-neutral-800 hover:bg-brand-500 transition-colors cursor-col-resize z-10"
      />

      {/* Right Content Area */}
      <div className="flex-1 bg-neutral-950 flex flex-col h-full overflow-hidden">
        {/* Static Header */}
        <div className="flex items-center justify-between px-4 h-[48px] border-b border-neutral-800 bg-[#171717] flex-shrink-0 gap-3">
          <div className="flex flex-col min-w-0 flex-1">
            <div className="flex items-center gap-2">
              {activeSection === "ca-cert" && <ShieldCheck className="w-3.5 h-3.5 text-brand-400" />}
              {activeSection === "security" && <ShieldAlert className="w-3.5 h-3.5 text-brand-400" />}
              {activeSection === "ai-proxy" && <Activity className="w-3.5 h-3.5 text-brand-400" />}
              {activeSection === "den" && <Cpu className="w-3.5 h-3.5 text-brand-400" />}
              {activeSection === "backup" && <Download className="w-3.5 h-3.5 text-brand-400" />}
              <span className="text-sm font-bold tracking-wider text-white">
                {activeSection === "ca-cert" && "CA Certificate"}
                {activeSection === "security" && "Security & Authentication"}
                {activeSection === "ai-proxy" && "AI Provider & Proxy"}
                {activeSection === "den" && "Den Runner Provider"}
                {activeSection === "backup" && "Backup & Restore"}
              </span>
            </div>
            <span className="text-[10px] text-neutral-500 mt-0.5 leading-none">
              {activeSection === "ca-cert" && "HTTPS interception credentials"}
              {activeSection === "security" && "Access control, session keys, and MFA"}
              {activeSection === "ai-proxy" && "Configure LLM connections, keys, and intercept modes"}
              {activeSection === "den" && "Configure local Docker runner pools"}
              {activeSection === "backup" && "Import and export workspace and proxy history databases"}
            </span>
          </div>
        </div>

        {/* Fading Content Panel */}
        <div className={`flex-1 overflow-y-auto ${transitionClass} ${panelOpacity}`}>
          {activeSection === "ca-cert" && (
            <div className="p-6 space-y-4 max-w-4xl">
              <p className="text-xs text-neutral-400">
                Import this certificate into your browser or OS trust store to intercept HTTPS traffic without security warnings.
              </p>

              <div className="flex items-center gap-3">
                <Button
                  onClick={downloadCert}
                  disabled={certStatus === "downloading"}
                  size="sm"
                  className="h-7 text-xs bg-brand-500 hover:bg-brand-600 text-neutral-900 rounded-none"
                >
                  {certStatus === "downloading" ? (
                    <><Loader2 className="w-3 h-3 mr-1.5 animate-spin" /> Downloading...</>
                  ) : certStatus === "ok" ? (
                    <><CheckCircle className="w-3 h-3 mr-1.5" /> Downloaded</>
                  ) : (
                    <><Download className="w-3 h-3 mr-1.5" /> Download ferret-ca-cert.pem</>
                  )}
                </Button>
                {certStatus === "ok" && (
                  <span className="text-xs text-green-400">Certificate saved successfully</span>
                )}
              </div>

              {certStatus === "error" && certError && (
                <div className="flex items-start gap-2 bg-red-900/20 border border-red-800 text-red-300 px-3 py-2 text-xs">
                  <AlertCircle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
                  <span>{certError}</span>
                </div>
              )}

              {/* Installation instructions */}
              <div className="space-y-2 pt-2">
                <p className="text-[10px] font-semibold text-neutral-500 uppercase tracking-wider">Installation instructions</p>

                <div className="grid grid-cols-1 md:grid-cols-3 border border-neutral-800 divide-y md:divide-y-0 md:divide-x divide-neutral-800">
                  {/* Firefox */}
                  <div className="p-3 space-y-1.5">
                    <p className="text-xs font-semibold text-white">Firefox</p>
                    <ol className="text-xs text-neutral-400 space-y-1 list-decimal list-inside">
                      <li>Open <span className="text-neutral-200">Settings → Privacy &amp; Security</span></li>
                      <li>Scroll to <span className="text-neutral-200">Certificates → View Certificates</span></li>
                      <li>Click <span className="text-neutral-200">Authorities → Import</span></li>
                      <li>Select <code className="text-emerald-400">ferret-ca-cert.pem</code></li>
                      <li>Check <span className="text-neutral-200">"Trust this CA to identify websites"</span></li>
                    </ol>
                  </div>

                  {/* Chrome / macOS */}
                  <div className="p-3 space-y-1.5">
                    <p className="text-xs font-semibold text-white">Chrome / macOS</p>
                    <ol className="text-xs text-neutral-400 space-y-1 list-decimal list-inside">
                      <li>Double-click <code className="text-emerald-400">ferret-ca-cert.pem</code></li>
                      <li>Keychain Access opens — add to <span className="text-neutral-200">System</span></li>
                      <li>Find the cert, double-click it</li>
                      <li>Expand <span className="text-neutral-200">Trust</span> → set to <span className="text-neutral-200">Always Trust</span></li>
                      <li>Restart Chrome</li>
                    </ol>
                  </div>

                  {/* Linux */}
                  <div className="p-3 space-y-1.5">
                    <p className="text-xs font-semibold text-white">Linux (system-wide)</p>
                    <ol className="text-xs text-neutral-400 space-y-1 list-decimal list-inside">
                      <li>Copy cert to <code className="text-emerald-400">/usr/local/share/ca-certificates/ferret.crt</code></li>
                      <li>Run <code className="text-emerald-400">sudo update-ca-certificates</code></li>
                      <li>For Chrome: open <span className="text-neutral-200">chrome://settings/certificates</span> → Authorities → Import</li>
                    </ol>
                  </div>
                </div>

                <p className="text-xs text-neutral-600 pt-2">
                  The certificate is generated by mitmproxy on first proxy start and is unique to this installation.
                  Stored at <code className="text-neutral-500">~/.mitmproxy/mitmproxy-ca-cert.pem</code> inside the container.
                </p>
              </div>
            </div>
          )}

          {activeSection === "security" && (
            <div className="p-6 grid grid-cols-1 lg:grid-cols-2 gap-8 max-w-6xl">
              {/* Left Column: Change Password */}
              <div className="space-y-4">
                <div className="flex items-center gap-2 h-8 border-b border-neutral-800 pb-2">
                  <KeyRound className="w-4 h-4 text-brand-400" />
                  <h3 className="text-xs font-semibold text-white uppercase tracking-wider">Change Password</h3>
                </div>

                {pwStatus === "ok" ? (
                  <div className="flex items-center gap-2 bg-green-900/20 border border-green-800 text-green-300 px-3 py-2 text-xs mb-3">
                    <CheckCircle className="w-3.5 h-3.5 shrink-0" />
                    <span>Password updated. You have been logged out of all sessions — please log in again.</span>
                  </div>
                ) : null}

                <form onSubmit={changePassword} className="space-y-3 max-w-sm">
                  <div className="space-y-1">
                    <label className="block text-xs text-neutral-400">Current password</label>
                    <Input
                      type="password"
                      value={currentPw}
                      onChange={e => setCurrentPw(e.target.value)}
                      placeholder="Current password"
                      required
                      className="h-7 text-xs bg-neutral-900 border-neutral-700 text-white rounded-none focus:border-brand-500"
                    />
                  </div>
                  <div className="space-y-1">
                    <label className="block text-xs text-neutral-400">New password <span className="text-neutral-600">(min 8 chars)</span></label>
                    <Input
                      type="password"
                      value={newPw}
                      onChange={e => setNewPw(e.target.value)}
                      placeholder="New password"
                      required
                      minLength={8}
                      className="h-7 text-xs bg-neutral-900 border-neutral-700 text-white rounded-none focus:border-brand-500"
                    />
                  </div>
                  <div className="space-y-1">
                    <label className="block text-xs text-neutral-400">Confirm new password</label>
                    <Input
                      type="password"
                      value={confirmPw}
                      onChange={e => setConfirmPw(e.target.value)}
                      placeholder="Confirm new password"
                      required
                      className="h-7 text-xs bg-neutral-900 border-neutral-700 text-white rounded-none focus:border-brand-500"
                    />
                  </div>

                  {pwError && (
                    <div className="flex items-start gap-2 bg-red-900/20 border border-red-800 text-red-300 px-3 py-2 text-xs">
                      <AlertCircle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
                      <span>{pwError}</span>
                    </div>
                  )}

                  <Button
                    type="submit"
                    disabled={pwStatus === "saving"}
                    size="sm"
                    className="h-7 text-xs bg-brand-500 hover:bg-brand-600 text-neutral-900 rounded-none"
                  >
                    {pwStatus === "saving" ? (
                      <><Loader2 className="w-3 h-3 mr-1.5 animate-spin" /> Saving...</>
                    ) : (
                      "Update password"
                    )}
                  </Button>
                </form>
              </div>

              {/* Right Column: MFA */}
              <div className="space-y-4">
                <div className="flex items-center gap-2 h-8 border-b border-neutral-800 pb-2">
                  <ShieldAlert className="w-4 h-4 text-brand-400" />
                  <h3 className="text-xs font-semibold text-white uppercase tracking-wider">Two-Factor Authentication</h3>
                  <div className="ml-auto">{mfaBadge}</div>
                </div>

                {mfaLoading ? (
                  <div className="flex items-center gap-2 text-neutral-500 text-xs">
                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    <span>Loading…</span>
                  </div>
                ) : mfaEnabled ? (
                  <>
                    <div className="flex items-center gap-2 bg-green-900/20 border border-green-800 text-green-300 px-3 py-2 text-xs">
                      <CheckCircle className="w-3.5 h-3.5 shrink-0" />
                      <span>Two-factor authentication is enabled. A TOTP code is required at every login.</span>
                    </div>

                    {disableStatus === "ok" ? (
                      <div className="flex items-center gap-2 bg-neutral-800 border border-neutral-700 text-neutral-300 px-3 py-2 text-xs">
                        <CheckCircle className="w-3.5 h-3.5 shrink-0" />
                        <span>MFA disabled successfully.</span>
                      </div>
                    ) : (
                      <form onSubmit={disableMfa} className="space-y-3 max-w-sm">
                        <p className="text-xs text-neutral-500">To disable MFA, enter your current password and a valid TOTP code.</p>
                        <div className="space-y-1">
                          <label className="block text-xs text-neutral-400">Current password</label>
                          <Input
                            type="password"
                            value={disablePw}
                            onChange={e => setDisablePw(e.target.value)}
                            placeholder="Current password"
                            required
                            className="h-7 text-xs bg-neutral-900 border-neutral-700 text-white rounded-none focus:border-brand-500"
                          />
                        </div>
                        <div className="space-y-1">
                          <label className="block text-xs text-neutral-400">Authentication code</label>
                          <Input
                            type="text"
                            inputMode="numeric"
                            maxLength={6}
                            value={disableCode}
                            onChange={e => setDisableCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
                            placeholder="000000"
                            required
                            className="h-7 text-xs bg-neutral-900 border-neutral-700 text-white rounded-none focus:border-brand-500 tracking-widest text-center"
                          />
                        </div>

                        {disableError && (
                          <div className="flex items-start gap-2 bg-red-900/20 border border-red-800 text-red-300 px-3 py-2 text-xs">
                            <AlertCircle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
                            <span>{disableError}</span>
                          </div>
                        )}

                        <Button
                          type="submit"
                          disabled={disableStatus === "saving"}
                          size="sm"
                          className="h-7 text-xs bg-red-600 hover:bg-red-700 text-white rounded-none"
                        >
                          {disableStatus === "saving" ? (
                            <><Loader2 className="w-3 h-3 mr-1.5 animate-spin" /> Disabling...</>
                          ) : (
                            "Disable MFA"
                          )}
                        </Button>
                      </form>
                    )}
                  </>
                ) : (
                  <>
                    <p className="text-xs text-neutral-400 leading-relaxed">
                      Two-factor authentication adds an extra layer of security. After enabling, you will need a TOTP code from your authenticator app at every login.
                    </p>
                    <Button
                      onClick={() => setShowMfaSetup(true)}
                      size="sm"
                      className="h-7 text-xs bg-brand-500 hover:bg-brand-600 text-neutral-900 rounded-none animate-pulse"
                    >
                      Enable two-factor authentication
                    </Button>
                  </>
                )}
              </div>
            </div>
          )}

          {activeSection === "ai-proxy" && (
            <div className="p-6 grid grid-cols-1 lg:grid-cols-2 gap-8 max-w-6xl">
              {/* Left column: AI Provider config */}
              <div className="space-y-4">
                <div className="flex items-center gap-2 h-8 border-b border-neutral-800 pb-2">
                  <Cpu className="w-4 h-4 text-brand-400" />
                  <h3 className="text-xs font-semibold text-white uppercase tracking-wider">AI Configuration</h3>
                </div>

                {aiConfig?.provider ? (
                  <div className="rounded border border-neutral-800 bg-neutral-900/30 divide-y divide-neutral-800 text-xs max-w-md">
                    <div className="flex justify-between px-3 py-2.5">
                      <span className="text-neutral-400">Provider</span>
                      <span className="text-white font-medium capitalize">{aiConfig.provider}</span>
                    </div>
                    <div className="flex justify-between px-3 py-2.5">
                      <span className="text-neutral-400">Default model</span>
                      <span className="text-white font-medium">{aiConfig.model ?? "—"}</span>
                    </div>
                  </div>
                ) : (
                  <p className="text-xs text-neutral-500">No AI provider configured.</p>
                )}

                <p className="text-xs text-neutral-400 leading-relaxed max-w-md">
                  Re-run the setup wizard to change your AI provider, api base url, or API credentials.
                </p>

                <Link href="/setup">
                  <Button
                    size="sm"
                    className="h-7 text-xs bg-brand-500 hover:bg-brand-600 text-neutral-900 rounded-none"
                  >
                    Re-run setup wizard
                  </Button>
                </Link>
              </div>

              {/* Right column: mitmproxy status */}
              <div className="space-y-4">
                <div className="flex items-center gap-2 h-8 border-b border-neutral-800 pb-2">
                  <Activity className="w-4 h-4 text-brand-400" />
                  <h3 className="text-xs font-semibold text-white uppercase tracking-wider">Mitmproxy Daemon Status</h3>
                  <div className="ml-auto">{proxyBadge}</div>
                </div>

                <div className="divide-y divide-neutral-800 border border-neutral-800 bg-neutral-900/10 max-w-md rounded">
                  <div className="px-3 py-2.5 flex items-center justify-between text-xs">
                    <span className="text-neutral-500">Listen Address</span>
                    <span className="text-white font-mono">{proxyStatus?.listen_address ?? "—"}</span>
                  </div>
                  <div className="px-3 py-2.5 flex items-center justify-between text-xs">
                    <span className="text-neutral-500">Service Status</span>
                    <span className={`font-mono font-medium ${proxyStatus?.running ? "text-green-400 animate-pulse" : "text-red-400"}`}>
                      {proxyStatus == null ? "—" : proxyStatus.running ? "Running" : "Stopped"}
                    </span>
                  </div>
                  {proxyStatus?.running && (
                    <div className="px-3 py-2.5 flex items-center justify-between text-xs">
                      <span className="text-neutral-500">Intercepted</span>
                      <span className="text-white font-mono font-semibold">{proxyStatus.intercepted.toLocaleString()} requests</span>
                    </div>
                  )}
                </div>
              </div>
            </div>
          )}

          {activeSection === "den" && (
            <div className="p-6 space-y-4 max-w-2xl">
              <p className="text-xs text-neutral-400">
                Configure how Ferret scales and manages scanning environments using the local Docker sandbox.
              </p>

              <form onSubmit={saveDenSettings} className="space-y-4">
                <div className="space-y-1">
                  <label className="block text-[11px] text-neutral-400">Global Max Concurrent Runners</label>
                  <Input
                    type="number"
                    value={denMaxRunners}
                    onChange={e => setDenMaxRunners(Math.max(1, parseInt(e.target.value) || 1))}
                    className="h-7 text-xs bg-neutral-900 border-neutral-700 text-white rounded-none focus:border-brand-500 max-w-xs"
                  />
                  <p className="text-[10px] text-neutral-500">
                    Enforces a strict upper ceiling on concurrently active scanning tasks.
                  </p>
                </div>

                {denStatus === "ok" && (
                  <div className="flex items-center gap-2 bg-green-900/20 border border-green-800 text-green-300 px-3 py-2 text-xs">
                    <CheckCircle className="w-3.5 h-3.5 shrink-0" />
                    <span>Den configuration updated successfully.</span>
                  </div>
                )}

                {denError && (
                  <div className="flex items-start gap-2 bg-red-900/20 border border-red-800 text-red-300 px-3 py-2 text-xs">
                    <AlertCircle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
                    <span>{denError}</span>
                  </div>
                )}

                <div className="flex items-center gap-3">
                  <Button
                    type="submit"
                    disabled={denStatus === "saving"}
                    size="sm"
                    className="h-7 text-xs bg-brand-500 hover:bg-brand-600 text-neutral-900 rounded-none"
                  >
                    {denStatus === "saving" ? (
                      <><Loader2 className="w-3 h-3 mr-1.5 animate-spin" /> Saving...</>
                    ) : (
                      "Save Den Settings"
                    )}
                  </Button>

                  <Button
                    type="button"
                    onClick={testDenSettings}
                    disabled={testingDen}
                    variant="outline"
                    size="sm"
                    className="h-7 text-xs border-neutral-700 text-neutral-300 hover:bg-neutral-800 hover:text-white rounded-none"
                  >
                    {testingDen ? (
                      <><Loader2 className="w-3 h-3 mr-1.5 animate-spin" /> Testing...</>
                    ) : (
                      "Test Connection"
                    )}
                  </Button>
                </div>

                {testDenResult && (
                  <div className={`text-xs p-2.5 border ${
                    testDenResult.ok
                      ? "bg-green-900/20 border-green-800 text-green-300"
                      : "bg-red-900/20 border-red-800 text-red-300"
                  }`}>
                    {testDenResult.ok ? "✓ " : "✗ "}
                    {testDenResult.detail}
                  </div>
                )}
              </form>
            </div>
          )}

          {activeSection === "backup" && (
            <div className="p-6 space-y-6 max-w-xl">
              <p className="text-xs text-neutral-400">
                Export or import your configurations, custom runner environments, and project workspaces.
              </p>

              <form onSubmit={handleExport} className="space-y-4">
                <h4 className="text-xs font-semibold text-white uppercase tracking-wider">Export Settings</h4>
                <p className="text-xs text-neutral-500 leading-relaxed">
                  Select the components you want to back up, and specify an optional passphrase to secure your credentials:
                </p>

                <div className="space-y-2 bg-neutral-900/50 p-3 border border-neutral-800">
                  <label className="flex items-center gap-2.5 text-xs text-neutral-300 cursor-pointer select-none">
                    <input
                      type="checkbox"
                      checked={includeSettings}
                      onChange={e => setIncludeSettings(e.target.checked)}
                      className="rounded-none border-neutral-800 bg-neutral-950 text-brand-500 focus:ring-0 focus:ring-offset-0 w-3.5 h-3.5"
                    />
                    <div>
                      <span className="font-medium text-neutral-200">Global Configuration & Keys</span>
                      <p className="text-[10px] text-neutral-500">AI model parameters, API keys, and endpoint variables.</p>
                    </div>
                  </label>

                  <label className="flex items-center gap-2.5 text-xs text-neutral-300 cursor-pointer select-none">
                    <input
                      type="checkbox"
                      checked={includeDens}
                      onChange={e => setIncludeDens(e.target.checked)}
                      className="rounded-none border-neutral-800 bg-neutral-950 text-brand-500 focus:ring-0 focus:ring-offset-0 w-3.5 h-3.5"
                    />
                    <div>
                      <span className="font-medium text-neutral-200">Runner Environments</span>
                      <p className="text-[10px] text-neutral-500">Local Docker runner specifications and credentials.</p>
                    </div>
                  </label>

                  <label className="flex items-center gap-2.5 text-xs text-neutral-300 cursor-pointer select-none">
                    <input
                      type="checkbox"
                      checked={includeProjects}
                      onChange={e => setIncludeProjects(e.target.checked)}
                      className="rounded-none border-neutral-800 bg-neutral-950 text-brand-500 focus:ring-0 focus:ring-offset-0 w-3.5 h-3.5"
                    />
                    <div>
                      <span className="font-medium text-neutral-200">Projects & Workspace Data</span>
                      <p className="text-[10px] text-neutral-500">Findings, captured HTTP proxy logs, workspace chats, and test runs.</p>
                    </div>
                  </label>
                </div>

                <div className="flex gap-2">
                  <Input
                    type="password"
                    placeholder="Passphrase (optional encryption)"
                    value={backupPassphrase}
                    onChange={e => setBackupPassphrase(e.target.value)}
                    className="h-7 text-xs bg-neutral-950 border-neutral-800 rounded-none w-full"
                  />
                  <Button type="submit" disabled={backupStatus === "loading"} size="sm" className="h-7 text-xs bg-brand-500 hover:bg-brand-600 text-neutral-900 rounded-none shrink-0">
                    {backupStatus === "loading" ? <Loader2 className="w-3 h-3 animate-spin mr-1" /> : <Download className="w-3 h-3 mr-1" />}
                    Export Backup
                  </Button>
                </div>
              </form>

              <div className="border-t border-neutral-800/60 my-4" />

              <form onSubmit={handleImport} className="space-y-4">
                <h4 className="text-xs font-semibold text-white uppercase tracking-wider">Import Settings</h4>
                <p className="text-xs text-neutral-500 leading-relaxed">Restore settings and project data from a previously saved backup file.</p>

                <input
                  type="file"
                  accept=".json"
                  onChange={e => setImportFile(e.target.files?.[0] ?? null)}
                  className="block w-full text-xs text-neutral-400 file:mr-4 file:py-1 file:px-2 file:border file:border-neutral-800 file:text-xs file:font-semibold file:bg-neutral-900 file:text-neutral-200 hover:file:bg-neutral-800 cursor-pointer"
                />

                <div className="flex gap-2">
                  <Input
                    type="password"
                    placeholder="Decryption passphrase (if encrypted)"
                    value={importPassphrase}
                    onChange={e => setImportPassphrase(e.target.value)}
                    className="h-7 text-xs bg-neutral-950 border-neutral-800 rounded-none w-full"
                  />
                  <Button type="submit" disabled={!importFile || backupStatus === "loading"} size="sm" className="h-7 text-xs bg-brand-500 hover:bg-brand-600 text-neutral-900 rounded-none shrink-0">
                    {backupStatus === "loading" ? <Loader2 className="w-3 h-3 animate-spin mr-1" /> : <Upload className="w-3 h-3 mr-1" />}
                    Import Backup
                  </Button>
                </div>
              </form>

              {backupStatus === "error" && backupError && (
                <div className="flex items-start gap-2 bg-red-900/20 border border-red-800 text-red-300 px-3 py-2 text-xs">
                  <AlertCircle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
                  <span>{backupError}</span>
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      {/* MFA Setup Modal */}
      {showMfaSetup && (
        <MfaSetupModal
          onClose={() => setShowMfaSetup(false)}
          onEnabled={() => {
            setMfaEnabled(true)
            setShowMfaSetup(false)
          }}
        />
      )}
    </div>
  )
}
