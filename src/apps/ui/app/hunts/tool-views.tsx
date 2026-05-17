"use client"

import React, { useState, useCallback, useRef, useEffect } from "react"
import { useRouter } from "next/navigation"
import {
  Terminal, Download, Copy, Check, ExternalLink, Columns2,
  Loader2, XCircle, CheckCircle, Sparkles,
} from "lucide-react"
import { DetailPanel, ApiRequest } from "@/app/history/DetailPanel"
import CodeMirror, { EditorView } from "@uiw/react-codemirror"
import { atomoneInit } from "@uiw/codemirror-theme-atomone"
import { StreamLanguage } from "@codemirror/language"
import { css as cssMode } from "@codemirror/legacy-modes/mode/css"
import { xml as xmlMode } from "@codemirror/legacy-modes/mode/xml"
import { javascript as jsMode } from "@codemirror/legacy-modes/mode/javascript"
import { python as pythonMode } from "@codemirror/legacy-modes/mode/python"
import { json } from "@codemirror/lang-json"
import { html } from "@codemirror/lang-html"
import { EditorState, Extension } from "@codemirror/state"

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000"

// ── CodeMirror theme (matches Gnaw / FileEditor) ─────────────────────────
const cmTheme = atomoneInit({
  settings: {
    background: "#0a0a0a",
    gutterBackground: "#171717",
    gutterForeground: "#525252",
    gutterBorder: "#262626",
    lineHighlight: "#1c1c1c",
    selection: "#264f78",
    fontFamily: "ui-monospace, 'JetBrains Mono', monospace",
  },
})

const cmOverrides = EditorView.theme({
  "&": { height: "100%", fontSize: "12px" },
  ".cm-editor": { height: "100%", backgroundColor: "#0a0a0a !important" },
  ".cm-scroller": { overflow: "auto", lineHeight: "1.6", backgroundColor: "#0a0a0a" },
  ".cm-content": { padding: "6px 0", backgroundColor: "#0a0a0a" },
  ".cm-focused": { outline: "none" },
  ".cm-lineNumbers .cm-gutterElement": { padding: "0 6px 0 4px", minWidth: "2.4rem" },
  "&.cm-focused .cm-selectionBackground, ::selection": { backgroundColor: "#264f78 !important" },
  ".cm-scroller::-webkit-scrollbar": { width: "6px", height: "6px" },
  ".cm-scroller::-webkit-scrollbar-track": { background: "transparent" },
  ".cm-scroller::-webkit-scrollbar-thumb": { background: "#3a3a3a", borderRadius: "3px" },
}, { dark: true })

/** Pick a CM6 language extension from a Content-Type string (mirrors Gnaw). */
function langExtFromContentType(ct: string | undefined | null): Extension {
  if (!ct) return []
  const lower = ct.toLowerCase()
  if (lower.includes("json")) return json()
  if (lower.includes("html")) return html()
  if (lower.includes("xml")) return StreamLanguage.define(xmlMode)
  if (lower.includes("css")) return StreamLanguage.define(cssMode)
  if (lower.includes("javascript") || lower.includes("ecmascript")) return StreamLanguage.define(jsMode)
  return []
}

/** Read-only CM6 pane — used for HTTP request/response display. */
function CmPane({ value, placeholder, lang }: { value: string; placeholder?: string; lang?: Extension }) {
  if (!value) {
    return (
      <div className="flex-1 flex items-center justify-center p-3">
        <span className="text-neutral-600 italic text-xs">{placeholder ?? "No data"}</span>
      </div>
    )
  }
  const extensions: Extension[] = [
    cmOverrides,
    EditorState.readOnly.of(true),
    EditorView.lineWrapping,
  ]
  if (lang) extensions.push(lang)
  return (
    <div className="flex-1 overflow-hidden">
      <CodeMirror
        value={value}
        theme={cmTheme}
        extensions={extensions}
        basicSetup={{ lineNumbers: true, foldGutter: false, highlightActiveLine: false }}
        style={{ height: "100%" }}
        editable={false}
      />
    </div>
  )
}

// ─── Meta suffix helpers ──────────────────────────────────────────────────────
const META_PREFIX = "\n__META__:"
const JSON_PREFIX = "\n__JSON__:"
export interface ToolMeta { exit_code?: number | null; runtime_ms?: number | null; timestamp?: string | null }
export function parseMeta(result: string | null): { output: string; meta: ToolMeta } {
  if (!result) return { output: "", meta: {} }
  const idx = result.lastIndexOf(META_PREFIX)
  if (idx === -1) return { output: result, meta: {} }
  try {
    const meta: ToolMeta = JSON.parse(result.slice(idx + META_PREFIX.length))
    return { output: result.slice(0, idx), meta }
  } catch { return { output: result, meta: {} } }
}
export function appendMeta(output: string, meta: ToolMeta): string {
  return output + META_PREFIX + JSON.stringify(meta)
}
/** Extract the __JSON__ structured payload appended by the API, or return null. */
function parseJsonSuffix<T>(output: string): T | null {
  const idx = output.lastIndexOf(JSON_PREFIX)
  if (idx === -1) return null
  try { return JSON.parse(output.slice(idx + JSON_PREFIX.length)) as T }
  catch { return null }
}
/** Strip the __JSON__ suffix so only the human-readable text remains. */
function stripJsonSuffix(output: string): string {
  const idx = output.lastIndexOf(JSON_PREFIX)
  return idx === -1 ? output : output.slice(0, idx)
}

