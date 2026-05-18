"use client"

import { apiFetch } from "@/lib/api-fetch"

import { useState, useEffect, useCallback } from "react"
import Link from "next/link"
import Image from "next/image"
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
  ChevronDown,
  KeyRound,
  ShieldAlert,
  X,
} from "lucide-react"

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000"

interface ProxyStatus {
  running: boolean
  uptime: number
  listen_address: string
  intercepted: number
}

function SectionHeader({
  icon,
  label,
  open,
  onToggle,
  badge,
}: {
  icon: React.ReactNode
  label: string
  open: boolean
  onToggle: () => void
  badge?: React.ReactNode
}) {
  return (
    <button
      onClick={onToggle}
      className="w-full flex items-center gap-2 px-3 py-2 border-b border-neutral-800 bg-neutral-900 hover:bg-neutral-800/60 transition-colors text-left"
    >
      {icon}
      <span className="text-xs font-semibold text-white uppercase tracking-wider">{label}</span>
      {badge && <span className="ml-2">{badge}</span>}
      <ChevronDown
        className={`w-3.5 h-3.5 text-neutral-500 ml-auto transition-transform duration-200 ${open ? "rotate-180" : ""}`}
      />
    </button>
  )
}

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

  // Fetch the QR code on mount.
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
        {/* Header */}
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
  const [certStatus, setCertStatus] = useState<"idle" | "downloading" | "ok" | "error">("idle")
  const [certError, setCertError] = useState<string | null>(null)
  const [aiConfig, setAiConfig] = useState<{ provider?: string; model?: string } | null>(null)
  const [proxyStatus, setProxyStatus] = useState<ProxyStatus | null>(null)

  const [proxyOpen, setProxyOpen] = useState(true)
  const [certOpen, setCertOpen] = useState(true)
  const [aiOpen, setAiOpen] = useState(true)
  const [pwOpen, setPwOpen] = useState(true)
  const [mfaOpen, setMfaOpen] = useState(true)

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
    <div className="flex flex-col h-full overflow-hidden bg-neutral-950 text-white">

      {/* Page header */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-neutral-800 flex-shrink-0 bg-neutral-900">
        <h1 className="text-sm font-bold text-white">Settings</h1>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto">

        {/* CA Certificate section */}
        <div className="border-b border-neutral-800">
          <SectionHeader
            icon={<ShieldCheck className="w-4 h-4 text-brand-400 flex-shrink-0" />}
            label="CA Certificate"
            open={certOpen}
            onToggle={() => setCertOpen(o => !o)}
          />
          {certOpen && (
            <div className="px-4 py-3 space-y-3">
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
              <div className="space-y-2 pt-1">
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

                <p className="text-xs text-neutral-600">
                  The certificate is generated by mitmproxy on first proxy start and is unique to this installation.
                  Stored at <code className="text-neutral-500">~/.mitmproxy/mitmproxy-ca-cert.pem</code> inside the container.
                </p>
              </div>
            </div>
          )}
        </div>

        {/* Change Password section */}
        <div className="border-b border-neutral-800">
          <SectionHeader
            icon={<KeyRound className="w-4 h-4 text-brand-400 flex-shrink-0" />}
            label="Change Password"
            open={pwOpen}
            onToggle={() => setPwOpen(o => !o)}
          />
          {pwOpen && (
            <div className="px-4 py-3">
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
          )}
        </div>

        {/* Two-Factor Authentication section */}
        <div className="border-b border-neutral-800">
          <SectionHeader
            icon={<ShieldAlert className="w-4 h-4 text-brand-400 flex-shrink-0" />}
            label="Two-Factor Authentication"
            open={mfaOpen}
            onToggle={() => setMfaOpen(o => !o)}
            badge={mfaBadge}
          />
          {mfaOpen && (
            <div className="px-4 py-3 space-y-3">
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
                  <p className="text-xs text-neutral-400">
                    Two-factor authentication adds an extra layer of security. After enabling, you will need a TOTP code from your authenticator app at every login.
                  </p>
                  <Button
                    onClick={() => setShowMfaSetup(true)}
                    size="sm"
                    className="h-7 text-xs bg-brand-500 hover:bg-brand-600 text-neutral-900 rounded-none"
                  >
                    Enable two-factor authentication
                  </Button>
                </>
              )}
            </div>
          )}
        </div>

        {/* AI Provider section */}
        <div className="border-b border-neutral-800">
          <SectionHeader
            icon={<Cpu className="w-4 h-4 text-brand-400 flex-shrink-0" />}
            label="AI Provider"
            open={aiOpen}
            onToggle={() => setAiOpen(o => !o)}
          />
          {aiOpen && (
            <div className="px-4 py-3 space-y-3">
              {aiConfig?.provider ? (
                <div className="rounded border border-neutral-800 bg-neutral-900 divide-y divide-neutral-800 text-xs">
                  <div className="flex justify-between px-3 py-2">
                    <span className="text-neutral-400">Provider</span>
                    <span className="text-white font-medium capitalize">{aiConfig.provider}</span>
                  </div>
                  <div className="flex justify-between px-3 py-2">
                    <span className="text-neutral-400">Default model</span>
                    <span className="text-white font-medium">{aiConfig.model ?? "—"}</span>
                  </div>
                </div>
              ) : (
                <p className="text-xs text-neutral-500">No AI provider configured.</p>
              )}

              <p className="text-xs text-neutral-400">
                Re-run the setup wizard to change your AI provider or API key.
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
          )}
        </div>

        {/* Proxy section */}
        <div className="border-b border-neutral-800">
          <SectionHeader
            icon={<Activity className="w-4 h-4 text-brand-400 flex-shrink-0" />}
            label="Proxy"
            open={proxyOpen}
            onToggle={() => setProxyOpen(o => !o)}
            badge={proxyBadge}
          />
          {proxyOpen && (
            <div className="divide-y divide-neutral-800">
              <div className="px-4 py-2.5 flex items-center gap-4 text-xs">
                <span className="text-neutral-500 w-36 shrink-0">Listen Address</span>
                <span className="text-white font-mono">
                  {proxyStatus?.listen_address ?? "—"}
                </span>
              </div>
              <div className="px-4 py-2.5 flex items-center gap-4 text-xs">
                <span className="text-neutral-500 w-36 shrink-0">Status</span>
                <span className={`font-mono ${proxyStatus?.running ? "text-green-400" : "text-red-400"}`}>
                  {proxyStatus == null ? "—" : proxyStatus.running ? "Running" : "Stopped"}
                </span>
              </div>
              {proxyStatus?.running && (
                <div className="px-4 py-2.5 flex items-center gap-4 text-xs">
                  <span className="text-neutral-500 w-36 shrink-0">Intercepted</span>
                  <span className="text-white font-mono">{proxyStatus.intercepted.toLocaleString()} requests</span>
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
