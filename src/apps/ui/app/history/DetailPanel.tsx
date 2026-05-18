"use client"

import React, { useState, useRef, useCallback, useMemo, useEffect } from "react"
import { Button } from "@/components/ui/button"
import { Sparkles, Loader2, Send, Maximize2, Link, Copy, Check } from "lucide-react"
import CodeMirror, { EditorView } from "@uiw/react-codemirror"
import { atomoneInit } from "@uiw/codemirror-theme-atomone"
import { StreamLanguage } from "@codemirror/language"
import { http as httpMode } from "@codemirror/legacy-modes/mode/http"
import { css as cssMode } from "@codemirror/legacy-modes/mode/css"
import { xml as xmlMode } from "@codemirror/legacy-modes/mode/xml"
import { javascript as jsMode } from "@codemirror/legacy-modes/mode/javascript"
import { json } from "@codemirror/lang-json"
import { html } from "@codemirror/lang-html"
import { EditorState } from "@codemirror/state"
import { html as beautifyHtml, js as beautifyJs, css as beautifyCss } from "js-beautify"

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000"

// ---------------------------------------------------------------------------
// CodeMirror theme (matches gnaw)
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Language / beautify helpers (matches gnaw)
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Types (re-exported so page.tsx can import from one place)
// ---------------------------------------------------------------------------

export interface ApiRequest {
  seq: number | null
  id: string
  timestamp: string
  method: string
  url: string
  host: string
  path: string
  status_code: number | null
  response_time: number | null
  response_size: number | null
  headers: Record<string, string> | null
  body: string | null
  response_headers: Record<string, string> | null
  response_body: string | null
  annotation: string | null
  source: string
}

// ---------------------------------------------------------------------------
// Raw request/response builders
// ---------------------------------------------------------------------------

export function buildRawRequest(req: ApiRequest): string {
  const lines: string[] = []
  const urlObj = (() => { try { return new URL(req.url) } catch { return null } })()
  const pathAndQuery = urlObj ? `${urlObj.pathname}${urlObj.search}` : req.path
  lines.push(`${req.method} ${pathAndQuery} HTTP/1.1`)
  lines.push(`Host: ${req.host}`)
  if (req.headers) {
    for (const [k, v] of Object.entries(req.headers)) {
      if (k.toLowerCase() !== "host") lines.push(`${k}: ${v}`)
    }
  }
  lines.push("")
  if (req.body) lines.push(req.body)
  return lines.join("\r\n")
}

export function buildRawResponse(req: ApiRequest): string {
  const lines: string[] = []
  lines.push(`HTTP/1.1 ${req.status_code}`)
  if (req.response_headers) {
    for (const [k, v] of Object.entries(req.response_headers)) {
      lines.push(`${k}: ${v}`)
    }
  }
  lines.push("")
  if (req.response_body) lines.push(req.response_body)
  return lines.join("\r\n")
}

// ---------------------------------------------------------------------------
// Status / method colour helpers
// ---------------------------------------------------------------------------

export const getStatusColor = (status: number | null) => {
  if (!status) return "bg-gray-600"
  if (status >= 200 && status < 300) return "bg-green-500"
  if (status >= 300 && status < 400) return "bg-yellow-500"
  if (status >= 400 && status < 500) return "bg-red-500"
  if (status >= 500) return "bg-purple-500"
  return "bg-gray-500"
}

export const getMethodColor = (method: string) => {
  switch (method) {
    case "GET":    return "bg-blue-500"
    case "POST":   return "bg-green-500"
    case "PUT":    return "bg-yellow-500"
    case "DELETE": return "bg-red-500"
    case "PATCH":  return "bg-purple-500"
    default:       return "bg-gray-500"
  }
}

export const formatTime = (iso: string) => {
  try { return new Date(iso).toLocaleTimeString("en-GB", { hour12: false }) }
  catch { return iso }
}

// ---------------------------------------------------------------------------
// Inline detail panel (rendered as a table row)
// ---------------------------------------------------------------------------

