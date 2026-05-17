"use client"

import { apiFetch } from "@/lib/api-fetch"

import { useEffect, useState, useLayoutEffect, useCallback, useRef, useMemo, Suspense } from "react"
import { useRouter, useSearchParams } from "next/navigation"
import { Button } from "@/components/ui/button"
import { Send, Loader2, Columns2, Rows2, Plus, X, PanelLeftClose, PanelLeftOpen } from "lucide-react"
import CodeMirror, { EditorView, keymap } from "@uiw/react-codemirror"
import { atomoneInit } from "@uiw/codemirror-theme-atomone"
import { StreamLanguage } from "@codemirror/language"
import { http as httpMode } from "@codemirror/legacy-modes/mode/http"
import { css as cssMode } from "@codemirror/legacy-modes/mode/css"
import { xml as xmlMode } from "@codemirror/legacy-modes/mode/xml"
import { javascript as jsMode } from "@codemirror/legacy-modes/mode/javascript"
import { json } from "@codemirror/lang-json"
import { html } from "@codemirror/lang-html"
import { defaultKeymap, indentWithTab } from "@codemirror/commands"
import { EditorState } from "@codemirror/state"
import { html as beautifyHtml, js as beautifyJs, css as beautifyCss } from "js-beautify"

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000"

// ── Default request ───────────────────────────────────────────────────────

const DEFAULT_RAW = "GET / HTTP/1.1\nHost: example.com\n\n"
const DEFAULT_LABEL = "GET example.com"

// ── CodeMirror theme ──────────────────────────────────────────────────────

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

// ── Interfaces ────────────────────────────────────────────────────────────

interface GnawTab {
  id: string
  project_id: string
  label: string
  position: number
  raw_request: string | null
  response: ResponseData | null
  // Summary fields returned by the list endpoint (JSON_EXTRACT from response column)
  status_code: number | null
  response_time: number | null
  created_at: string
  updated_at: string
}

interface ResponseData {
  status_code: number
  response_headers: Record<string, string>
  response_body: string
  response_time: number
}

// ── Helpers ────────────────────────────────────────────────────────────────

function headersToText(headers: Record<string, string> | null | undefined): string {
  if (!headers) return ""
  return Object.entries(headers).map(([k, v]) => `${k}: ${v}`).join("\n")
}

function textToHeaders(text: string): Record<string, string> {
  const result: Record<string, string> = {}
  for (const line of text.split("\n")) {
    const idx = line.indexOf(":")
    if (idx > 0) {
      const key = line.slice(0, idx).trim()
      const val = line.slice(idx + 1).trim()
      if (key) result[key] = val
    }
  }
  return result
}

function parseRaw(raw: string): { method: string; url: string; headersText: string; body: string } {
  const lines = raw.split("\n")
  const firstParts = (lines[0] ?? "").split(" ")
  const method = firstParts[0] ?? "GET"
  const rawPath = firstParts[1] ?? "/"

  let host = ""
  let blankIdx = -1
  const headerLines: string[] = []
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === "") { blankIdx = i; break }
    headerLines.push(lines[i])
    if (lines[i].toLowerCase().startsWith("host:")) host = lines[i].slice(5).trim()
  }

  const url = host ? `https://${host}${rawPath}` : rawPath
  const headersText = headerLines.filter(l => !l.toLowerCase().startsWith("host:")).join("\n")
  const body = blankIdx >= 0 ? lines.slice(blankIdx + 1).join("\n") : ""
  return { method, url, headersText, body }
}

function labelFromRaw(raw: string): string {
  const { method, url } = parseRaw(raw)
  try {
    const host = new URL(url).host
    return `${method} ${host}`.trim()
  } catch {
    return method || "New Tab"
  }
}

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

// ── Shared CM extensions ──────────────────────────────────────────────────

const baseExtensions = [cmTheme, cmOverrides, EditorView.lineWrapping]

// ── ResponsePanel ─────────────────────────────────────────────────────────

type ResponseView = "pretty" | "render"