// ─── cURL builder ─────────────────────────────────────────────────────────────
export function buildCurl(req: { method?: string; url?: string; headers?: Record<string, string>; body?: string | null }): string {
  const method = (req.method ?? "GET").toUpperCase()
  const parts = [`curl -X ${method} '${req.url ?? ""}'`]
  for (const [k, v] of Object.entries(req.headers ?? {})) {
    parts.push(`  -H '${k}: ${v}'`)
  }
  if (req.body) parts.push(`  -d '${req.body.replace(/'/g, "\\'")}'`)
  return parts.join(" \\\n")
}

// ─── Timestamp helper ─────────────────────────────────────────────────────────
export function formatTs(d?: Date | string | null): string {
  if (!d) return ""
  const dt = typeof d === "string" ? new Date(d) : d
  if (isNaN(dt.getTime())) return ""
  const yyyy = dt.getFullYear()
  const mm = String(dt.getMonth() + 1).padStart(2, "0")
  const dd = String(dt.getDate()).padStart(2, "0")
  const hh = String(dt.getHours()).padStart(2, "0")
  const min = String(dt.getMinutes()).padStart(2, "0")
  return `${yyyy}-${mm}-${dd} ${hh}:${min}`
}
export function nowTs(): string { return formatTs(new Date()) }

// ─── useDragResize ────────────────────────────────────────────────────────────
export function useDragResize(initialPct = 50): [number, React.HTMLAttributes<HTMLDivElement>] {
  const [pct, setPct] = useState(initialPct)
  const dragging = useRef(false)
  const containerRef = useRef<HTMLDivElement | null>(null)
  const onMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault(); dragging.current = true
    containerRef.current = (e.currentTarget as HTMLElement).parentElement as HTMLDivElement
    const onMove = (ev: MouseEvent) => {
      if (!dragging.current || !containerRef.current) return
      const rect = containerRef.current.getBoundingClientRect()
      setPct(Math.min(80, Math.max(20, ((ev.clientX - rect.left) / rect.width) * 100)))
    }
    const onUp = () => { dragging.current = false; window.removeEventListener("mousemove", onMove); window.removeEventListener("mouseup", onUp) }
    window.addEventListener("mousemove", onMove); window.addEventListener("mouseup", onUp)
  }, [])
  return [pct, { onMouseDown, style: { cursor: "col-resize" } }]
}

// ─── CopyButton ───────────────────────────────────────────────────────────────
export function CopyButton({ text, label }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <button
      onClick={() => { navigator.clipboard.writeText(text).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500) }) }}
      className="flex items-center gap-1 text-neutral-500 hover:text-neutral-300 transition-colors p-0.5 rounded text-[10px]"
    >
      {copied ? <Check className="w-3 h-3 text-green-400" /> : <Copy className="w-3 h-3" />}
      {label && <span>{copied ? "Copied" : label}</span>}
    </button>
  )
}

// ─── SplitPane ────────────────────────────────────────────────────────────────
// left/right are render-prop functions so SplitPane can inject the stack toggle
// into the left pane's header without an extra toolbar row.
function SplitPane({
  left, right, height = "h-48",
}: {
  left: (stackToggle: React.ReactNode) => React.ReactNode
  right: React.ReactNode
  height?: string
}) {
  const [splitPct, dragHandleProps] = useDragResize(50)
  const [stacked, setStacked] = useState(false)
  const stackToggle = (
    <button
      onClick={() => setStacked(s => !s)}
      className="flex items-center gap-1 text-[10px] text-neutral-500 hover:text-neutral-300 transition-colors px-1.5 py-0.5 rounded border border-neutral-700 hover:border-neutral-600"
      title={stacked ? "Side by side" : "Stack"}
    >
      <Columns2 className="w-3 h-3" />
    </button>
  )
  return (
    <div className={`border-t border-neutral-700/60 ${stacked ? "flex flex-col" : "flex"} ${height}`}>
      {stacked ? (
        <>
          <div className="flex-1 overflow-hidden border-b border-neutral-700/60">{left(stackToggle)}</div>
          <div className="flex-1 overflow-hidden">{right}</div>
        </>
      ) : (
        <>
          <div className="overflow-hidden" style={{ width: `${splitPct}%` }}>{left(stackToggle)}</div>
          <div className="w-px bg-neutral-700 hover:bg-orange-500/40 flex-shrink-0 transition-colors" {...dragHandleProps} />
          <div className="overflow-hidden flex-1">{right}</div>
        </>
      )}
    </div>
  )
}

