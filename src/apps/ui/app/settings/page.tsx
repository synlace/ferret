"use client"

import { useState, useEffect } from "react"
import Link from "next/link"
import { Button } from "@/components/ui/button"
import {
  ShieldCheck,
  Download,
  CheckCircle,
  AlertCircle,
  Loader2,
  Cpu,
  Activity,
  ChevronDown,
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

export default function SettingsPage() {
  const [certStatus, setCertStatus] = useState<"idle" | "downloading" | "ok" | "error">("idle")
  const [certError, setCertError] = useState<string | null>(null)
  const [aiConfig, setAiConfig] = useState<{ provider?: string; model?: string } | null>(null)
  const [proxyStatus, setProxyStatus] = useState<ProxyStatus | null>(null)

  const [proxyOpen, setProxyOpen] = useState(true)
  const [certOpen, setCertOpen] = useState(true)
  const [aiOpen, setAiOpen] = useState(true)

  useEffect(() => {
    fetch(`${API_BASE}/api/setup`)
      .then(r => r.ok ? r.json() : null)
      .then(d => { if (d) setAiConfig({ provider: d.provider, model: d.model }) })
      .catch(() => {})
  }, [])

  useEffect(() => {
    const fetchProxy = async () => {
      try {
        const res = await fetch(`${API_BASE}/api/proxy/status`)
        if (res.ok) setProxyStatus(await res.json())
      } catch {
        // silently ignore
      }
    }
    fetchProxy()
    const id = setInterval(fetchProxy, 5000)
    return () => clearInterval(id)
  }, [])

  const downloadCert = async () => {
    setCertStatus("downloading")
    setCertError(null)
    try {
      const res = await fetch(`${API_BASE}/api/ca-cert`)
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

  return (
    <div className="flex flex-col h-full overflow-hidden bg-neutral-950 text-white">

      {/* Page header */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-neutral-800 flex-shrink-0 bg-neutral-900">
        <h1 className="text-sm font-bold text-white">Settings</h1>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto">

        {/* Proxy section */}
        <div className="border-b border-neutral-800">
          <SectionHeader
            icon={<Activity className="w-4 h-4 text-orange-400 flex-shrink-0" />}
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

        {/* CA Certificate section */}
        <div className="border-b border-neutral-800">
          <SectionHeader
            icon={<ShieldCheck className="w-4 h-4 text-orange-400 flex-shrink-0" />}
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
                  className="h-7 text-xs bg-orange-500 hover:bg-orange-600 text-white rounded-none"
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

        {/* AI Provider section */}
        <div className="border-b border-neutral-800">
          <SectionHeader
            icon={<Cpu className="w-4 h-4 text-orange-400 flex-shrink-0" />}
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
                  className="h-7 text-xs bg-orange-500 hover:bg-orange-600 text-white rounded-none"
                >
                  Re-run setup wizard
                </Button>
              </Link>
            </div>
          )}
        </div>

      </div>
    </div>
  )
}