function ResponsePanel({ response, view, isDragging }: { response: ResponseData; view: ResponseView; isDragging?: boolean }) {
  const { combinedText, contentType } = useMemo(() => {
    const statusLine = `HTTP/1.1 ${response.status_code ?? "???"}`
    const headersText = headersToText(response.response_headers)
    const headersSection = headersText ? `${statusLine}\n${headersText}` : statusLine
    const ct = response.response_headers
      ? Object.entries(response.response_headers).find(([k]) => k.toLowerCase() === "content-type")?.[1] ?? null
      : null
    const body = beautifyBody(response.response_body ?? "", ct)
    const combined = body.trim() ? `${headersSection}\n\n${body}` : headersSection
    return { combinedText: combined, contentType: ct }
  }, [response])

  const bodyLangExt = useMemo(() => langExtFromContentType(contentType), [contentType])
  const responseExtensions = useMemo(() => [
    ...baseExtensions,
    ...(Array.isArray(bodyLangExt) ? bodyLangExt : [bodyLangExt]),
    EditorState.readOnly.of(true),
  ], [bodyLangExt])

  if (view === "render") {
    return (
      <div className="flex-1 min-h-0 relative">
        <iframe
          srcDoc={response.response_body ?? ""}
          sandbox="allow-scripts"
          className="absolute inset-0 w-full h-full bg-white border-0"
          title="Rendered HTML response"
        />
        {/* Transparent shield prevents iframe from capturing mouse events during drag */}
        {isDragging && (
          <div className="absolute inset-0 z-10" style={{ cursor: "inherit" }} />
        )}
      </div>
    )
  }

  return (
    <div className="flex-1 min-h-0">
      <CodeMirror
        value={combinedText}
        extensions={responseExtensions}
        theme="dark"
        basicSetup={{ lineNumbers: true, foldGutter: false, highlightActiveLine: false, highlightActiveLineGutter: false, drawSelection: false }}
        style={{ height: "100%" }}
      />
    </div>
  )
}

// ── API helpers ───────────────────────────────────────────────────────────

async function apiCreateTab(rawRequest: string, label: string): Promise<GnawTab | null> {
  try {
    const res = await apiFetch(`${API_BASE}/api/gnaw/tabs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ raw_request: rawRequest, label }),
    })
    if (!res.ok) return null
    return await res.json()
  } catch {
    return null
  }
}

async function apiGetTab(tabId: string): Promise<GnawTab | null> {
  try {
    const res = await apiFetch(`${API_BASE}/api/gnaw/tabs/${tabId}`)
    if (!res.ok) return null
    return await res.json()
  } catch {
    return null
  }
}

async function apiUpdateTab(tabId: string, label: string, rawRequest: string): Promise<void> {
  try {
    await apiFetch(`${API_BASE}/api/gnaw/tabs/${tabId}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ label, raw_request: rawRequest }),
    })
  } catch { /* ignore */ }
}

async function apiDeleteTab(tabId: string): Promise<void> {
  try {
    await apiFetch(`${API_BASE}/api/gnaw/tabs/${tabId}`, { method: "DELETE" })
  } catch { /* ignore */ }
}

// ── Main page ──────────────────────────────────────────────────────────────

type Layout = "side" | "stack"

// Pre-parse the default raw request once at module level (constant)
const _DEFAULT_PARSED = parseRaw(DEFAULT_RAW)