// ─── Pane header ─────────────────────────────────────────────────────────────
function PaneHeader({ label, children }: { label: string; children?: React.ReactNode }) {
  return (
    <div className="flex items-center gap-2 px-3 py-1.5 border-b border-neutral-700/60 bg-neutral-900/40 flex-shrink-0">
      <span className="text-[10px] text-neutral-500 uppercase tracking-wider flex-1">{label}</span>
      {children}
    </div>
  )
}

// ─── XTermView ────────────────────────────────────────────────────────────────
// Renders terminal output using xterm.js. Accepts:
//   initialContent: full output string to write on mount (for loaded history)
//   registerWriter: called once the terminal is ready; receives a write(chunk)
//                   function so the parent can push chunks imperatively without
//                   storing them in React state (avoids O(n) array copies per chunk).
interface XTermViewProps {
  initialContent?: string
  registerWriter?: (write: (chunk: string) => void) => void
}
function XTermView({ initialContent, registerWriter }: XTermViewProps) {
  const containerRef = useRef<HTMLDivElement>(null)

  // Mount terminal once
  useEffect(() => {
    if (!containerRef.current) return
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let term: any = null
    let disposed = false
    ;(async () => {
      const { Terminal } = await import("@xterm/xterm")
      const { FitAddon } = await import("@xterm/addon-fit")
      if (disposed || !containerRef.current) return
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      term = new Terminal({
        theme: {
          background: "#0a0a0a",
          foreground: "#d4d4d4",
          cursor: "#f97316",
          selectionBackground: "#f9731640",
        },
        fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
        fontSize: 11,
        lineHeight: 1.4,
        convertEol: true,
        disableStdin: true,
        scrollback: 5000,
        cursorStyle: "bar",
        cursorBlink: false,
      })
      const fit = new FitAddon()
      term.loadAddon(fit)
      term.open(containerRef.current)
      fit.fit()
      // Write initial content (history load)
      if (initialContent) term.write(initialContent)
      // Register the imperative write callback so the parent can push chunks
      // directly without going through React state.
      if (registerWriter) registerWriter((chunk: string) => term.write(chunk))
    })()
    return () => {
      disposed = true
      if (term) term.dispose()
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return <div ref={containerRef} className="flex-1 min-h-0 overflow-hidden bg-[#0a0a0a]" />
}

// ─── RunScriptView ────────────────────────────────────────────────────────────
export function RunScriptView({ toolArgsRaw, result, registerWriter }: { toolArgsRaw?: string; result: string | null; registerWriter?: (write: (chunk: string) => void) => void }) {
  const { output } = parseMeta(result)
  let scriptSrc = ""
  try { const a = JSON.parse(toolArgsRaw ?? "{}"); scriptSrc = a.command ?? a.script ?? "" } catch { /**/ }

  const left = (stackToggle: React.ReactNode) => (
    <div className="flex flex-col h-full min-w-0">
      <PaneHeader label="Script">
        <CopyButton text={scriptSrc} />
        {stackToggle}
      </PaneHeader>
      <pre className="flex-1 overflow-y-auto p-3 text-xs font-mono text-neutral-300 bg-neutral-950 whitespace-pre-wrap">
        {scriptSrc || <span className="text-neutral-600 italic">No source</span>}
      </pre>
    </div>
  )
  const right = (
    <div className="flex flex-col h-full min-w-0">
      <PaneHeader label="Output">
        {output && <CopyButton text={output} />}
        {output && (
          <button
            onClick={() => {
              const blob = new Blob([output], { type: "text/plain" })
              const url = URL.createObjectURL(blob); const a = document.createElement("a")
              a.href = url; a.download = "output.txt"; a.click(); URL.revokeObjectURL(url)
            }}
            className="flex items-center gap-1 text-neutral-500 hover:text-neutral-300 transition-colors p-0.5 rounded text-[10px]"
            title="Download output"
          >
            <Download className="w-3 h-3" />
          </button>
        )}
      </PaneHeader>
      <XTermView initialContent={output || undefined} registerWriter={registerWriter} />
    </div>
  )
  return <SplitPane left={left} right={right} height="h-72" />
}

// ─── RunFfufView ──────────────────────────────────────────────────────────────
export function RunFfufView({ toolArgsRaw, result, registerWriter }: { toolArgsRaw?: string; result: string | null; registerWriter?: (write: (chunk: string) => void) => void }) {
  const { output } = parseMeta(result)
  let ffufArgs: Record<string, unknown> = {}
  try { ffufArgs = JSON.parse(toolArgsRaw ?? "{}") } catch { /**/ }
  const parts: string[] = ["ffuf"]
  if (ffufArgs.url) parts.push(`-u '${ffufArgs.url}'`)
  if (ffufArgs.wordlist) parts.push(`-w '${ffufArgs.wordlist}'`)
  if (ffufArgs.method && ffufArgs.method !== "GET") parts.push(`-X ${ffufArgs.method}`)
  if (ffufArgs.headers && typeof ffufArgs.headers === "object") {
    for (const [k, v] of Object.entries(ffufArgs.headers as Record<string, string>)) {
      parts.push(`-H '${k}: ${v}'`)
    }
  }
  if (ffufArgs.data) parts.push(`-d '${ffufArgs.data}'`)
  if (ffufArgs.flags) parts.push(String(ffufArgs.flags))
  const ffufCmd = parts.join(" \\\n  ")

  const left = (stackToggle: React.ReactNode) => (
    <div className="flex flex-col h-full min-w-0">
      <PaneHeader label="Command">
        <CopyButton text={ffufCmd} label="Copy" />
        {stackToggle}
      </PaneHeader>
      <pre className="flex-1 overflow-y-auto p-3 text-xs font-mono text-neutral-300 bg-neutral-950 whitespace-pre-wrap">
        {ffufCmd || <span className="text-neutral-600 italic">No command</span>}
      </pre>
    </div>
  )
  const right = (
    <div className="flex flex-col h-full min-w-0">
      <PaneHeader label="Output">
        {output && <CopyButton text={output} />}
      </PaneHeader>
      <XTermView initialContent={output || undefined} registerWriter={registerWriter} />
    </div>
  )
  return <SplitPane left={left} right={right} height="h-72" />
}

// ─── RequestDetailView ────────────────────────────────────────────────────────
export function RequestDetailView({ toolArgsRaw, result }: { toolArgsRaw?: string; result: string | null }) {
  const router = useRouter()
  const { output } = parseMeta(result)
  // Try structured JSON suffix first (appended by API), fall back to legacy JSON parse
  const raw = parseJsonSuffix<Record<string, unknown>>(output) ?? (() => {
    try { return JSON.parse(output) as Record<string, unknown> } catch { return {} }
  })()

  const urlObj = (() => { try { return new URL(String(raw.url ?? "")) } catch { return null } })()

  const req: ApiRequest = {
    seq: null,
    id: String(raw.id ?? ""),
    timestamp: "",
    method: String(raw.method ?? "GET"),
    url: String(raw.url ?? ""),
    host: String(raw.host ?? urlObj?.host ?? ""),
    path: urlObj ? urlObj.pathname + urlObj.search : String(raw.url ?? ""),
    status_code: raw.status_code != null ? Number(raw.status_code) : null,
    response_time: null,
    response_size: null,
    headers: (raw.headers ?? null) as Record<string, string> | null,
    body: raw.body != null ? String(raw.body) : null,
    response_headers: (raw.response_headers ?? null) as Record<string, string> | null,
    response_body: raw.response_body != null ? String(raw.response_body) : null,
    annotation: null,
    source: "tool",
  }

  const sendToGnaw = async () => {
    const hdrs = (raw.headers ?? {}) as Record<string, string>
    const headerLines = Object.entries(hdrs)
      .filter(([k]) => k.toLowerCase() !== "host")
      .map(([k, v]) => `${k}: ${v}`)
      .join("\n")
    let reqPath = "/"
    try { const p = new URL(String(raw.url ?? "")); reqPath = p.pathname + p.search } catch { reqPath = "/" }
    const rawRequest = [
      `${req.method} ${reqPath} HTTP/1.1`,
      `Host: ${req.host}`,
      ...(headerLines ? [headerLines] : []),
      "",
      req.body ?? "",
    ].join("\n")
    const label = `${req.method} ${req.host}`
    const res = await fetch(`${API_BASE}/api/gnaw/tabs`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ raw_request: rawRequest, label }),
    }).catch(() => null)
    router.push(res?.ok ? `/gnaw?tab=${(await res.json()).id}` : "/gnaw")
  }

  return (
    <div className="h-72">
      <DetailPanel request={req} onAnnotate={() => {}} annotating={null} maximized={true} onSendToGnaw={sendToGnaw} />
    </div>
  )
}

