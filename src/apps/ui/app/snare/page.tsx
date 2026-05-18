"use client"

import { apiFetch } from "@/lib/api-fetch"

import {
  useEffect, useState, useRef, useCallback, useMemo, useLayoutEffect,
} from "react"
import { Button } from "@/components/ui/button"
import {
  Play, Pause, Plus, X, Send, Trash2, ShieldAlert, Filter,
  Copy, Check, Link,
} from "lucide-react"
import CodeMirror, { EditorView } from "@uiw/react-codemirror"
import { atomoneInit } from "@uiw/codemirror-theme-atomone"
import { StreamLanguage } from "@codemirror/language"
import { http as httpMode } from "@codemirror/legacy-modes/mode/http"
import { css as cssMode } from "@codemirror/legacy-modes/mode/css"
import { xml as xmlMode } from "@codemirror/legacy-modes/mode/xml"
import { javascript as jsMode } from "@codemirror/legacy-modes/mode/javascript"
import { json } from "@codemirror/lang-json"
import { html } from "@codemirror/lang-html"
import { html as beautifyHtml, js as beautifyJs, css as beautifyCss } from "js-beautify"

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000"
const WS_BASE = API_BASE.replace(/^http/, "ws")

// ── CodeMirror theme (matches gnaw / history) ─────────────────────────────────

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

const baseExtensions = [cmTheme, cmOverrides, EditorView.lineWrapping]

// ── Language / beautify helpers ───────────────────────────────────────────────

function langExtFromContentType(ct: string | undefined | null) {
  if (!ct) return StreamLanguage.define(httpMode)
  const lower = ct.toLowerCase()
  if (lower.includes("json")) return json()
  if (lower.includes("html")) return html()
  if (lower.includes("xml")) return StreamLanguage.define(xmlMode)
  if (lower.includes("css")) return StreamLanguage.define(cssMode)
  if (lower.includes("javascript") || lower.includes("ecmascript")) return StreamLanguage.define(jsMode)
  return []
}

function beautifyBody(body: string, ct: string | undefined | null): string {
  if (!body.trim()) return body
  const lower = (ct ?? "").toLowerCase()
  try {
    if (lower.includes("json")) {
      try { return JSON.stringify(JSON.parse(body), null, 2) } catch { /* fall through */ }
      return beautifyJs(body, { indent_size: 2, brace_style: "collapse" })
    }
    if (lower.includes("html")) return beautifyHtml(body, { indent_size: 2, wrap_line_length: 0 })
    if (lower.includes("xml")) return beautifyHtml(body, { indent_size: 2, wrap_line_length: 0 })
    if (lower.includes("css")) return beautifyCss(body, { indent_size: 2 })
    if (lower.includes("javascript") || lower.includes("ecmascript")) return beautifyJs(body, { indent_size: 2 })
  } catch { /* leave as-is */ }
  return body
}

// ── Types ─────────────────────────────────────────────────────────────────────

interface InterceptedRequest {
  id: string
  method: string
  url: string
  host: string
  path: string
  headers: Record<string, string>
  body: string | null
  timestamp: string
}

interface ResponseData {
  status_code: number
  response_headers: Record<string, string>
  response_body: string
  response_time: number | null
}