function GnawPageInner() {
  const router = useRouter()
  const searchParams = useSearchParams()

  // Sidebar visibility + width
  const [sidebarOpen, setSidebarOpen] = useState(true)
  const [sidebarWidth, setSidebarWidth] = useState(160)
  const sidebarWidthRef = useRef(160)
  const sidebarDragging = useRef(false)
  const sidebarDragStart = useRef(0)
  const sidebarWidthStart = useRef(0)
  const [widthsReady, setWidthsReady] = useState(false)

  // Read persisted sidebar state synchronously before first paint — no flash, no snap
  useLayoutEffect(() => {
    const sw = Number(localStorage.getItem("ferret_gnaw_sidebar_width"))
    if (sw > 0) { setSidebarWidth(sw); sidebarWidthRef.current = sw }
    const so = localStorage.getItem("ferret_gnaw_sidebar_open")
    if (so !== null) setSidebarOpen(so === "true")
    const lo = localStorage.getItem("ferret_gnaw_layout")
    if (lo === "side" || lo === "stack") { setLayout(lo); layoutRef.current = lo }
    setWidthsReady(true)
  }, [])

  // Tab list
  const [tabs, setTabs] = useState<GnawTab[]>([])
  const [activeTabId, setActiveTabId] = useState<string | null>(null)
  const [tabsLoading, setTabsLoading] = useState(true)

  // Editor state — pre-populate from DEFAULT_RAW so Send is enabled immediately
  const [rawRequest, setRawRequest] = useState(DEFAULT_RAW)
  const [response, setResponse] = useState<ResponseData | null>(null)
  const [sending, setSending] = useState(false)
  const [sendError, setSendError] = useState<string | null>(null)
  const [layout, setLayout] = useState<Layout>("side")
  const [responseView, setResponseView] = useState<ResponseView>("pretty")

  // Parsed fields — initialised from DEFAULT_RAW so url is non-empty on first render
  const [method, setMethod] = useState(_DEFAULT_PARSED.method)
  const [url, setUrl] = useState(_DEFAULT_PARSED.url)
  const [headersText, setHeadersText] = useState(_DEFAULT_PARSED.headersText)
  const [body, setBody] = useState(_DEFAULT_PARSED.body)

  // Drag state (req/res panels)
  const panelsRef = useRef<HTMLDivElement>(null)
  const panelReqRef = useRef<HTMLDivElement>(null)
  const panelResRef = useRef<HTMLDivElement>(null)
  const dragging = useRef(false)
  const dragStart = useRef(0)
  const reqSizeStart = useRef(0)
  const [reqSize, setReqSize] = useState<number | null>(null)
  const [resSize, setResSize] = useState<number | null>(null)
  // True while any drag is active — suppresses CSS transitions and shields iframes
  const [isDraggingAny, setIsDraggingAny] = useState(false)

  // Per-tab UI state: req/res split sizes, layout, and response view mode
  interface TabUiState { reqSize: number | null; resSize: number | null; layout: Layout; responseView: ResponseView }
  const tabUiStateRef = useRef<Map<string, TabUiState>>(new Map())
  // Refs to always-current values for use inside event handlers (avoids stale closures)
  const reqSizeRef = useRef<number | null>(null)
  const resSizeRef = useRef<number | null>(null)
  const layoutRef = useRef<Layout>("side")
  const responseViewRef = useRef<ResponseView>("pretty")
  const activeTabIdRef = useRef<string | null>(null)
  const saveTabUiStateRef = useRef<(tabId: string) => void>(() => {})

  // Keep layoutRef in sync with layout state
  useEffect(() => { layoutRef.current = layout }, [layout])

  const saveTabUiState = useCallback((tabId: string) => {
    const state: TabUiState = {
      reqSize: reqSizeRef.current,
      resSize: resSizeRef.current,
      layout: layoutRef.current,
      responseView: responseViewRef.current,
    }
    tabUiStateRef.current.set(tabId, state)
    try {
      localStorage.setItem(
        `ferret_gnaw_tab_ui:${tabId}`,
        JSON.stringify(state),
      )
    } catch { /* quota exceeded — ignore */ }
  }, [])

  const restoreTabUiState = useCallback((tabId: string) => {
    // Prefer in-memory (already loaded this session), fall back to localStorage
    let saved = tabUiStateRef.current.get(tabId)
    if (!saved) {
      try {
        const raw = localStorage.getItem(`ferret_gnaw_tab_ui:${tabId}`)
        if (raw) {
          const parsed = JSON.parse(raw) as TabUiState
          tabUiStateRef.current.set(tabId, parsed)
          saved = parsed
        }
      } catch { /* corrupt entry — ignore */ }
    }
    if (saved) {
      // Restore layout first — sizes are only valid for the layout they were captured in.
      // Fall back to layoutRef (already set from global localStorage key) if not in saved state.
      const restoredLayout = saved.layout ?? layoutRef.current
      setLayout(restoredLayout)
      layoutRef.current = restoredLayout
      setReqSize(saved.reqSize)
      setResSize(saved.resSize)
      setResponseView(saved.responseView)
      reqSizeRef.current = saved.reqSize
      resSizeRef.current = saved.resSize
      responseViewRef.current = saved.responseView
    } else {
      setReqSize(null)
      setResSize(null)
      setResponseView("pretty")
      reqSizeRef.current = null
      resSizeRef.current = null
      responseViewRef.current = "pretty"
    }
  }, [])

  // Stable send ref
  const handleSendRef = useRef<() => void>(() => {})

  // Keep stable refs in sync so drag event handlers always see current values
  useEffect(() => { activeTabIdRef.current = activeTabId }, [activeTabId])
  useEffect(() => { saveTabUiStateRef.current = saveTabUiState }, [saveTabUiState])

  // Global Ctrl+Enter / Ctrl+Space — fires regardless of focus
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.key === "Enter" || e.key === " ") && e.ctrlKey) {
        e.preventDefault()
        handleSendRef.current()
      }
    }
    document.addEventListener("keydown", onKeyDown)
    return () => document.removeEventListener("keydown", onKeyDown)
  }, [])

  // ── Load tab content ────────────────────────────────────────────────────

  const loadTabContent = useCallback(async (tab: GnawTab) => {
    const full = await apiGetTab(tab.id)
    const raw = full?.raw_request ?? DEFAULT_RAW
    setRawRequest(raw)
    const parsed = parseRaw(raw)
    setMethod(parsed.method)
    setUrl(parsed.url)
    setHeadersText(parsed.headersText)
    setBody(parsed.body)
    if (full?.response) {
      setResponse(full.response as ResponseData)
      // Do NOT set responseView here — caller (handleTabClick/init) restores it via restoreTabUiState
    } else {
      setResponse(null)
    }
  }, [])

  // ── Load tabs on mount ──────────────────────────────────────────────────

  useEffect(() => {
    let cancelled = false

    async function init() {
      setTabsLoading(true)
      try {
        let data: GnawTab[] = []
        try {
          const res = await apiFetch(`${API_BASE}/api/gnaw/tabs`)
          if (res.ok && !cancelled) data = await res.json()
        } catch { /* network error — fall through to create default */ }

        if (cancelled) return

        // Always ensure at least one tab exists
        if (data.length === 0) {
          const newTab = await apiCreateTab(DEFAULT_RAW, DEFAULT_LABEL)
          if (newTab && !cancelled) data = [newTab]
        }

        if (cancelled) return
        setTabs(data)

        const paramTabId = searchParams.get("tab")
        const target = (paramTabId && data.find(t => t.id === paramTabId)) ? paramTabId : data[0]?.id ?? null
        if (target) {
          setActiveTabId(target)
          restoreTabUiState(target)
          const tab = data.find(t => t.id === target)
          if (tab) await loadTabContent(tab)
        }
      } finally {
        if (!cancelled) setTabsLoading(false)
      }
    }

    init()
    return () => { cancelled = true }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // ── Tab click ───────────────────────────────────────────────────────────

  const handleTabClick = useCallback(async (tab: GnawTab) => {
    if (tab.id === activeTabId) return
    // Save current UI state + request before switching
    if (activeTabId) {
      saveTabUiState(activeTabId)
      await apiUpdateTab(activeTabId, labelFromRaw(rawRequest), rawRequest)
    }
    setActiveTabId(tab.id)
    setSendError(null)
    restoreTabUiState(tab.id)
    await loadTabContent(tab)
    router.replace(`/gnaw?tab=${tab.id}`)
  }, [activeTabId, rawRequest, loadTabContent, router, saveTabUiState, restoreTabUiState])

  // ── Create new tab ──────────────────────────────────────────────────────

  const handleNewTab = useCallback(async () => {
    const newTab = await apiCreateTab(DEFAULT_RAW, DEFAULT_LABEL)
    if (!newTab) return
    // Save current UI state + request before switching
    if (activeTabId) {
      saveTabUiState(activeTabId)
      await apiUpdateTab(activeTabId, labelFromRaw(rawRequest), rawRequest)
    }
    setTabs(prev => [...prev, newTab])
    setActiveTabId(newTab.id)
    setSendError(null)
    setRawRequest(DEFAULT_RAW)
    const parsed = parseRaw(DEFAULT_RAW)
    setMethod(parsed.method)
    setUrl(parsed.url)
    setHeadersText(parsed.headersText)
    setBody(parsed.body)
    setResponse(null)
    // New tab starts with default UI state
    setReqSize(null)
    setResSize(null)
    setResponseView("pretty")
    router.replace(`/gnaw?tab=${newTab.id}`)
  }, [activeTabId, rawRequest, router, saveTabUiState])

  // ── Delete tab ──────────────────────────────────────────────────────────

  const handleDeleteTab = useCallback(async (tabId: string, e: React.MouseEvent) => {
    e.stopPropagation()
    await apiDeleteTab(tabId)
    setTabs(prev => {
      const next = prev.filter(t => t.id !== tabId)
      if (tabId === activeTabId) {
        if (next.length > 0) {
          const target = next[0]
          setActiveTabId(target.id)
          loadTabContent(target)
          router.replace(`/gnaw?tab=${target.id}`)
        } else {
          // No tabs left — create a default one
          apiCreateTab(DEFAULT_RAW, DEFAULT_LABEL).then(newTab => {
            if (newTab) {
              setTabs([newTab])
              setActiveTabId(newTab.id)
              setRawRequest(DEFAULT_RAW)
              const parsed = parseRaw(DEFAULT_RAW)
              setMethod(parsed.method)
              setUrl(parsed.url)
              setHeadersText(parsed.headersText)
              setBody(parsed.body)
              setResponse(null)
              router.replace(`/gnaw?tab=${newTab.id}`)
            }
          })
        }
      }
      return next
    })
  }, [activeTabId, loadTabContent, router])

  // ── Raw request change ──────────────────────────────────────────────────

  const handleRawChange = (raw: string) => {
    setRawRequest(raw)
    const parsed = parseRaw(raw)
    setMethod(parsed.method)
    setUrl(parsed.url)
    setHeadersText(parsed.headersText)
    setBody(parsed.body)
  }

  // ── Send request ────────────────────────────────────────────────────────

  const handleSend = useCallback(async () => {
    if (!url.trim()) return
    setSending(true)
    setSendError(null)
    setResponse(null)

    let host = ""
    let path = "/"
    try {
      const parsed = new URL(url)
      host = parsed.host
      path = parsed.pathname + parsed.search
    } catch {
      setSendError("Invalid URL — please include the scheme, e.g. https://example.com/path")
      setSending(false)
      return
    }

    // Save + update label before sending
    const newLabel = `${method} ${host}`.trim() || DEFAULT_LABEL
    if (activeTabId) {
      await apiUpdateTab(activeTabId, newLabel, rawRequest)
      setTabs(prev => prev.map(t => t.id === activeTabId ? { ...t, label: newLabel } : t))
    }

    const payload = {
      id: crypto.randomUUID(),
      timestamp: new Date().toISOString(),
      method,
      url,
      host,
      path,
      headers: textToHeaders(headersText),
      body: body || null,
      content_length: body ? body.length : 0,
      intercepted: false,
      modified: false,
      source: "gnaw",
    }

    try {
      const endpoint = activeTabId
        ? `${API_BASE}/api/gnaw/tabs/${activeTabId}/send`
        : `${API_BASE}/api/gnaw/send`

      const res = await apiFetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      })
      if (!res.ok) {
        const err = await res.json().catch(() => ({ detail: res.statusText }))
        setSendError(err.detail ?? "Request failed")
        return
      }
      const data = await res.json()
      setResponse({
        status_code: data.status_code,
        response_headers: data.response_headers,
        response_body: data.response_body,
        response_time: data.response_time,
      })
      // Update sidebar summary fields immediately so status/time appear without refresh
      if (activeTabId) {
        setTabs(prev => prev.map(t =>
          t.id === activeTabId
            ? { ...t, status_code: data.status_code, response_time: data.response_time }
            : t
        ))
      }
      // Fresh response always starts in pretty view; update ref so UI state saves correctly
      responseViewRef.current = "pretty"
      setResponseView("pretty")
    } catch (err) {
      setSendError(err instanceof Error ? err.message : "Network error")
    } finally {
      setSending(false)
    }
  }, [method, url, headersText, body, rawRequest, activeTabId])

  useEffect(() => { handleSendRef.current = handleSend }, [handleSend])

  const submitKeymap = useMemo(() => keymap.of([
    { key: "Ctrl-Enter", run: () => { handleSendRef.current(); return true } },
    { key: "Ctrl-Space", run: () => { handleSendRef.current(); return true } },
  ]), [])

  const requestExtensions = useMemo(() => [
    ...baseExtensions,
    StreamLanguage.define(httpMode),
    submitKeymap,
    keymap.of([indentWithTab, ...defaultKeymap]),
  ], [submitKeymap])

  // ── Drag handle ─────────────────────────────────────────────────────────

  const handleDragStart = (e: React.MouseEvent) => {
    dragging.current = true
    dragStart.current = layout === "side" ? e.clientX : e.clientY
    const rect = panelReqRef.current?.getBoundingClientRect()
    reqSizeStart.current = rect ? (layout === "side" ? rect.width : rect.height) : 0
    setIsDraggingAny(true)
    e.preventDefault()
  }

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (!dragging.current || !panelsRef.current) return
      const containerRect = panelsRef.current.getBoundingClientRect()
      const containerSize = layout === "side" ? containerRect.width : containerRect.height
      const delta = layout === "side" ? e.clientX - dragStart.current : e.clientY - dragStart.current
      const newReq = Math.max(80, Math.min(containerSize - 80, reqSizeStart.current + delta))
      const newRes = containerSize - newReq - 4
      reqSizeRef.current = newReq
      resSizeRef.current = newRes
      setReqSize(newReq)
      setResSize(newRes)
    }
    const onUp = () => {
      dragging.current = false
      setIsDraggingAny(false)
      if (activeTabIdRef.current) saveTabUiStateRef.current(activeTabIdRef.current)
    }
    document.addEventListener("mousemove", onMove)
    document.addEventListener("mouseup", onUp)
    return () => {
      document.removeEventListener("mousemove", onMove)
      document.removeEventListener("mouseup", onUp)
    }
  }, [layout])

  // ── Sidebar drag handle ──────────────────────────────────────────────────

  const handleSidebarDragStart = (e: React.MouseEvent) => {
    sidebarDragging.current = true
    sidebarDragStart.current = e.clientX
    sidebarWidthStart.current = sidebarWidthRef.current
    setIsDraggingAny(true)
    e.preventDefault()
  }

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (!sidebarDragging.current) return
      const next = Math.max(100, Math.min(320, sidebarWidthStart.current + (e.clientX - sidebarDragStart.current)))
      sidebarWidthRef.current = next
      setSidebarWidth(next)
    }
    const onUp = () => {
      if (!sidebarDragging.current) return
      sidebarDragging.current = false
      setIsDraggingAny(false)
      localStorage.setItem("ferret_gnaw_sidebar_width", String(sidebarWidthRef.current))
    }
    document.addEventListener("mousemove", onMove)
    document.addEventListener("mouseup", onUp)
    return () => {
      document.removeEventListener("mousemove", onMove)
      document.removeEventListener("mouseup", onUp)
    }
  }, [])

  const switchLayout = (l: Layout) => {
    setLayout(l)
    layoutRef.current = l
    setReqSize(null); setResSize(null)
    reqSizeRef.current = null; resSizeRef.current = null
    localStorage.setItem("ferret_gnaw_layout", l)
    // Persist new layout into per-tab state immediately
    if (activeTabIdRef.current) saveTabUiStateRef.current(activeTabIdRef.current)
  }

  const reqStyle: React.CSSProperties = reqSize != null
    ? { flex: "none", [layout === "side" ? "width" : "height"]: reqSize }
    : { flex: "0 0 35%" }
  const resStyle: React.CSSProperties = resSize != null
    ? { flex: "none", [layout === "side" ? "width" : "height"]: resSize }
    : { flex: "0 0 65%" }

  const isHtml = (response?.response_headers
    ? Object.entries(response.response_headers).find(([k]) => k.toLowerCase() === "content-type")?.[1] ?? ""
    : ""
  ).toLowerCase().includes("html")

  // ── Render ──────────────────────────────────────────────────────────────

  if (!widthsReady) return <div className="flex flex-col h-full overflow-hidden bg-neutral-950" />

  return (
    <div className="flex flex-col h-full overflow-hidden relative">
      {/* Page header */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-neutral-800 flex-shrink-0 bg-neutral-900">
        <div className="flex items-center gap-2">
          <h1 className="text-sm font-bold text-white">Gnaw</h1>
          <span className="text-neutral-600 text-xs font-mono truncate max-w-xs">{url || "—"}</span>
        </div>
        <div className="flex items-center gap-1">
          {response?.status_code != null && (
            <span className={`px-2 py-0.5 border text-xs font-mono mr-1 ${
              response.status_code < 300 ? "bg-green-900/40 border-green-700 text-green-300"
              : response.status_code < 400 ? "bg-yellow-900/40 border-yellow-700 text-yellow-300"
              : "bg-red-900/40 border-red-700 text-red-300"
            }`}>{response.status_code}</span>
          )}
          {response?.response_time != null && (
            <span className="text-xs text-neutral-500 font-mono mr-2">{response.response_time.toFixed(0)}ms</span>
          )}
          <div className="flex mr-1">
            <Button variant="ghost" size="sm"
              className={`h-6 px-2 text-xs rounded-none border border-neutral-700 ${layout === "side" ? "bg-neutral-800 text-orange-400 border-orange-700" : "text-neutral-500 hover:text-neutral-300"}`}
              onClick={() => switchLayout("side")} title="Side by side">
              <Columns2 className="w-3 h-3" />
            </Button>
            <Button variant="ghost" size="sm"
              className={`h-6 px-2 text-xs rounded-none border border-l-0 border-neutral-700 ${layout === "stack" ? "bg-neutral-800 text-orange-400 border-orange-700" : "text-neutral-500 hover:text-neutral-300"}`}
              onClick={() => switchLayout("stack")} title="Stacked">
              <Rows2 className="w-3 h-3" />
            </Button>
          </div>
          <Button variant="ghost" size="sm"
            className="h-7 text-xs text-orange-400 hover:text-orange-300 hover:bg-orange-900/20"
            onClick={handleSend} disabled={sending || !url.trim()}
            title="Send (Ctrl+Enter or Ctrl+Space)">
            {sending ? <Loader2 className="w-3 h-3 mr-1 animate-spin" /> : <Send className="w-3 h-3 mr-1" />}
            {sending ? "Sending..." : "Send"}
          </Button>
        </div>
      </div>

      {/* Error banner */}
      {sendError && (
        <div className="bg-red-900/40 border-b border-red-700 text-red-300 px-4 py-1.5 text-xs flex-shrink-0">
          ⚠ {sendError}
        </div>
      )}

      {/* Body: sidebar + panels */}
      <div className="flex flex-1 min-h-0 overflow-hidden">

        {/* Left sidebar — always rendered, width-animated for slide in/out (no transition during drag) */}
        <div
          className="flex flex-col flex-shrink-0 bg-neutral-950 overflow-hidden"
          style={{
            width: sidebarOpen ? `${sidebarWidth}px` : "0px",
            borderRightWidth: sidebarOpen ? "1px" : "0px",
            borderRightColor: "#262626",
            borderRightStyle: "solid",
          }}
        >
          {/* Sidebar inner — fixed width so content doesn't reflow during animation */}
          <div className="flex flex-col h-full" style={{ width: `${sidebarWidth}px` }}>
            {/* Sidebar header — same height/style as Request/Response headers */}
            <div className="flex items-center justify-between h-9 px-3 border-b border-neutral-800 bg-neutral-900/60 flex-shrink-0">
              <span className="text-xs font-semibold text-white">Tabs</span>
              <div className="flex items-center gap-1">
                <button onClick={handleNewTab}
                  className="text-neutral-500 hover:text-orange-400 transition-colors"
                  title="New tab">
                  <Plus className="w-3 h-3" />
                </button>
                <button onClick={() => { setSidebarOpen(false); localStorage.setItem("ferret_gnaw_sidebar_open", "false") }}
                  className="text-neutral-500 hover:text-neutral-300 transition-colors"
                  title="Hide sidebar">
                  <PanelLeftClose className="w-3 h-3" />
                </button>
              </div>
            </div>
            <div className="flex-1 overflow-y-auto">
              {tabsLoading ? (
                <div className="flex items-center justify-center py-4">
                  <Loader2 className="w-3 h-3 animate-spin text-neutral-600" />
                </div>
              ) : (
                tabs.map(tab => {
                  // Extract method + host from label ("GET example.com")
                  const tabMethod = tab.label.split(" ")[0] ?? "?"
                  const tabHost = tab.label.split(" ").slice(1).join(" ") || "—"
                  // For the active tab use live rawRequest so path updates as user types
                  const effectiveRaw = tab.id === activeTabId ? rawRequest : (tab.raw_request ?? "")
                  const rawFirstLine = effectiveRaw.split("\n")[0] ?? ""
                  const tabPath = rawFirstLine.split(" ")[1] ?? "/"
                  // Use flat summary fields from list endpoint
                  const sc = tab.status_code ?? null
                  const rt = tab.response_time ?? null
                  const scColor = sc == null ? "" : sc < 300 ? "text-green-400" : sc < 400 ? "text-yellow-400" : "text-red-400"
                  const scBg = sc == null ? "" : sc < 300 ? "bg-green-900/30" : sc < 400 ? "bg-yellow-900/30" : "bg-red-900/30"
                  const methodColor =
                    tabMethod === "GET" ? "text-blue-400" :
                    tabMethod === "POST" ? "text-green-400" :
                    tabMethod === "PUT" ? "text-yellow-400" :
                    tabMethod === "DELETE" ? "text-red-400" :
                    tabMethod === "PATCH" ? "text-purple-400" : "text-neutral-400"
                  return (
                    <div key={tab.id}
                      onClick={() => handleTabClick(tab)}
                      className={`group flex flex-col px-2 py-1.5 cursor-pointer border-b border-neutral-800/50 gap-0.5 ${
                        tab.id === activeTabId
                          ? "bg-neutral-800"
                          : "hover:bg-neutral-900"
                      }`}>
                      {/* Row 1: method badge + host + delete button */}
                      <div className="flex items-center gap-1 min-w-0">
                        <span className={`text-[9px] font-bold font-mono flex-shrink-0 ${tab.id === activeTabId ? "text-orange-400" : methodColor}`}>
                          {tabMethod}
                        </span>
                        <span className={`flex-1 text-[10px] font-mono truncate min-w-0 ${tab.id === activeTabId ? "text-orange-300" : "text-neutral-300"}`} title={tabHost}>
                          {tabHost}
                        </span>
                        <button onClick={(e) => handleDeleteTab(tab.id, e)}
                          className="opacity-0 group-hover:opacity-100 text-neutral-600 hover:text-red-400 transition-all flex-shrink-0"
                          title="Delete tab">
                          <X className="w-2.5 h-2.5" />
                        </button>
                      </div>
                      {/* Row 2: path */}
                      <div className={`text-[9px] font-mono truncate ${tab.id === activeTabId ? "text-neutral-500" : "text-neutral-600"}`} title={tabPath}>
                        {tabPath}
                      </div>
                      {/* Row 3: status badge + response time (only if response exists) */}
                      {sc != null && (
                        <div className="flex items-center gap-1.5 mt-0.5">
                          <span className={`text-[9px] font-mono font-bold px-1 rounded-sm ${scColor} ${scBg}`}>{sc}</span>
                          {rt != null && (
                            <span className="text-[9px] font-mono text-neutral-600">{rt.toFixed(0)}ms</span>
                          )}
                        </div>
                      )}
                    </div>
                  )
                })
              )}
            </div>
          </div>
        </div>

        {/* Sidebar resize handle — sibling to sidebar, only visible when open */}
        {sidebarOpen && (
          <div
            className="w-1 flex-shrink-0 bg-neutral-800 hover:bg-orange-500 transition-colors cursor-col-resize z-10"
            onMouseDown={handleSidebarDragStart}
          />
        )}

        {/* Two-panel layout */}
        <div ref={panelsRef}
          className={`flex flex-1 min-h-0 overflow-hidden ${layout === "stack" ? "flex-col" : "flex-row"}`}>

          {/* Request panel */}
          <div ref={panelReqRef}
            className="flex flex-col min-h-0 min-w-0 overflow-hidden"
            style={reqStyle}>
            <div className="flex items-center h-9 px-3 border-b border-neutral-800 bg-neutral-900/60 flex-shrink-0">
              {!sidebarOpen && (
                <button onClick={() => { setSidebarOpen(true); localStorage.setItem("ferret_gnaw_sidebar_open", "true") }}
                  className="text-neutral-500 hover:text-neutral-300 transition-colors mr-2"
                  title="Show sidebar">
                  <PanelLeftOpen className="w-3 h-3" />
                </button>
              )}
              <span className="text-xs font-semibold text-white">Request</span>
            </div>
            <div className="flex-1 min-h-0 overflow-hidden">
              <CodeMirror
                value={rawRequest}
                onChange={handleRawChange}
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
                placeholder={"GET /path HTTP/1.1\nHost: example.com\n\n"}
                style={{ height: "100%" }}
              />
            </div>
          </div>

          {/* Drag handle */}
          <div
            className={`flex-shrink-0 bg-neutral-800 hover:bg-orange-500 transition-colors z-10 ${
              layout === "side" ? "w-1 cursor-col-resize" : "h-1 cursor-row-resize w-full"
            }`}
            onMouseDown={handleDragStart}
          />

          {/* Response panel */}
          <div ref={panelResRef}
            className="flex flex-col min-h-0 min-w-0 overflow-hidden"
            style={resStyle}>
            <div className="flex items-center gap-2 h-9 px-3 border-b border-neutral-800 bg-neutral-900/60 flex-shrink-0">
              <span className="text-xs font-semibold text-white">Response</span>
              {response && (
                <div className="flex items-center gap-0.5 ml-1">
                  <button
                    onClick={() => {
                      responseViewRef.current = "pretty"
                      setResponseView("pretty")
                      if (activeTabId) saveTabUiState(activeTabId)
                    }}
                    className={`text-xs px-2 py-0.5 rounded ${responseView === "pretty" ? "bg-neutral-700 text-white" : "text-neutral-500 hover:text-neutral-300"}`}
                  >Pretty</button>
                  {isHtml && (
                    <button
                      onClick={() => {
                        responseViewRef.current = "render"
                        setResponseView("render")
                        if (activeTabId) saveTabUiState(activeTabId)
                      }}
                      className={`text-xs px-2 py-0.5 rounded ${responseView === "render" ? "bg-neutral-700 text-white" : "text-neutral-500 hover:text-neutral-300"}`}
                    >Render</button>
                  )}
                </div>
              )}
            </div>
            {response ? (
              <ResponsePanel response={response} view={responseView} isDragging={isDraggingAny} />
            ) : (
              <div className="flex-1 min-h-0 flex items-center justify-center text-neutral-600 text-xs font-mono bg-neutral-950">
                {sending ? (
                  <span className="flex items-center gap-2 text-neutral-500">
                    <Loader2 className="w-3 h-3 animate-spin" />
                    Sending...
                  </span>
                ) : (
                  "No response yet — Ctrl+Enter or Ctrl+Space to send"
                )}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

export default function GnawPage() {
  return (
    <Suspense>
      <GnawPageInner />
    </Suspense>
  )
}