// ─── HttpRequestView ──────────────────────────────────────────────────────────
export function HttpRequestView({ toolArgsRaw, result }: { toolArgsRaw?: string; result: string | null }) {
  const router = useRouter()
  const { output } = parseMeta(result)
  let reqArgs: Record<string, unknown> = {}
  let respData: Record<string, unknown> | null = null
  try { reqArgs = JSON.parse(toolArgsRaw ?? "{}") } catch { /**/ }
  try { respData = JSON.parse(output) } catch { /**/ }

  // Fallback: result is in-flight (null), a plain-text error string from the backend
  // (e.g. "[FERRET] HTTP request failed: ..."), or an old pre-JSON-format record.
  // In all these cases JSON.parse fails and respData stays null — render raw text
  // instead of passing a structurally-incomplete ApiRequest to DetailPanel.
  if (!respData || respData.status_code == null) {
    return (
      <div className="border-t border-neutral-700/60 px-3 py-2">
        <pre className="text-neutral-300 whitespace-pre-wrap break-all font-mono text-[11px] max-h-64 overflow-y-auto">
          {output || "— waiting for response —"}
        </pre>
      </div>
    )
  }

  const method = String(reqArgs.method ?? "GET")
  const url = String(reqArgs.url ?? "")
  const urlObj = (() => { try { return new URL(url) } catch { return null } })()
  const host = urlObj?.host ?? ""
  const path = urlObj ? urlObj.pathname + urlObj.search : url

  const statusCode = respData.status_code ?? respData.status ?? null
  const respHeaders = (respData.headers ?? respData.response_headers ?? {}) as Record<string, string>
  const respBody = respData.body ?? respData.response_body ?? null

  const req: ApiRequest = {
    seq: null,
    id: "",
    timestamp: "",
    method,
    url,
    host,
    path,
    status_code: statusCode != null ? Number(statusCode) : null,
    response_time: respData.elapsed_ms != null ? Number(respData.elapsed_ms) : null,
    response_size: null,
    headers: (reqArgs.headers ?? null) as Record<string, string> | null,
    body: reqArgs.body != null ? String(reqArgs.body) : null,
    response_headers: Object.keys(respHeaders).length ? respHeaders : null,
    response_body: respBody != null ? String(respBody) : null,
    annotation: null,
    source: "tool",
  }

  const sendToGnaw = async () => {
    const hdrs = (reqArgs.headers ?? {}) as Record<string, string>
    const headerLines = Object.entries(hdrs)
      .filter(([k]) => k.toLowerCase() !== "host")
      .map(([k, v]) => `${k}: ${v}`)
      .join("\n")
    const rawRequest = [
      `${method} ${path} HTTP/1.1`,
      ...(host ? [`Host: ${host}`] : []),
      ...(headerLines ? [headerLines] : []),
      "",
      req.body ?? "",
    ].join("\n")
    const label = `${method} ${host || url}`
    const res = await fetch(`${API_BASE}/api/gnaw/tabs`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ raw_request: rawRequest, label }),
    }).catch(() => null)
    router.push(res?.ok ? `/gnaw?tab=${(await res.json()).id}` : "/gnaw")
  }

  return (
    <div className="h-72">
      <DetailPanel request={req} onAnnotate={() => {}} annotating={null} maximized={true} onSendToGnaw={sendToGnaw} />
    </div>
  )
}