export interface DetailPanelProps {
  request: ApiRequest
  onAnnotate: (req: ApiRequest, e: React.MouseEvent) => void
  annotating: string | null
  maximized?: boolean
  onMaximize?: (v: boolean) => void
  onSendToGnaw?: () => void
}

export function DetailPanel({ request, onAnnotate, annotating, maximized = false, onMaximize, onSendToGnaw }: DetailPanelProps) {
  const [splitPct, setSplitPct] = useState(50)
  const [panelHeight, setPanelHeight] = useState(380)
  const [copiedUrl, setCopiedUrl] = useState(false)
  const [copiedCurl, setCopiedCurl] = useState(false)
  const containerRef = useRef<HTMLDivElement>(null)
  const reqPaneRef = useRef<HTMLDivElement>(null)
  const respPaneRef = useRef<HTMLDivElement>(null)

  // Prevent scroll from leaking out of the CM panes into the host page
  useEffect(() => {
    const isolate = (el: HTMLDivElement | null) => {
      if (!el) return () => {}
      const handler = (e: WheelEvent) => {
        // Find the actual scrollable CM scroller inside this pane
        const scroller = el.querySelector(".cm-scroller") as HTMLElement | null
        if (!scroller) return
        const atTop = scroller.scrollTop === 0
        const atBottom = scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 1
        if ((e.deltaY < 0 && atTop) || (e.deltaY > 0 && atBottom)) {
          e.preventDefault()
        }
        e.stopPropagation()
      }
      el.addEventListener("wheel", handler, { passive: false })
      return () => el.removeEventListener("wheel", handler)
    }
    const cleanReq = isolate(reqPaneRef.current)
    const cleanResp = isolate(respPaneRef.current)
    return () => { cleanReq(); cleanResp() }
  }, [])

  // Horizontal drag (left/right split between request and response panes)
  const onDragStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    const container = containerRef.current
    if (!container) return
    const move = (ev: MouseEvent) => {
      const rect = container.getBoundingClientRect()
      const pct = Math.min(80, Math.max(20, ((ev.clientX - rect.left) / rect.width) * 100))
      setSplitPct(pct)
    }
    const up = () => {
      window.removeEventListener("mousemove", move)
      window.removeEventListener("mouseup", up)
    }
    window.addEventListener("mousemove", move)
    window.addEventListener("mouseup", up)
  }, [])

  // Vertical drag (resize panel height)
  const onHeightDragStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    const startY = e.clientY
    const startH = panelHeight
    const move = (ev: MouseEvent) => {
      const delta = ev.clientY - startY
      setPanelHeight(Math.min(800, Math.max(160, startH + delta)))
    }
    const up = () => {
      window.removeEventListener("mousemove", move)
      window.removeEventListener("mouseup", up)
    }
    window.addEventListener("mousemove", move)
    window.addEventListener("mouseup", up)
  }, [panelHeight])

  // ── Request CM extensions (HTTP mode, read-only) ──────────────────────────
  const requestExtensions = useMemo(() => [
    ...baseExtensions,
    StreamLanguage.define(httpMode),
    EditorState.readOnly.of(true),
  ], [])

  // ── Response CM extensions (content-type aware, read-only) ───────────────
  const responseContentType = useMemo(() => {
    if (!request.response_headers) return null
    return Object.entries(request.response_headers)
      .find(([k]) => k.toLowerCase() === "content-type")?.[1] ?? null
  }, [request.response_headers])

  const responseLangExt = useMemo(() => langExtFromContentType(responseContentType), [responseContentType])

  const responseExtensions = useMemo(() => [
    ...baseExtensions,
    ...(Array.isArray(responseLangExt) ? responseLangExt : [responseLangExt]),
    EditorState.readOnly.of(true),
  ], [responseLangExt])

  // ── Build display text ────────────────────────────────────────────────────
  const requestText = useMemo(() => buildRawRequest(request), [request])

  const responseText = useMemo(() => {
    if (request.status_code == null) return "— waiting for response —"
    const statusLine = `HTTP/1.1 ${request.status_code}`
    const headerLines = request.response_headers
      ? Object.entries(request.response_headers).map(([k, v]) => `${k}: ${v}`).join("\r\n")
      : ""
    const body = beautifyBody(request.response_body ?? "", responseContentType)
    const parts = [statusLine]
    if (headerLines) parts.push(headerLines)
    parts.push("")
    if (body) parts.push(body)
    return parts.join("\r\n")
  }, [request, responseContentType])

  // Whether to show the annotation sub-panel (has annotation text, or currently annotating)
  const showAnnotationPanel = !!(request.annotation || annotating === request.id)

  // Outer wrapper: in maximized mode fills the parent; in inline mode uses panelHeight
  const outerStyle = maximized ? undefined : { height: panelHeight }
  const outerClass = maximized
    ? "bg-neutral-900 flex flex-col h-full overflow-hidden"
    : "bg-neutral-900 flex flex-col border-t border-b border-neutral-700 overflow-hidden"

  const inner = (
    <div className={outerClass} style={outerStyle}>
      {/* Main row: sidebar + content */}
      <div className="flex flex-1 min-h-0 overflow-hidden">

        {/* Left action sidebar */}
        <div className="flex flex-col items-center gap-1 px-1 py-2 border-r border-neutral-700 flex-shrink-0 w-9" style={{ backgroundColor: "#111" }}>
          {/* 0. Annotate */}
          <button
            onClick={(e) => onAnnotate(request, e)}
            disabled={annotating === request.id}
            className={`w-7 h-6 flex items-center justify-center rounded transition-colors ${annotating === request.id ? "text-yellow-400" : "text-neutral-500 hover:text-yellow-400 hover:bg-neutral-700"}`}
            title={request.annotation ? "Re-annotate with AI" : "Annotate with AI"}
          >
            {annotating === request.id
              ? <Loader2 className="w-3 h-3 animate-spin" />
              : <Sparkles className="w-3 h-3" />}
          </button>
          {/* 1. Send to Gnaw */}
          {onSendToGnaw && (
            <button onClick={onSendToGnaw}
              className="w-7 h-6 flex items-center justify-center rounded text-neutral-500 hover:text-white hover:bg-neutral-700 transition-colors"
              title="Send to Gnaw"
            ><Send className="w-3 h-3" /></button>
          )}
          {/* 2. Copy URL */}
          <button
            onClick={() => {
              navigator.clipboard.writeText(request.url ?? "").catch(() => {})
              setCopiedUrl(true)
              setTimeout(() => setCopiedUrl(false), 1500)
            }}
            className={`w-7 h-6 flex items-center justify-center rounded transition-colors ${copiedUrl ? "text-green-400" : "text-neutral-500 hover:text-white hover:bg-neutral-700"}`}
            title="Copy URL"
          >{copiedUrl ? <Check className="w-3 h-3" /> : <Copy className="w-3 h-3" />}</button>
          {/* 3. Copy as cURL */}
          <button
            onClick={() => {
              const headers = Object.entries(request.headers ?? {}).map(([k, v]) => `-H '${k}: ${v}'`).join(" ")
              const body = request.body ? `--data '${request.body}'` : ""
              navigator.clipboard.writeText(`curl -X ${request.method} '${request.url}' ${headers} ${body}`.trim()).catch(() => {})
              setCopiedCurl(true)
              setTimeout(() => setCopiedCurl(false), 1500)
            }}
            className={`w-7 h-6 flex items-center justify-center rounded transition-colors ${copiedCurl ? "text-green-400" : "text-neutral-500 hover:text-white hover:bg-neutral-700"}`}
            title="Copy as cURL"
          >{copiedCurl ? <Check className="w-3 h-3" /> : <Link className="w-3 h-3" />}</button>
          {/* 4. Maximize (last) */}
          {onMaximize && (
            <button onClick={() => onMaximize(!maximized)}
              className="w-7 h-6 flex items-center justify-center rounded text-neutral-500 hover:text-white hover:bg-neutral-700 transition-colors"
              title={maximized ? "Restore" : "Maximize"}
            ><Maximize2 className="w-3 h-3" /></button>
          )}
        </div>

        {/* Content area */}
        <div className="flex flex-col flex-1 min-w-0 overflow-hidden">

          {/* Annotation sub-panel — shown above req/resp when annotation exists or is loading */}
          {showAnnotationPanel && (
            <div className="flex-shrink-0 border-b border-neutral-700 bg-neutral-950 px-4 py-2">
              {annotating === request.id ? (
                <div className="flex items-center gap-2 text-xs text-neutral-400">
                  <Loader2 className="w-3 h-3 animate-spin" />
                  <span>Annotating...</span>
                </div>
              ) : (
                <p className="text-xs text-neutral-300 leading-relaxed whitespace-pre-wrap">
                  <Sparkles className="w-3 h-3 text-yellow-400 inline mr-1.5 flex-shrink-0 align-middle" />
                  <span className="text-[10px] font-semibold text-yellow-400 uppercase tracking-wider mr-1.5">AI Annotation:</span>
                  {request.annotation}
                </p>
              )}
            </div>
          )}

          {/* Request / Response split */}
          <div ref={containerRef} className="flex flex-1 min-h-0">
            {/* Request pane */}
            <div className="flex flex-col min-h-0 min-w-0" style={{ width: `${splitPct}%` }}>
              <div className="px-4 h-8 bg-neutral-900 border-b border-neutral-700 flex-shrink-0 flex items-center">
                <span className="text-xs font-semibold text-brand-400 uppercase tracking-wider">Request</span>
              </div>
              <div ref={reqPaneRef} className="flex-1 min-h-0 overflow-hidden">
                <CodeMirror
                  value={requestText}
                  extensions={requestExtensions}
                  theme="dark"
                  basicSetup={{ lineNumbers: true, foldGutter: false, highlightActiveLine: false, highlightActiveLineGutter: false, drawSelection: false }}
                  style={{ height: "100%" }}
                />
              </div>
            </div>
            {/* Horizontal drag handle */}
            <div
              onMouseDown={onDragStart}
              className="w-1 flex-shrink-0 bg-neutral-700 hover:bg-brand-500 cursor-col-resize transition-colors select-none"
            />
            {/* Response pane */}
            <div className="flex flex-col min-h-0 min-w-0 flex-1">
              <div className="px-4 h-8 bg-neutral-900 border-b border-neutral-700 flex-shrink-0 flex items-center gap-2">
                <span className="text-xs font-semibold text-blue-400 uppercase tracking-wider">Response</span>
                {request.status_code && (
                  <span className={`text-xs font-mono ${getStatusColor(request.status_code).replace("bg-", "text-")}`}>
                    {request.status_code}
                  </span>
                )}
              </div>
              <div ref={respPaneRef} className="flex-1 min-h-0 overflow-hidden">
                <CodeMirror
                  value={responseText}
                  extensions={responseExtensions}
                  theme="dark"
                  basicSetup={{ lineNumbers: true, foldGutter: false, highlightActiveLine: false, highlightActiveLineGutter: false, drawSelection: false }}
                  style={{ height: "100%" }}
                />
              </div>
            </div>
          </div>

        </div>{/* end content area */}
      </div>{/* end main row */}

      {/* Bottom resize handle — only shown in inline (non-maximized) mode */}
      {!maximized && (
        <div
          onMouseDown={onHeightDragStart}
          className="h-1 flex-shrink-0 bg-neutral-700 hover:bg-brand-500 cursor-row-resize transition-colors select-none"
          title="Drag to resize"
        />
      )}
    </div>
  )

  if (maximized) {
    return <>{inner}</>
  }

  return (
    <tr className="border-0">
      <td colSpan={10} className="p-0">
        {inner}
      </td>
    </tr>
  )
}