interface SnareRule {
  id: string
  name: string
  enabled: boolean
  method: string | null
  host_pattern: string | null
  path_pattern: string | null
  body_pattern: string | null
  action: string
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function requestToRaw(req: InterceptedRequest): string {
  const firstLine = `${req.method} ${req.path || "/"} HTTP/1.1`
  const hostLine = `Host: ${req.host}`
  const otherHeaders = Object.entries(req.headers || {})
    .filter(([k]) => k.toLowerCase() !== "host")
    .map(([k, v]) => `${k}: ${v}`)
    .join("\n")
  const headerBlock = otherHeaders ? `${hostLine}\n${otherHeaders}` : hostLine
  return req.body
    ? `${firstLine}\n${headerBlock}\n\n${req.body}`
    : `${firstLine}\n${headerBlock}\n\n`
}

function buildRawResponse(resp: ResponseData): string {
  const statusLine = `HTTP/1.1 ${resp.status_code}`
  const ct = resp.response_headers
    ? Object.entries(resp.response_headers).find(([k]) => k.toLowerCase() === "content-type")?.[1] ?? null
    : null
  const headerLines = Object.entries(resp.response_headers || {}).map(([k, v]) => `${k}: ${v}`).join("\n")
  const body = beautifyBody(resp.response_body ?? "", ct)
  const parts = [statusLine]
  if (headerLines) parts.push(headerLines)
  parts.push("")
  if (body) parts.push(body)
  return parts.join("\n")
}

function methodColor(method: string): string {
  switch (method.toUpperCase()) {
    case "GET": return "text-blue-400"
    case "POST": return "text-green-400"
    case "PUT": return "text-yellow-400"
    case "DELETE": return "text-red-400"
    case "PATCH": return "text-purple-400"
    default: return "text-neutral-400"
  }
}

function statusColor(sc: number): string {
  if (sc < 300) return "text-green-400"
  if (sc < 400) return "text-yellow-400"
  return "text-red-400"
}

function buildCurl(req: InterceptedRequest): string {
  const headers = Object.entries(req.headers ?? {}).map(([k, v]) => `-H '${k}: ${v}'`).join(" ")
  const body = req.body ? `--data '${req.body}'` : ""
  return `curl -X ${req.method} '${req.url}' ${headers} ${body}`.trim()
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function SnarePage() {
  // Snare on/off
  const [snaring, setSnaring] = useState(false)
  const [togglingSnare, setTogglingSnare] = useState(false)

  // Intercepted queue
  const [intercepted, setIntercepted] = useState<InterceptedRequest[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)

  // Editor: shows request (editable) or response (editable) after forward
  const [editorMode, setEditorMode] = useState<"request" | "response">("request")
  const [rawRequest, setRawRequest] = useState("")
  const [rawResponse, setRawResponse] = useState("")
  const [response, setResponse] = useState<ResponseData | null>(null)

  // Per-item phase: "request" = held at request stage, "response" = held at response stage
  const [itemPhase, setItemPhase] = useState<Record<string, "request" | "response">>({})

  // When a request has been forwarded to the server but the response hasn't
  // arrived yet, this holds the request_id so we can match the WS message.
  const [pendingResponseId, setPendingResponseId] = useState<string | null>(null)

  // Action state
  const [forwarding, setForwarding] = useState(false)
  const [dropping, setDropping] = useState(false)
  const [forwardingResponse, setForwardingResponse] = useState(false)
  const [droppingResponse, setDroppingResponse] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)
  const [disconnectToast, setDisconnectToast] = useState<string | null>(null)

  // Copy state
  const [copiedUrl, setCopiedUrl] = useState(false)
  const [copiedCurl, setCopiedCurl] = useState(false)

  // Rules
  const [rules, setRules] = useState<SnareRule[]>([])
  const [rulesLoading, setRulesLoading] = useState(true)
  const [showAddRule, setShowAddRule] = useState(false)
  const [newRuleName, setNewRuleName] = useState("")
  const [newRuleHost, setNewRuleHost] = useState("")
  const [newRulePath, setNewRulePath] = useState("")
  const [newRuleMethod, setNewRuleMethod] = useState("")
  const [addingRule, setAddingRule] = useState(false)

  // Sidebar resize (queue list ↔ editor)
  const [sidebarWidth, setSidebarWidth] = useState(192) // 48 * 4 = 192px default
  const sidebarWidthRef = useRef(192)
  const sidebarDragging = useRef(false)
  const sidebarDragStart = useRef(0)
  const sidebarWidthStart = useRef(0)
  const [widthsReady, setWidthsReady] = useState(false)

  const wsRef = useRef<WebSocket | null>(null)

  // Read persisted sidebar width synchronously before first paint
  useLayoutEffect(() => {
    const sw = Number(localStorage.getItem("ferret_snare_sidebar_width"))
    if (sw > 0) { setSidebarWidth(sw); sidebarWidthRef.current = sw }
    setWidthsReady(true)
  }, [])

  // ── Load initial state ──────────────────────────────────────────────────────

  useEffect(() => {
    // Load pending intercepted requests
    apiFetch(`${API_BASE}/api/snare/intercepted`)
      .then(r => r.ok ? r.json() : [])
      .then((data: InterceptedRequest[]) => {
        setIntercepted(data)
        // All items from the initial load are in request phase
        setItemPhase(Object.fromEntries(data.map(r => [r.id, "request" as const])))
        if (data.length > 0) {
          setSelectedId(data[0].id)
          setRawRequest(requestToRaw(data[0]))
          setEditorMode("request")
        }
      })
      .catch(() => {})

    // Load rules
    setRulesLoading(true)
    apiFetch(`${API_BASE}/api/snare/rules`)
      .then(r => r.ok ? r.json() : [])
      .then((data: SnareRule[]) => setRules(data))
      .catch(() => {})
      .finally(() => setRulesLoading(false))
  }, [])

  // ── WebSocket ───────────────────────────────────────────────────────────────

  useEffect(() => {
    function connect() {
      const ws = new WebSocket(`${WS_BASE}/ws`)
      wsRef.current = ws

      ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data)
          if (msg.type === "snare_intercepted") {
            const req = msg.data as InterceptedRequest
            setIntercepted(prev => {
              if (prev.find(r => r.id === req.id)) return prev
              return [req, ...prev]
            })
            setItemPhase(prev => ({ ...prev, [req.id]: "request" }))
            setSelectedId(prev => {
              if (!prev) {
                setRawRequest(requestToRaw(req))
                setEditorMode("request")
                setResponse(null)
                setRawResponse("")
                return req.id
              }
              return prev
            })
          } else if (msg.type === "snare_response_ready") {
            const { request_id, status_code, response_headers, response_body, response_time } = msg.data
            // Update phase badge for this item
            setItemPhase(prev => ({ ...prev, [request_id]: "response" }))
            // Only populate editor if this is the response we're waiting for
            setPendingResponseId(prev => {
              if (prev === request_id) {
                const rd: ResponseData = {
                  status_code,
                  response_headers: response_headers ?? {},
                  response_body: response_body ?? "",
                  response_time: response_time ?? null,
                }
                setResponse(rd)
                setRawResponse(buildRawResponse(rd))
                setEditorMode("response")
                return null
              }
              return prev
            })
          } else if (msg.type === "snare_client_disconnected") {
            const { request_id } = msg.data
            // Client dropped the connection before we could forward the response.
            // Clear the pending state and remove the item from the queue.
            setPendingResponseId(prev => prev === request_id ? null : prev)
            setIntercepted(prev => prev.filter(r => r.id !== request_id))
            setSelectedId(prev => {
              if (prev !== request_id) return prev
              setEditorMode("request")
              setResponse(null)
              setRawResponse("")
              setRawRequest("")
              return null
            })
            setItemPhase(prev => {
              const next = { ...prev }
              delete next[request_id]
              return next
            })
            setDisconnectToast("Client disconnected before response could be forwarded")
            setTimeout(() => setDisconnectToast(null), 4000)
          }
        } catch { /* ignore malformed messages */ }
      }

      ws.onclose = () => { setTimeout(connect, 2000) }
    }