// ─── WriteTestView ────────────────────────────────────────────────────────────
// Left: CM6 Python editor (read-only) showing the generated test code.
// Right: CM6 pane showing the pytest result output.
export function WriteTestView({ toolArgsRaw, result }: { toolArgsRaw?: string; result: string | null }) {
  const { output } = parseMeta(result)
  let filename = "test_generated.py"
  let code = ""
  try {
    const a = JSON.parse(toolArgsRaw ?? "{}")
    filename = a.filename ?? filename
    code = a.code ?? ""
  } catch { /**/ }

  const pythonExt = StreamLanguage.define(pythonMode)

  const left = (stackToggle: React.ReactNode) => (
    <div className="flex flex-col h-full min-w-0">
      <PaneHeader label={filename}>
        <CopyButton text={code} />
        {stackToggle}
      </PaneHeader>
      <CmPane value={code} placeholder="No code generated" lang={pythonExt} />
    </div>
  )

  const right = (
    <div className="flex flex-col h-full min-w-0">
      <PaneHeader label="Output">
        {output && <CopyButton text={output} />}
      </PaneHeader>
      <pre className="flex-1 overflow-y-auto p-3 text-xs font-mono text-neutral-300 bg-neutral-950 whitespace-pre-wrap leading-relaxed">
        {output || <span className="text-neutral-600 italic">No output yet</span>}
      </pre>
    </div>
  )

  return <SplitPane left={left} right={right} height="h-72" />
}

// ─── RunTestView ──────────────────────────────────────────────────────────────
// Left: filename + command summary. Right: plain pre with word-wrap.
export function RunTestView({ toolArgsRaw, result }: { toolArgsRaw?: string; result: string | null }) {
  const { output } = parseMeta(result)
  let filename = ""
  try { filename = JSON.parse(toolArgsRaw ?? "{}").filename ?? "" } catch { /**/ }
  const command = filename ? `pytest ${filename}` : "pytest"

  const left = (stackToggle: React.ReactNode) => (
    <div className="flex flex-col h-full min-w-0">
      <PaneHeader label="Command">
        <CopyButton text={command} label="Copy" />
        {stackToggle}
      </PaneHeader>
      <pre className="flex-1 overflow-y-auto p-3 text-xs font-mono text-neutral-300 bg-neutral-950 whitespace-pre-wrap">
        {command || <span className="text-neutral-600 italic">No command</span>}
      </pre>
    </div>
  )

  const right = (
    <div className="flex flex-col h-full min-w-0">
      <PaneHeader label="Output">
        {output && <CopyButton text={output} />}
      </PaneHeader>
      <pre className="flex-1 overflow-y-auto p-3 text-xs font-mono text-neutral-300 bg-neutral-950 whitespace-pre-wrap leading-relaxed">
        {output || <span className="text-neutral-600 italic">No output yet</span>}
      </pre>
    </div>
  )

  return <SplitPane left={left} right={right} height="h-72" />
}

