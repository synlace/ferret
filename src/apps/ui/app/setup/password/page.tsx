"use client"

import { useState, useRef, useEffect } from "react"
import Image from "next/image"
import { useRouter } from "next/navigation"
import { Eye, EyeOff, FileJson, Loader2, Upload, X } from "lucide-react"
import { apiFetch } from "@/lib/api-fetch"

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000"

const SETUP_PW_KEY = "ferret:setup:pw"

const steps = ["Password", "Provider", "Model", "Den", "Done"]

export default function SetupPasswordPage() {
  const router = useRouter()

  const [password, setPassword]             = useState("")
  const [confirmPassword, setConfirmPassword] = useState("")
  const [showPw, setShowPw]                 = useState(false)
  const [showConfirmPw, setShowConfirmPw]   = useState(false)
  const [pwError, setPwError]               = useState("")

  const [showImportModal, setShowImportModal] = useState(false)
  const [importFile, setImportFile] = useState<File | null>(null)
  const [passphrase, setPassphrase] = useState("")
  const [importError, setImportError] = useState<string | null>(null)
  const [importing, setImporting] = useState(false)

  const handleWizardImport = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!importFile) return
    setImporting(true)
    setImportError(null)

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
              passphrase: passphrase || undefined
            }),
          })

          if (!res.ok) {
            const d = await res.json()
            throw new Error(d.detail ?? "Import failed")
          }

          window.location.href = "/setup"
        } catch (err) {
          setImportError(err instanceof Error ? err.message : "Import failed")
          setImporting(false)
        }
      }
      reader.readAsDataURL(importFile)
    } catch (err) {
      setImportError("Failed to read the file.")
      setImporting(false)
    }
  }

  const passwordRef = useRef<HTMLInputElement>(null)
  useEffect(() => { passwordRef.current?.focus() }, [])

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setPwError("")
    if (password.length < 8) {
      setPwError("Password must be at least 8 characters.")
      return
    }
    if (password !== confirmPassword) {
      setPwError("Passwords do not match.")
      return
    }
    sessionStorage.setItem(SETUP_PW_KEY, password)
    router.push("/setup")
  }

  return (
    <div className="min-h-screen bg-neutral-950 flex flex-col items-center pt-4 pb-6 px-4 animate-fade-in">
      <div className="w-full max-w-lg">

        {/* Header */}
        <div className="flex items-center gap-3 mb-5">
          <Image src="/ferret.png" alt="Ferret" width={40} height={40} className="rounded-lg flex-shrink-0" />
          <div>
            <h1 className="text-xl font-bold text-white">Welcome to Ferret</h1>
            <p className="text-xs text-neutral-400">
              Set up your AI provider to get started
            </p>
          </div>
        </div>

        {/* Step indicator — step 0 active */}
        <div className="mb-4 flex items-center">
          {steps.map((label, i) => {
            const active = i === 0
            const done   = false
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
                  <span className={`text-[9px] ${active ? "text-brand-400" : "text-neutral-600"}`}>
                    {label}
                  </span>
                </div>
                {i < steps.length - 1 && (
                  <div className="flex-1 h-px mx-1.5 mb-3.5 bg-neutral-700" />
                )}
              </div>
            )
          })}
        </div>

        {/* Card */}
        <div className="rounded-xl border border-neutral-800 bg-neutral-900 p-5 shadow-2xl">
          <div className="mb-4 h-[44px] flex flex-col justify-center">
            <h2 className="text-base font-semibold text-white leading-tight">Set a Password</h2>
            <p className="mt-0.5 text-xs text-neutral-500 leading-tight">
              Protect your Ferret instance with a password. Minimum 8 characters.
            </p>
          </div>

          <form className="space-y-4" autoComplete="on" onSubmit={handleSubmit}>
            {/* Password */}
            <div className="space-y-1.5">
              <label className="block text-xs font-medium text-neutral-300">Password</label>
              <div className="relative">
                <input
                  ref={passwordRef}
                  type={showPw ? "text" : "password"}
                  value={password}
                  onChange={e => setPassword(e.target.value)}
                  placeholder="Min. 8 characters"
                  autoComplete="new-password"
                  className="w-full bg-neutral-800 border border-neutral-700 rounded-lg px-3 py-2.5 pr-10
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
                  className="w-full bg-neutral-800 border border-neutral-700 rounded-lg px-3 py-2.5 pr-10
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

            <div className="flex justify-end pt-1">
              <button
                type="submit"
                disabled={!password || !confirmPassword}
                className="rounded-md bg-brand-500 px-5 py-2 text-sm font-semibold text-neutral-900 hover:bg-brand-400 disabled:opacity-40 transition-colors"
              >
                Continue
              </button>
            </div>
          </form>
        </div>

        {/* Import existing backup profile button */}
        <button
          type="button"
          onClick={() => setShowImportModal(true)}
          className="mt-4 text-xs text-brand-400 hover:text-brand-300 flex items-center gap-1.5 transition-colors mx-auto animate-fade-in"
        >
          <FileJson className="w-3.5 h-3.5" />
          Import existing backup profile
        </button>

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

      {/* Import Backup Modal */}
      {showImportModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          {/* Backdrop */}
          <div 
            className="fixed inset-0 bg-black/80 backdrop-blur-sm cursor-pointer" 
            onClick={() => setShowImportModal(false)}
          />
          
          {/* Modal Content */}
          <div className="relative bg-neutral-900 border border-neutral-800 rounded-xl max-w-sm w-full p-5 space-y-4 shadow-2xl z-10 animate-fade-in">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-semibold text-white">Import Configuration</h3>
              <button onClick={() => setShowImportModal(false)} className="text-neutral-500 hover:text-neutral-300">
                <X className="w-4 h-4" />
              </button>
            </div>

            <form onSubmit={handleWizardImport} className="space-y-4">
              <p className="text-xs text-neutral-400">Select a Ferret config backup to restore API keys and AWS credentials.</p>
              
              <input
                type="file"
                accept=".json"
                onChange={e => setImportFile(e.target.files?.[0] ?? null)}
                className="block w-full text-xs text-neutral-400 file:mr-4 file:py-1 file:px-2 file:border file:border-neutral-800 file:text-xs file:font-semibold file:bg-neutral-900 file:text-neutral-200 hover:file:bg-neutral-800 cursor-pointer"
              />

              <div className="space-y-1">
                <label className="text-[10px] text-neutral-500 uppercase tracking-wider font-semibold">Passphrase (if encrypted)</label>
                <input
                  type="password"
                  placeholder="Decryption passphrase"
                  value={passphrase}
                  onChange={e => setPassphrase(e.target.value)}
                  className="w-full bg-neutral-800 border border-neutral-700 rounded-lg px-3 py-2 text-neutral-100 text-xs placeholder-neutral-600 focus:outline-none focus:ring-1 focus:ring-brand-500"
                />
              </div>

              {importError && (
                <div className="text-xs text-red-400 bg-red-950/20 border border-red-900 px-3 py-2 rounded">
                  {importError}
                </div>
              )}

              <button 
                type="submit" 
                disabled={!importFile || importing} 
                className="w-full rounded bg-brand-500 py-2 text-xs font-semibold text-neutral-900 hover:bg-brand-400 disabled:opacity-40 transition-colors flex items-center justify-center gap-1.5"
              >
                {importing ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Upload className="w-3.5 h-3.5" />}
                Restore Settings
              </button>
            </form>
          </div>
        </div>
      )}
    </div>
  )
}