    connect()
    return () => { wsRef.current?.close() }
  }, [])

  // ── Sidebar drag ────────────────────────────────────────────────────────────

  const handleSidebarDragStart = (e: React.MouseEvent) => {
    sidebarDragging.current = true
    sidebarDragStart.current = e.clientX
    sidebarWidthStart.current = sidebarWidthRef.current
    e.preventDefault()
  }

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (!sidebarDragging.current) return
      const next = Math.max(120, Math.min(400, sidebarWidthStart.current + (e.clientX - sidebarDragStart.current)))
      sidebarWidthRef.current = next
      setSidebarWidth(next)
    }
    const onUp = () => {
      if (!sidebarDragging.current) return
      sidebarDragging.current = false
      localStorage.setItem("ferret_snare_sidebar_width", String(sidebarWidthRef.current))
    }
    document.addEventListener("mousemove", onMove)
    document.addEventListener("mouseup", onUp)
    return () => {
      document.removeEventListener("mousemove", onMove)
      document.removeEventListener("mouseup", onUp)
    }
  }, [])

  // ── Snare toggle ────────────────────────────────────────────────────────────

  const handleToggleSnare = useCallback(async () => {
    setTogglingSnare(true)
    try {
      const endpoint = snaring ? "/api/snare/stop" : "/api/snare/start"
      const res = await apiFetch(`${API_BASE}${endpoint}`, { method: "POST" })
      if (res.ok) setSnaring(v => !v)
    } catch { /* ignore */ } finally {
      setTogglingSnare(false)
    }
  }, [snaring])

  // ── Select intercepted request ──────────────────────────────────────────────

  const handleSelectRequest = useCallback((req: InterceptedRequest) => {
    setSelectedId(req.id)
    const phase = itemPhase[req.id] ?? "request"
    if (phase === "request") {
      setRawRequest(requestToRaw(req))
      setEditorMode("request")
      setResponse(null)
      setRawResponse("")
    } else {
      // Item is in response phase — switch to response view
      setEditorMode("response")
    }
    setActionError(null)
  }, [itemPhase])

  // ── Remove from queue helper ────────────────────────────────────────────────

  const removeFromQueue = useCallback((removedId: string) => {
    setItemPhase(prev => { const n = { ...prev }; delete n[removedId]; return n })
    setIntercepted(prev => {
      const next = prev.filter(r => r.id !== removedId)
      if (removedId === selectedId) {
        // Find next item that is still in request phase
        const nextReq = next.find(r => (itemPhase[r.id] ?? "request") === "request") ?? next[0] ?? null
        if (nextReq) {
          setSelectedId(nextReq.id)
          setRawRequest(requestToRaw(nextReq))
          setEditorMode("request")
          setResponse(null)
          setRawResponse("")
        } else {
          setSelectedId(null)
          setRawRequest("")
          setEditorMode("request")
          setResponse(null)
          setRawResponse("")
        }
      }
      return next
    })
  }, [selectedId, itemPhase])

  // ── Phase 1: Forward request to server ──────────────────────────────────────

  const handleForward = useCallback(async () => {
    if (!selectedId) return
    setForwarding(true)
    setActionError(null)
    try {
      const res = await apiFetch(`${API_BASE}/api/snare/intercepted/${selectedId}/forward`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ raw_request: rawRequest }),
      })
      if (!res.ok) {
        const err = await res.json().catch(() => ({ detail: res.statusText }))
        setActionError(err.detail ?? "Forward failed")
        return
      }
      // Keep item in list but mark as pending response phase
      const forwardedId = selectedId
      setPendingResponseId(forwardedId)
      setItemPhase(prev => ({ ...prev, [forwardedId]: "response" }))
      // Switch editor to waiting state — WS handler will populate response
      setEditorMode("response")
      setResponse(null)
      setRawResponse("")
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Network error")
    } finally {
      setForwarding(false)
    }
  }, [selectedId, rawRequest])

  // ── Phase 1: Drop request ────────────────────────────────────────────────────

  const handleDrop = useCallback(async () => {
    if (!selectedId) return
    setDropping(true)
    setActionError(null)
    try {
      const res = await apiFetch(`${API_BASE}/api/snare/intercepted/${selectedId}/drop`, {
        method: "POST",
      })
      if (!res.ok) {
        const err = await res.json().catch(() => ({ detail: res.statusText }))
        setActionError(err.detail ?? "Drop failed")
        return
      }
      removeFromQueue(selectedId)
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Network error")
    } finally {
      setDropping(false)
    }
  }, [selectedId, removeFromQueue])

  // ── Phase 2: Forward response to client ─────────────────────────────────────

  const handleForwardResponse = useCallback(async () => {
    if (!pendingResponseId && !selectedId) return
    const id = pendingResponseId ?? selectedId!
    setForwardingResponse(true)
    setActionError(null)
    try {
      const res = await apiFetch(`${API_BASE}/api/snare/response/${id}/forward`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ raw_response: rawResponse || null }),
      })
      if (!res.ok) {
        const err = await res.json().catch(() => ({ detail: res.statusText }))
        setActionError(err.detail ?? "Forward response failed")
        return
      }
      // Remove item from queue entirely
      setPendingResponseId(null)
      removeFromQueue(id)
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Network error")
    } finally {
      setForwardingResponse(false)
    }
  }, [pendingResponseId, selectedId, rawResponse, removeFromQueue])

  // ── Phase 2: Drop response ───────────────────────────────────────────────────

  const handleDropResponse = useCallback(async () => {
    if (!pendingResponseId && !selectedId) return
    const id = pendingResponseId ?? selectedId!
    setDroppingResponse(true)
    setActionError(null)
    try {
      const res = await apiFetch(`${API_BASE}/api/snare/response/${id}/drop`, {
        method: "POST",
      })
      if (!res.ok) {
        const err = await res.json().catch(() => ({ detail: res.statusText }))
        setActionError(err.detail ?? "Drop response failed")
        return
      }
      setPendingResponseId(null)
      removeFromQueue(id)
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Network error")
    } finally {
      setDroppingResponse(false)
    }
  }, [pendingResponseId, selectedId, removeFromQueue])

  // ── Copy helpers ─────────────────────────────────────────────────────────────

  const selectedReq = intercepted.find(r => r.id === selectedId) ?? null

  // Keep a ref to the last selected request so Copy URL / Copy cURL still work
  // after the request is removed from the queue (e.g. while viewing its response).
  const lastSelectedReqRef = useRef<InterceptedRequest | null>(null)
  if (selectedReq) lastSelectedReqRef.current = selectedReq
  const copyTarget = selectedReq ?? lastSelectedReqRef.current

  const handleCopyUrl = useCallback(() => {
    const target = selectedReq ?? lastSelectedReqRef.current
    if (!target) return
    navigator.clipboard.writeText(target.url).catch(() => {})
    setCopiedUrl(true)
    setTimeout(() => setCopiedUrl(false), 1500)
  }, [selectedReq])

  const handleCopyCurl = useCallback(() => {
    const target = selectedReq ?? lastSelectedReqRef.current
    if (!target) return
    navigator.clipboard.writeText(buildCurl(target)).catch(() => {})
    setCopiedCurl(true)
    setTimeout(() => setCopiedCurl(false), 1500)
  }, [selectedReq])

  // ── Add rule ─────────────────────────────────────────────────────────────────

  const handleAddRule = useCallback(async () => {
    if (!newRuleName.trim()) return
    setAddingRule(true)
    try {
      const rule: Partial<SnareRule> = {
        id: crypto.randomUUID(),
        name: newRuleName.trim(),
        enabled: true,
        method: newRuleMethod.trim() || null,
        host_pattern: newRuleHost.trim() || null,
        path_pattern: newRulePath.trim() || null,
        body_pattern: null,
        action: "snare",
      }
      const res = await apiFetch(`${API_BASE}/api/snare/rules`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(rule),
      })
      if (res.ok) {
        setRules(prev => [...prev, rule as SnareRule])
        setNewRuleName("")
        setNewRuleHost("")
        setNewRulePath("")
        setNewRuleMethod("")
        setShowAddRule(false)
      }
    } catch { /* ignore */ } finally {
      setAddingRule(false)
    }
  }, [newRuleName, newRuleHost, newRulePath, newRuleMethod])

  // ── Delete rule ──────────────────────────────────────────────────────────────

  const handleDeleteRule = useCallback(async (ruleId: string) => {
    try {
      await apiFetch(`${API_BASE}/api/snare/rules/${ruleId}`, { method: "DELETE" })
      setRules(prev => prev.filter(r => r.id !== ruleId))
    } catch { /* ignore */ }
  }, [])

  // ── Editor extensions ────────────────────────────────────────────────────────

  const requestExtensions = useMemo(() => [
    ...baseExtensions,
    StreamLanguage.define(httpMode),
  ], [])

  const responseContentType = useMemo(() => {
    if (!response?.response_headers) return null
    return Object.entries(response.response_headers).find(([k]) => k.toLowerCase() === "content-type")?.[1] ?? null
  }, [response])

  const responseLangExt = useMemo(() => langExtFromContentType(responseContentType), [responseContentType])

  const responseExtensions = useMemo(() => [
    ...baseExtensions,
    ...(Array.isArray(responseLangExt) ? responseLangExt : [responseLangExt]),
  ], [responseLangExt])

  // ── Render ───────────────────────────────────────────────────────────────────

  if (!widthsReady) return <div className="flex flex-col h-full overflow-hidden bg-neutral-950" />

  return (
    <div className="flex flex-col h-full overflow-hidden relative">

      {/* Client-disconnect toast */}
      {disconnectToast && (
        <div className="absolute top-12 left-1/2 -translate-x-1/2 z-50 flex items-center gap-2 px-3 py-2 bg-yellow-900/90 border border-yellow-600 text-yellow-200 text-xs rounded shadow-lg pointer-events-none">
          <ShieldAlert className="w-3.5 h-3.5 flex-shrink-0" />
          {disconnectToast}
        </div>
      )}

      {/* Page header */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-neutral-800 flex-shrink-0 bg-neutral-900">
        <div className="flex items-center gap-2">
          <h1 className="text-sm font-bold text-white">Snare</h1>
          {intercepted.length > 0 && (
            <span className="px-1.5 py-0.5 bg-brand-900/50 border border-brand-700 text-brand-300 text-[10px] font-mono rounded">
              {intercepted.length} pending
            </span>
          )}
        </div>
        <div className="flex items-center gap-1">
          <span className={`px-2 py-0.5 border text-xs ${
            snaring
              ? "bg-green-900/40 border-green-700 text-green-300"
              : "bg-neutral-800 border-neutral-700 text-neutral-400"
          }`}>
            {snaring ? "Snare On" : "Snare Off"}
          </span>
          <Button
            variant="ghost"
            size="sm"
            className={`h-7 text-xs ${
              snaring
                ? "text-red-400 hover:text-red-300 hover:bg-red-900/20"
                : "text-brand-400 hover:text-brand-300 hover:bg-brand-900/20"
            }`}
            onClick={handleToggleSnare}
            disabled={togglingSnare}
          >
            {snaring ? (
              <><Pause className="w-3 h-3 mr-1" />Stop</>
            ) : (
              <><Play className="w-3 h-3 mr-1" />Start</>
            )}
          </Button>
        </div>
      </div>

      {/* Main body: queue sidebar + action sidebar + editor */}
      <div className="flex flex-1 min-h-0 overflow-hidden">

        {/* Left sidebar — intercepted queue (resizable) */}
        <div
          className="flex flex-col flex-shrink-0 bg-neutral-950 overflow-hidden border-r border-neutral-800"
          style={{ width: `${sidebarWidth}px` }}
        >
          <div className="flex items-center justify-between h-9 px-3 border-b border-neutral-800 bg-neutral-900/60 flex-shrink-0">
            <span className="text-xs font-semibold text-white">Intercepted</span>
            <ShieldAlert className="w-3 h-3 text-brand-500" />
          </div>
          <div className="flex-1 overflow-y-auto">
            {intercepted.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-10 text-neutral-600 px-3 text-center">
                <Filter className="w-5 h-5 mb-2 opacity-40" />
                <p className="text-[10px]">No intercepted requests</p>
                {!snaring && (
                  <p className="text-[10px] text-neutral-700 mt-1">Start snare to intercept</p>
                )}
              </div>
            ) : (
              intercepted.map(req => {
                const phase = itemPhase[req.id] ?? "request"
                const isSelected = req.id === selectedId
                const isWaiting = phase === "response" && pendingResponseId === req.id && !response
                return (
                  <div
                    key={req.id}
                    onClick={() => handleSelectRequest(req)}
                    className={`group flex flex-col px-2 py-1.5 cursor-pointer border-b border-neutral-800/50 gap-0.5 ${
                      isSelected ? "bg-neutral-800" : "hover:bg-neutral-900"
                    }`}
                  >
                    <div className="flex items-center gap-1 min-w-0">
                      <span className={`text-[9px] font-bold font-mono flex-shrink-0 ${
                        isSelected ? "text-brand-400" : methodColor(req.method)
                      }`}>
                        {req.method}
                      </span>
                      <span className={`flex-1 text-[10px] font-mono truncate min-w-0 ${
                        isSelected ? "text-brand-300" : "text-neutral-300"
                      }`} title={req.host}>
                        {req.host}
                      </span>
                      {/* Phase badge */}
                      {phase === "request" ? (
                        <span className="flex-shrink-0 text-[8px] font-bold font-mono px-1 py-0.5 rounded bg-brand-900/40 text-brand-400 border border-brand-800/60">
                          REQ
                        </span>
                      ) : isWaiting ? (
                        <span className="flex-shrink-0 text-[8px] font-bold font-mono px-1 py-0.5 rounded bg-neutral-800 text-neutral-500 border border-neutral-700 animate-pulse">
                          ...
                        </span>
                      ) : (
                        <span className="flex-shrink-0 text-[8px] font-bold font-mono px-1 py-0.5 rounded bg-blue-900/40 text-blue-400 border border-blue-800/60">
                          RESP
                        </span>
                      )}
                    </div>
                    <div className={`text-[9px] font-mono truncate ${
                      isSelected ? "text-neutral-500" : "text-neutral-600"
                    }`} title={req.path}>
                      {req.path || "/"}
                    </div>
                  </div>
                )
              })
            )}
          </div>
        </div>

        {/* Sidebar resize handle */}
        <div
          className="w-1 flex-shrink-0 bg-neutral-800 hover:bg-brand-500 transition-colors cursor-col-resize z-10"
          onMouseDown={handleSidebarDragStart}
        />

        {/* Action sidebar (like history detail view) */}
        <div
          className="flex flex-col items-center gap-1 px-1 py-2 border-r border-neutral-800 flex-shrink-0 w-9"
          style={{ backgroundColor: "#111" }}
        >
          {editorMode === "request" ? (
            <>
              {/* Phase 1: Forward request */}
              <button
                onClick={handleForward}
                disabled={!selectedReq || forwarding || dropping}
                className={`w-7 h-6 flex items-center justify-center rounded transition-colors ${
                  !selectedReq
                    ? "text-neutral-700 cursor-not-allowed"
                    : forwarding
                      ? "text-brand-400"
                      : "text-neutral-500 hover:text-brand-400 hover:bg-neutral-700"
                }`}
                title="Forward request to server"
              >
                <Send className="w-3 h-3" />
              </button>
              {/* Phase 1: Drop request */}
              <button
                onClick={handleDrop}
                disabled={!selectedReq || dropping || forwarding}
                className={`w-7 h-6 flex items-center justify-center rounded transition-colors ${
                  !selectedReq
                    ? "text-neutral-700 cursor-not-allowed"
                    : dropping
                      ? "text-red-400"
                      : "text-neutral-500 hover:text-red-400 hover:bg-neutral-700"
                }`}
                title="Drop request"
              >
                <Trash2 className="w-3 h-3" />
              </button>
            </>
          ) : (
            <>
              {/* Phase 2: Forward response to client */}
              <button
                onClick={handleForwardResponse}
                disabled={!response || forwardingResponse || droppingResponse || !!pendingResponseId && !response}
                className={`w-7 h-6 flex items-center justify-center rounded transition-colors ${
                  !response || (!!pendingResponseId && !response)
                    ? "text-neutral-700 cursor-not-allowed"
                    : forwardingResponse
                      ? "text-blue-400"
                      : "text-neutral-500 hover:text-blue-400 hover:bg-neutral-700"
                }`}
                title="Forward response to client"
              >
                <Send className="w-3 h-3" />
              </button>
              {/* Phase 2: Drop response */}
              <button
                onClick={handleDropResponse}
                disabled={!response || droppingResponse || forwardingResponse || !!pendingResponseId && !response}
                className={`w-7 h-6 flex items-center justify-center rounded transition-colors ${
                  !response || (!!pendingResponseId && !response)
                    ? "text-neutral-700 cursor-not-allowed"
                    : droppingResponse
                      ? "text-red-400"
                      : "text-neutral-500 hover:text-red-400 hover:bg-neutral-700"
                }`}
                title="Drop response"
              >
                <Trash2 className="w-3 h-3" />
              </button>
            </>
          )}
          {/* Copy URL */}
          <button
            onClick={handleCopyUrl}
            disabled={!copyTarget}
            className={`w-7 h-6 flex items-center justify-center rounded transition-colors ${
              !copyTarget
                ? "text-neutral-700 cursor-not-allowed"
                : copiedUrl
                  ? "text-green-400"
                  : "text-neutral-500 hover:text-white hover:bg-neutral-700"
            }`}
            title="Copy URL"
          >
            {copiedUrl ? <Check className="w-3 h-3" /> : <Copy className="w-3 h-3" />}
          </button>
          {/* Copy as cURL */}
          <button
            onClick={handleCopyCurl}
            disabled={!copyTarget}
            className={`w-7 h-6 flex items-center justify-center rounded transition-colors ${
              !copyTarget
                ? "text-neutral-700 cursor-not-allowed"
                : copiedCurl
                  ? "text-green-400"
                  : "text-neutral-500 hover:text-white hover:bg-neutral-700"
            }`}
            title="Copy as cURL"
          >
            {copiedCurl ? <Check className="w-3 h-3" /> : <Link className="w-3 h-3" />}
          </button>
        </div>

        {/* Right: editor */}
        <div className="flex flex-col flex-1 min-h-0 min-w-0 overflow-hidden">

          {/* Editor header */}
          <div className="flex items-center justify-between h-9 px-3 border-b border-neutral-800 bg-neutral-900/60 flex-shrink-0">
            <div className="flex items-center gap-2">
              {editorMode === "request" ? (
                <span className="text-xs font-semibold text-brand-400 uppercase tracking-wider">Request</span>
              ) : pendingResponseId && !response ? (
                <span className="text-xs font-semibold text-neutral-500 uppercase tracking-wider animate-pulse">Waiting...</span>
              ) : (
                <span className="text-xs font-semibold text-blue-400 uppercase tracking-wider">Response</span>
              )}
              {selectedReq && editorMode === "request" && (
                <span className="text-neutral-600 text-xs font-mono truncate max-w-xs">
                  {selectedReq.method} {selectedReq.host}{selectedReq.path}
                </span>
              )}
              {editorMode === "response" && response && (
                <span className={`text-xs font-mono font-bold ${statusColor(response.status_code)}`}>
                  {response.status_code}
                </span>
              )}
              {editorMode === "response" && response?.response_time != null && (
                <span className="text-xs text-neutral-500 font-mono">
                  {response.response_time.toFixed(0)}ms
                </span>
              )}
            </div>
            {/* Back to request button when viewing response (only if there's still a selected req) */}
            {editorMode === "response" && selectedReq && (
              <button
                onClick={() => setEditorMode("request")}
                className="text-[10px] text-neutral-500 hover:text-neutral-300 transition-colors px-2"
              >
                ← Request
              </button>
            )}
          </div>

          {/* Action error */}
          {actionError && (
            <div className="bg-red-900/40 border-b border-red-700 text-red-300 px-4 py-1.5 text-xs flex-shrink-0">
              ⚠ {actionError}
            </div>
          )}

          {/* CodeMirror editor */}
          <div className="flex-1 min-h-0 overflow-hidden">
            {editorMode === "request" && selectedReq ? (
              <CodeMirror
                value={rawRequest}
                onChange={setRawRequest}
                extensions={requestExtensions}
                theme="dark"
                basicSetup={{
                  lineNumbers: true,
                  foldGutter: false,
                  highlightActiveLine: true,
                  highlightActiveLineGutter: true,
                  autocompletion: false,
                  drawSelection: false,
                }}
                style={{ height: "100%" }}
              />
            ) : editorMode === "response" && response ? (
              <CodeMirror
                value={rawResponse}
                onChange={setRawResponse}
                extensions={responseExtensions}
                theme="dark"
                basicSetup={{
                  lineNumbers: true,
                  foldGutter: false,
                  highlightActiveLine: false,
                  highlightActiveLineGutter: false,
                  drawSelection: false,
                }}
                style={{ height: "100%" }}
              />
            ) : editorMode === "response" && pendingResponseId && !response ? (
              <div className="flex-1 h-full flex flex-col items-center justify-center text-neutral-600 text-xs font-mono bg-neutral-950 gap-2">
                <div className="w-4 h-4 border-2 border-neutral-700 border-t-brand-500 rounded-full animate-spin" />
                <span>Waiting for server response...</span>
              </div>
            ) : (
              <div className="flex-1 h-full flex items-center justify-center text-neutral-600 text-xs font-mono bg-neutral-950">
                {snaring
                  ? "Waiting for intercepted requests..."
                  : "Start snare and configure rules to intercept requests"}
              </div>
            )}
          </div>
        </div>{/* end editor column */}
      </div>{/* end main body */}

      {/* Snare Rules section */}
      <div className="flex-shrink-0 border-t border-neutral-800 bg-neutral-950" style={{ maxHeight: "220px" }}>
        {/* Rules header */}
        <div className="flex items-center justify-between px-3 py-1.5 border-b border-neutral-800 bg-neutral-900/60">
          <span className="text-[10px] font-semibold text-neutral-400 uppercase tracking-wider">
            Snare Rules
          </span>
          <button
            onClick={() => setShowAddRule(v => !v)}
            className="text-neutral-500 hover:text-brand-400 transition-colors"
            title="Add rule"
          >
            <Plus className="w-3 h-3" />
          </button>
        </div>

        {/* Add rule form */}
        {showAddRule && (
          <div className="px-3 py-2 border-b border-neutral-800 bg-neutral-900/30 flex flex-col gap-1.5">
            <div className="flex gap-1.5">
              <input
                className="flex-1 bg-neutral-800 border border-neutral-700 text-neutral-200 text-xs px-2 py-1 rounded focus:outline-none focus:border-brand-600 placeholder-neutral-600"
                placeholder="Rule name *"
                value={newRuleName}
                onChange={e => setNewRuleName(e.target.value)}
              />
              <select
                className="bg-neutral-800 border border-neutral-700 text-neutral-200 text-xs px-2 py-1 rounded focus:outline-none focus:border-brand-600"
                value={newRuleMethod}
                onChange={e => setNewRuleMethod(e.target.value)}
              >
                <option value="">Any method</option>
                {["GET","POST","PUT","DELETE","PATCH","HEAD","OPTIONS"].map(m => (
                  <option key={m} value={m}>{m}</option>
                ))}
              </select>
            </div>
            <div className="flex gap-1.5">
              <input
                className="flex-1 bg-neutral-800 border border-neutral-700 text-neutral-200 text-xs px-2 py-1 rounded focus:outline-none focus:border-brand-600 placeholder-neutral-600 font-mono"
                placeholder="Host pattern (regex, e.g. example\.com)"
                value={newRuleHost}
                onChange={e => setNewRuleHost(e.target.value)}
              />
              <input
                className="flex-1 bg-neutral-800 border border-neutral-700 text-neutral-200 text-xs px-2 py-1 rounded focus:outline-none focus:border-brand-600 placeholder-neutral-600 font-mono"
                placeholder="Path pattern (regex, e.g. /api/.*)"
                value={newRulePath}
                onChange={e => setNewRulePath(e.target.value)}
              />
            </div>
            <div className="flex justify-end gap-1.5">
              <Button
                variant="ghost"
                size="sm"
                className="h-6 text-xs text-neutral-500 hover:text-neutral-300 px-2"
                onClick={() => setShowAddRule(false)}
              >
                Cancel
              </Button>
              <Button
                variant="ghost"
                size="sm"
                className="h-6 text-xs text-brand-400 hover:text-brand-300 hover:bg-brand-900/20 px-2"
                onClick={handleAddRule}
                disabled={addingRule || !newRuleName.trim()}
              >
                {addingRule ? "Adding..." : "Add Rule"}
              </Button>
            </div>
          </div>
        )}

        {/* Rules list */}
        <div className="overflow-y-auto" style={{ maxHeight: "140px" }}>
          {rulesLoading ? (
            <div className="px-3 py-3 text-xs text-neutral-600">Loading...</div>
          ) : rules.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-5 text-neutral-600">
              <p className="text-xs">No snare rules — all requests will be intercepted when snare is on</p>
            </div>
          ) : (
            rules.map(rule => (
              <div
                key={rule.id}
                className="group flex items-center gap-2 px-3 py-1.5 border-b border-neutral-800/50 hover:bg-neutral-900/40"
              >
                <div className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${rule.enabled ? "bg-green-500" : "bg-neutral-600"}`} />
                <span className="text-xs text-neutral-300 font-medium flex-shrink-0">{rule.name}</span>
                {rule.method && (
                  <span className={`text-[9px] font-mono font-bold flex-shrink-0 ${methodColor(rule.method)}`}>
                    {rule.method}
                  </span>
                )}
                {rule.host_pattern && (
                  <span className="text-[10px] font-mono text-neutral-500 truncate" title={rule.host_pattern}>
                    {rule.host_pattern}
                  </span>
                )}
                {rule.path_pattern && (
                  <span className="text-[10px] font-mono text-neutral-600 truncate" title={rule.path_pattern}>
                    {rule.path_pattern}
                  </span>
                )}
                <div className="flex-1" />
                <button
                  onClick={() => handleDeleteRule(rule.id)}
                  className="opacity-0 group-hover:opacity-100 text-neutral-600 hover:text-red-400 transition-all flex-shrink-0"
                  title="Delete rule"
                >
                  <X className="w-3 h-3" />
                </button>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  )
}