// ─── SearchRequestsView ───────────────────────────────────────────────────────
interface SearchRow {
  id?: string; method?: string; url?: string; host?: string; path?: string
  status_code?: number | null; response_time?: number | null; response_size?: number | null
}

const PAGE_SIZE = 20

export function SearchRequestsView({ result }: { result: string | null }) {
  const router = useRouter()
  const [page, setPage] = useState(0)
  const { output } = parseMeta(result)
  // Try structured JSON suffix first (appended by API), fall back to legacy JSON parse
  const jsonRows = parseJsonSuffix<SearchRow[]>(output)
  let rows: SearchRow[] = []
  if (jsonRows && Array.isArray(jsonRows)) {
    rows = jsonRows
  } else {
    try {
      const parsed = JSON.parse(output)
      rows = Array.isArray(parsed) ? parsed : (parsed.results ?? parsed.items ?? [])
    } catch { /**/ }
  }
  const rawText = stripJsonSuffix(output)
  const totalPages = Math.ceil(rows.length / PAGE_SIZE)
  const pageRows = rows.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE)

  const sendToGnaw = async (row: SearchRow) => {
    // SearchRow has no headers/body — build minimal raw request from available fields
    const rawPath = row.path ?? "/"
    const rawRequest = [
      `${row.method ?? "GET"} ${rawPath} HTTP/1.1`,
      `Host: ${row.host ?? ""}`,
      "",
      "",
    ].join("\n")
    const label = `${row.method ?? "GET"} ${row.host ?? ""}`
    const res = await fetch(`${API_BASE}/api/gnaw/tabs`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ raw_request: rawRequest, label }),
    }).catch(() => null)
    if (res?.ok) {
      const tab = await res.json()
      router.push(`/gnaw?tab=${tab.id}`)
    } else {
      router.push("/gnaw")
    }
  }

  if (!rows.length) {
    return (
      <div className="border-t border-neutral-700/60 px-3 py-2 text-xs text-neutral-500 italic">
        {rawText || "No results"}
      </div>
    )
  }

  return (
    <div className="border-t border-neutral-700/60">
      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="border-b border-neutral-700/60 bg-neutral-900/40">
              <th className="text-left px-3 py-1.5 text-[10px] text-neutral-500 uppercase tracking-wider font-medium">Method</th>
              <th className="text-left px-3 py-1.5 text-[10px] text-neutral-500 uppercase tracking-wider font-medium">URL</th>
              <th className="text-left px-3 py-1.5 text-[10px] text-neutral-500 uppercase tracking-wider font-medium">Status</th>
              <th className="text-left px-3 py-1.5 text-[10px] text-neutral-500 uppercase tracking-wider font-medium">Size</th>
              <th className="px-3 py-1.5" />
            </tr>
          </thead>
          <tbody>
            {pageRows.map((row, i) => (
              <tr key={i} className="border-b border-neutral-800/60 hover:bg-neutral-800/30 transition-colors">
                <td className="px-3 py-1.5">
                  <span className={`font-mono font-bold text-[10px] ${row.method === "GET" ? "text-green-400" : row.method === "POST" ? "text-blue-400" : "text-orange-400"}`}>{row.method ?? "—"}</span>
                </td>
                <td className="px-3 py-1.5 max-w-[200px]">
                  <span className="text-neutral-400 truncate block font-mono text-[10px]">{row.host ?? ""}</span>
                  <span className="text-neutral-200 truncate block font-mono">{row.path ?? row.url ?? ""}</span>
                </td>
                <td className="px-3 py-1.5">
                  {row.status_code != null && (
                    <span className={`font-mono text-[10px] ${row.status_code < 300 ? "text-green-400" : row.status_code < 500 ? "text-yellow-400" : "text-red-400"}`}>{row.status_code}</span>
                  )}
                </td>
                <td className="px-3 py-1.5 text-neutral-500 font-mono text-[10px]">
                  {row.response_size != null
                    ? row.response_size >= 1024
                      ? `${(row.response_size / 1024).toFixed(1)}k`
                      : `${row.response_size}b`
                    : "—"}
                </td>
                <td className="px-3 py-1.5">
                  <button
                    onClick={() => sendToGnaw(row)}
                    className="text-neutral-600 hover:text-blue-400 transition-colors"
                    title="Send to Gnaw"
                  >
                    <ExternalLink className="w-3 h-3" />
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {totalPages > 1 && (
        <div className="flex items-center justify-between px-3 py-1.5 border-t border-neutral-800/60 bg-neutral-900/20">
          <span className="text-[10px] text-neutral-600">{rows.length} results</span>
          <div className="flex items-center gap-1">
            <button
              onClick={() => setPage(p => Math.max(0, p - 1))}
              disabled={page === 0}
              className="text-[10px] px-1.5 py-0.5 rounded border border-neutral-700 text-neutral-500 hover:text-neutral-300 disabled:opacity-30 disabled:cursor-not-allowed"
            >←</button>
            <span className="text-[10px] text-neutral-500">{page + 1}/{totalPages}</span>
            <button
              onClick={() => setPage(p => Math.min(totalPages - 1, p + 1))}
              disabled={page >= totalPages - 1}
              className="text-[10px] px-1.5 py-0.5 rounded border border-neutral-700 text-neutral-500 hover:text-neutral-300 disabled:opacity-30 disabled:cursor-not-allowed"
            >→</button>
          </div>
        </div>
      )}
    </div>
  )
}

// ─── CreateFindingView ────────────────────────────────────────────────────────
// Renders a styled finding card from the create_finding tool call.
// Args: { title, severity, host, description, request_id? }
// Result: JSON string of the created finding, or a plain text confirmation.
const SEVERITY_STYLES: Record<string, { bg: string; border: string; text: string; dot: string }> = {
  critical: { bg: "bg-red-950/60",    border: "border-red-700",    text: "text-red-300",    dot: "bg-red-500" },
  high:     { bg: "bg-orange-950/60", border: "border-orange-700", text: "text-orange-300", dot: "bg-orange-500" },
  medium:   { bg: "bg-yellow-950/60", border: "border-yellow-700", text: "text-yellow-300", dot: "bg-yellow-500" },
  low:      { bg: "bg-blue-950/60",   border: "border-blue-700",   text: "text-blue-300",   dot: "bg-blue-500" },
  info:     { bg: "bg-neutral-900",   border: "border-neutral-700", text: "text-neutral-400", dot: "bg-neutral-500" },
}

export function CreateFindingView({ toolArgsRaw, result }: { toolArgsRaw?: string; result: string | null }) {
  const { output } = parseMeta(result)

  // Parse args (what the AI sent)
  let args: Record<string, unknown> = {}
  try { args = JSON.parse(toolArgsRaw ?? "{}") } catch { /**/ }

  // Try to get confirmed data from result JSON (what the API stored)
  let confirmed: Record<string, unknown> = {}
  try { confirmed = JSON.parse(output) } catch { /**/ }

  const title       = String(confirmed.title       ?? args.title       ?? "Untitled Finding")
  const severity    = String(confirmed.severity     ?? args.severity    ?? "info").toLowerCase()
  const host        = String(confirmed.host         ?? args.host        ?? "")
  const description = String(confirmed.description  ?? args.description ?? "")
  const status      = String(confirmed.status       ?? "open")
  const id          = String(confirmed.id           ?? "")

  const sev = SEVERITY_STYLES[severity] ?? SEVERITY_STYLES.info

  return (
    <div className="border-t border-neutral-700/60 p-3">
      <div className={`rounded border ${sev.border} ${sev.bg} p-3 space-y-2`}>
        {/* Header row: severity dot + title + status badge */}
        <div className="flex items-start gap-2">
          <span className={`mt-1.5 w-2 h-2 rounded-full flex-shrink-0 ${sev.dot}`} />
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-sm font-semibold text-white leading-tight">{title}</span>
              <span className={`text-[10px] font-bold uppercase px-1.5 py-0.5 rounded ${sev.text} border ${sev.border}`}>
                {severity}
              </span>
              <span className="text-[10px] text-neutral-500 border border-neutral-700 px-1.5 py-0.5 rounded">
                {status}
              </span>
            </div>
            {host && (
              <div className="text-[11px] text-neutral-400 font-mono mt-0.5">{host}</div>
            )}
          </div>
          {id && <CopyButton text={id} label="ID" />}
        </div>

        {/* Description */}
        {description && (
          <p className="text-xs text-neutral-300 leading-relaxed whitespace-pre-wrap pl-4">
            {description}
          </p>
        )}
      </div>
    </div>
  )
}

// ─── ToolGroup ────────────────────────────────────────────────────────────────
export interface ToolGroupProps {
  toolName: string
  toolArgs: string
  toolArgsRaw?: string
  result: string | null
  isRunning: boolean
  persistKey?: string
  forceOpen?: boolean
  exitCode?: number | null
  runtimeMs?: number | null
  /** Imperative writer registration — passed to XTermView for streaming tools.
   *  Avoids storing chunks in React state. */
  registerWriter?: (write: (chunk: string) => void) => void
  /** Controlled collapse state — when provided, overrides local state */
  collapsedOverride?: boolean
  /** Called when the user toggles; receives the new collapsed value */
  onToggle?: (key: string, collapsed: boolean) => void
  /** AI rationale — the text the model emitted before calling this tool */
  rationale?: string
}

export function ToolGroup({ toolName, toolArgs, toolArgsRaw, result, isRunning, persistKey, forceOpen, exitCode, runtimeMs, registerWriter, collapsedOverride, onToggle, rationale }: ToolGroupProps) {
  const controlled = collapsedOverride !== undefined
  const [localCollapsed, setLocalCollapsed] = useState(() => {
    if (forceOpen) return false
    if (!persistKey) return true
    try { return localStorage.getItem(`tg:${persistKey}`) !== "0" } catch { return true }
  })
  const collapsed = controlled ? collapsedOverride : localCollapsed
  const toggle = () => {
    const next = !collapsed
    if (controlled && persistKey && onToggle) {
      onToggle(persistKey, next)
    } else {
      setLocalCollapsed(next)
      if (persistKey) { try { localStorage.setItem(`tg:${persistKey}`, next ? "1" : "0") } catch { /**/ } }
    }
  }

  // Status icon: spinner while running, green tick (exit 0), red X (exit non-0), grey terminal (no exit info)
  const statusIcon = isRunning
    ? <Loader2 className="w-3 h-3 animate-spin text-orange-400 flex-shrink-0" />
    : exitCode === 0
      ? <CheckCircle className="w-3 h-3 text-green-400 flex-shrink-0" />
      : exitCode != null
        ? <XCircle className="w-3 h-3 text-red-400 flex-shrink-0" />
        : result
          ? <CheckCircle className="w-3 h-3 text-green-400/60 flex-shrink-0" />
          : <Terminal className="w-3 h-3 text-neutral-500 flex-shrink-0" />

  const runtimeLabel = runtimeMs != null
    ? runtimeMs >= 1000 ? `${(runtimeMs / 1000).toFixed(1)}s` : `${runtimeMs}ms`
    : null

  return (
    <div className="border border-neutral-700 rounded bg-neutral-900/60 text-xs my-1">
      <button
        onClick={toggle}
        className="w-full flex items-center gap-2 px-3 py-1.5 text-left hover:bg-neutral-800/40 transition-colors"
      >
        {statusIcon}
        <span className="text-orange-300 font-mono">{toolName}</span>
        <span className="text-neutral-400 truncate flex-1">{toolArgs}</span>
        {runtimeLabel && <span className="text-neutral-600 text-[10px] flex-shrink-0 font-mono">{runtimeLabel}</span>}
        {collapsed
          ? <ChevronRight className="w-3 h-3 text-neutral-600 flex-shrink-0" />
          : <ChevronDown className="w-3 h-3 text-neutral-600 flex-shrink-0" />}
      </button>
      {!collapsed && (
        <>
          {rationale && (
            <div className="border-t border-neutral-700/60 bg-neutral-950 px-3 py-2">
              <p className="text-xs text-neutral-300 leading-relaxed whitespace-pre-wrap">
                <Sparkles className="w-3 h-3 text-yellow-400 inline mr-1.5 flex-shrink-0 align-middle" />
                <span className="text-[10px] font-semibold text-yellow-400 uppercase tracking-wider mr-1.5">Rationale:</span>
                {rationale}
              </p>
            </div>
          )}
          {renderBody(toolName, toolArgsRaw, result, isRunning, registerWriter)}
        </>
      )}
    </div>
  )
}

function ChevronRight({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
    </svg>
  )
}
function ChevronDown({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
    </svg>
  )
}

function renderBody(toolName: string, toolArgsRaw: string | undefined, result: string | null, isRunning: boolean, registerWriter?: (write: (chunk: string) => void) => void) {
  if (toolName === "run_script" || toolName === "run_command") {
    return <RunScriptView toolArgsRaw={toolArgsRaw} result={result} registerWriter={registerWriter} />
  }
  if (toolName === "run_ffuf") {
    return <RunFfufView toolArgsRaw={toolArgsRaw} result={result} registerWriter={registerWriter} />
  }
  if (toolName === "get_request_detail") {
    return <RequestDetailView toolArgsRaw={toolArgsRaw} result={result} />
  }
  if (toolName === "http_request") {
    return <HttpRequestView toolArgsRaw={toolArgsRaw} result={result} />
  }
  if (toolName === "write_test" || toolName === "write_pytest_file") {
    return <WriteTestView toolArgsRaw={toolArgsRaw} result={result} />
  }
  if (toolName === "run_test" || toolName === "run_pytest_file") {
    return <RunTestView toolArgsRaw={toolArgsRaw} result={result} />
  }
  if (toolName === "create_finding") {
    return <CreateFindingView toolArgsRaw={toolArgsRaw} result={result} />
  }
  if (toolName === "search_requests") {
    return <SearchRequestsView result={result} />
  }
  // Default: show raw args + result
  const { output } = parseMeta(result)
  return (
    <div className="border-t border-neutral-700/60 px-3 py-2 space-y-2">
      {toolArgsRaw && (
        <div>
          <div className="text-neutral-500 text-[10px] uppercase tracking-wider mb-1">Args</div>
          <pre className="text-neutral-300 whitespace-pre-wrap break-all font-mono text-[11px]">{toolArgsRaw}</pre>
        </div>
      )}
      {output && (
        <div>
          <div className="flex items-center justify-between mb-1">
            <span className="text-neutral-500 text-[10px] uppercase tracking-wider">Result</span>
            <CopyButton text={output} />
          </div>
          <pre className="text-neutral-300 whitespace-pre-wrap break-all font-mono text-[11px] max-h-64 overflow-y-auto">{output}</pre>
        </div>
      )}
      {isRunning && !output && <div className="text-neutral-500 italic">Running...</div>}
    </div>
  )
}