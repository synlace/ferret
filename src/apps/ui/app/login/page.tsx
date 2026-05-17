"use client"

import { apiFetch } from "@/lib/api-fetch"

import { useState, useRef, useEffect } from "react"
import Image from "next/image"
import { useRouter } from "next/navigation"
import { Eye, EyeOff, LogIn, ShieldCheck } from "lucide-react"

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000"

export default function LoginPage() {
  const router = useRouter()
  const inputRef = useRef<HTMLInputElement>(null)
  const otpRef  = useRef<HTMLInputElement>(null)

  // Step 1 — password
  const [password, setPassword]     = useState("")
  const [showPw, setShowPw]         = useState(false)
  const [error, setError]           = useState("")
  const [loading, setLoading]       = useState(false)

  // Step 2 — TOTP challenge
  const [mfaRequired, setMfaRequired] = useState(false)
  const [otpCode, setOtpCode]         = useState("")
  const [otpError, setOtpError]       = useState("")
  const [otpLoading, setOtpLoading]   = useState(false)

  // Auto-focus the active input on mount / step change.
  useEffect(() => {
    if (mfaRequired) {
      otpRef.current?.focus()
    } else {
      inputRef.current?.focus()
    }
  }, [mfaRequired])

  // If already authenticated, skip straight to the app.
  useEffect(() => {
    const check = async () => {
      try {
        const res = await apiFetch(`${API_BASE}/api/auth/me`, {})
        if (res.ok) router.replace("/history")
      } catch {
        // API not reachable yet — stay on login page
      }
    }
    check()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // -------------------------------------------------------------------------
  // Step 1 — password submit
  // -------------------------------------------------------------------------
  const handlePasswordSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!password) return

    setLoading(true)
    setError("")
    let hadError = false

    try {
      const res = await apiFetch(`${API_BASE}/api/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password }),
      })

      if (res.ok) {
        const body = await res.json()
        if (body.mfa_required) {
          // Server issued a ferret_pending cookie — show TOTP step.
          setMfaRequired(true)
          return
        }
        router.replace("/history")
        return
      }

      hadError = true
      if (res.status === 401) {
        setError("Incorrect password — try again.")
      } else {
        setError(`Unexpected error (${res.status}) — please try again.`)
      }
    } catch {
      hadError = true
      setError("Could not reach the API. Is Ferret running?")
    } finally {
      setLoading(false)
      if (hadError) {
        requestAnimationFrame(() => inputRef.current?.focus())
      }
    }
  }

  // -------------------------------------------------------------------------
  // Step 2 — TOTP challenge submit
  // -------------------------------------------------------------------------
  const handleOtpSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (otpCode.length !== 6) return

    setOtpLoading(true)
    setOtpError("")
    let hadError = false

    try {
      const res = await apiFetch(`${API_BASE}/api/auth/mfa/challenge`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code: otpCode }),
      })

      if (res.ok) {
        router.replace("/history")
        return
      }

      hadError = true
      if (res.status === 401) {
        const body = await res.json().catch(() => ({ detail: "Invalid code" }))
        setOtpError(body.detail ?? "Invalid code — try again.")
        setOtpCode("")
      } else {
        setOtpError(`Unexpected error (${res.status}) — please try again.`)
      }
    } catch {
      hadError = true
      setOtpError("Could not reach the API. Is Ferret running?")
    } finally {
      setOtpLoading(false)
      if (hadError) {
        requestAnimationFrame(() => otpRef.current?.focus())
      }
    }
  }

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------
  return (
    <div className="min-h-screen bg-neutral-950 flex items-center justify-center p-4">
      <div className="w-full max-w-sm">
        {/* Logo */}
        <div className="flex flex-col items-center mb-8 gap-3">
          <Image
            src="/ferret.png"
            alt="FERRET"
            width={48}
            height={48}
            className="rounded-lg"
            priority
          />
          <div className="text-center">
            <h1 className="text-orange-500 font-bold text-xl tracking-wider">FERRET</h1>
            <p className="text-neutral-500 text-xs mt-0.5">Forensic Analysis &amp; Request Tracker</p>
          </div>
        </div>

        {/* ------------------------------------------------------------------ */}
        {/* Step 1 — Password                                                   */}
        {/* ------------------------------------------------------------------ */}
        {!mfaRequired && (
          <div className="bg-neutral-900 border border-neutral-800 rounded-xl p-6 shadow-xl">
            <h2 className="text-neutral-200 font-semibold text-sm mb-5">Sign in to continue</h2>

            <form onSubmit={handlePasswordSubmit} className="space-y-4">
              {/* Password field */}
              <div className="space-y-1.5">
                <label htmlFor="password" className="text-neutral-400 text-xs font-medium">
                  Password
                </label>
                <div className="relative">
                  <input
                    ref={inputRef}
                    id="password"
                    type={showPw ? "text" : "password"}
                    value={password}
                    onChange={e => setPassword(e.target.value)}
                    placeholder="Enter your password"
                    autoComplete="current-password"
                    disabled={loading}
                    className="w-full bg-neutral-800 border border-neutral-700 rounded-lg px-3 py-2.5 pr-10
                               text-neutral-100 text-sm placeholder-neutral-600
                               focus:outline-none focus:ring-1 focus:ring-orange-500 focus:border-orange-500
                               disabled:opacity-50 disabled:cursor-not-allowed"
                  />
                  <button
                    type="button"
                    onClick={() => setShowPw(v => !v)}
                    tabIndex={-1}
                    className="absolute right-3 top-1/2 -translate-y-1/2 text-neutral-500 hover:text-neutral-300 transition-colors"
                    aria-label={showPw ? "Hide password" : "Show password"}
                  >
                    {showPw ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                  </button>
                </div>
              </div>

              {error && (
                <p className="text-red-400 text-xs">{error}</p>
              )}

              <button
                type="submit"
                disabled={loading || !password}
                className="w-full flex items-center justify-center gap-2 bg-orange-500 hover:bg-orange-600
                           disabled:opacity-50 disabled:cursor-not-allowed
                           text-white text-sm font-medium rounded-lg py-2.5 transition-colors"
              >
                {loading ? (
                  <span className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                ) : (
                  <LogIn className="w-4 h-4" />
                )}
                {loading ? "Signing in…" : "Sign in"}
              </button>
            </form>
          </div>
        )}

        {/* ------------------------------------------------------------------ */}
        {/* Step 2 — TOTP challenge                                             */}
        {/* ------------------------------------------------------------------ */}
        {mfaRequired && (
          <div className="bg-neutral-900 border border-neutral-800 rounded-xl p-6 shadow-xl">
            <div className="flex items-center gap-2 mb-1">
              <ShieldCheck className="w-4 h-4 text-orange-400" />
              <h2 className="text-neutral-200 font-semibold text-sm">Two-factor authentication</h2>
            </div>
            <p className="text-neutral-500 text-xs mb-5">
              Enter the 6-digit code from your authenticator app.
            </p>

            <form onSubmit={handleOtpSubmit} className="space-y-4">
              <div className="space-y-1.5">
                <label htmlFor="otp" className="text-neutral-400 text-xs font-medium">
                  Authentication code
                </label>
                <input
                  ref={otpRef}
                  id="otp"
                  type="text"
                  inputMode="numeric"
                  pattern="[0-9]{6}"
                  maxLength={6}
                  value={otpCode}
                  onChange={e => setOtpCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
                  placeholder="000000"
                  autoComplete="one-time-code"
                  disabled={otpLoading}
                  className="w-full bg-neutral-800 border border-neutral-700 rounded-lg px-3 py-2.5
                             text-neutral-100 text-sm text-center tracking-[0.4em] placeholder-neutral-600
                             focus:outline-none focus:ring-1 focus:ring-orange-500 focus:border-orange-500
                             disabled:opacity-50 disabled:cursor-not-allowed"
                />
              </div>

              {otpError && (
                <p className="text-red-400 text-xs">{otpError}</p>
              )}

              <button
                type="submit"
                disabled={otpLoading || otpCode.length !== 6}
                className="w-full flex items-center justify-center gap-2 bg-orange-500 hover:bg-orange-600
                           disabled:opacity-50 disabled:cursor-not-allowed
                           text-white text-sm font-medium rounded-lg py-2.5 transition-colors"
              >
                {otpLoading ? (
                  <span className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                ) : (
                  <ShieldCheck className="w-4 h-4" />
                )}
                {otpLoading ? "Verifying…" : "Verify"}
              </button>

              <button
                type="button"
                onClick={() => { setMfaRequired(false); setOtpCode(""); setOtpError(""); setPassword("") }}
                className="w-full text-neutral-500 hover:text-neutral-300 text-xs transition-colors"
              >
                ← Back to password
              </button>
            </form>
          </div>
        )}
      </div>
    </div>
  )
}
