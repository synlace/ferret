"use client"

import React, { useState, useEffect, useLayoutEffect, useCallback, useRef, Suspense } from "react"
import { useSearchParams } from "next/navigation"
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore
import ReactMarkdown from "react-markdown"
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore
import remarkGfm from "remark-gfm"
import { Textarea } from "@/components/ui/textarea"
import {
  Plus, Trash2, Loader2, ChevronRight,
  Pencil, Download, Send, Square,
  PanelLeftClose, PanelLeftOpen, PanelRight, LayoutDashboard,
  Terminal, FileCode, FileText,
} from "lucide-react"
import { useProject } from "../context/project-context"
import { NewChatModal, SCOPE_LABELS, SCOPE_ICONS } from "../chat/NewChatModal"
import { ModelPickerModal } from "../projects/ModelPickerModal"
import { ScopePickerModal } from "../chat/ScopePickerModal"
import {
  ToolGroup, CopyButton, parseMeta, formatTs, nowTs,
} from "./tool-views"
import { FileTree, WorkspaceFile } from "./FileTree"
import { FileEditor } from "./FileEditor"
import { NewFileModal } from "./NewFileModal"

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000"
const DEFAULT_CHAT_MODEL = "google/gemini-3-flash-preview"
const lastSessionKey = (projectId: string) => `ferret_last_chat_session:${projectId}`

// ─── Interfaces ───────────────────────────────────────────────────────────────
interface WorkspaceSession {
  id: string; name: string; scope: string
  scope_data: Record<string, unknown> | null
  workspace_dir: string | null; created_at: string
}
interface ChatMsg {
  role: "user" | "assistant" | "tool" | "notice"; content: string | null
  name?: string; toolArgs?: string; toolArgsRaw?: string
  tool_call_id?: string
  tool_calls?: Array<{ id: string; type: string; function: { name: string; arguments: string } }>
  timestamp?: string
  exitCode?: number | null
  runtimeMs?: number | null
  rationale?: string
}
interface LiveToolCall {
  name: string
  toolArgsRaw?: string
  result: string | null
  exitCode?: number | null
  runtimeMs?: number | null
  startedAt: number
  liveChunks?: string[]
  rationale?: string
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function formatToolArgs(toolName: string, argsJson: string): string {
  try {
    const args = JSON.parse(argsJson)
    if (toolName === "run_script" || toolName === "run_command") return args.command ?? args.script ?? argsJson
    if (toolName === "get_request_detail") return `request ${args.request_id ?? ""}`
    if (toolName === "search_requests") return args.query ?? argsJson
    if (toolName === "run_ffuf") return `ffuf ${args.url ?? ""}`
    if (toolName === "run_sqlmap") return `sqlmap ${args.url ?? ""}`
    if (toolName === "run_pytest") return args.test_file ?? argsJson
    if (toolName === "http_request") return `${args.method ?? "GET"} ${args.url ?? ""}`
    // Exclude rationale from the summary line — it has its own sub-panel
    const { rationale: _r, ...rest } = args
    return Object.values(rest).slice(0, 2).join(", ") || argsJson
  } catch { return argsJson }
}

/** Extract the rationale string from a tool call arguments JSON string. */
function extractRationale(argsJson: string | undefined): string | undefined {
  if (!argsJson) return undefined
  try { const r = JSON.parse(argsJson).rationale; return typeof r === "string" && r.trim() ? r.trim() : undefined } catch { return undefined }
}

function annotateToolArgs(msgs: ChatMsg[]): ChatMsg[] {
  // Build map: tool_call_id → function definition
  const fnMap: Record<string, { name: string; arguments: string }> = {}
  for (const m of msgs) {
    if (m.tool_calls) for (const tc of m.tool_calls) fnMap[tc.id] = tc.function
  }
  return msgs.map(msg => {
    if (msg.role === "tool" && msg.name) {
      const fn = (msg.tool_call_id && fnMap[msg.tool_call_id]) || Object.values(fnMap).find(f => f.name === msg.name)
      if (fn) {
        const { meta } = parseMeta(msg.content)
        return {
          ...msg,
          toolArgs: formatToolArgs(fn.name, fn.arguments),
          toolArgsRaw: fn.arguments,
          exitCode: meta.exit_code ?? null,
          runtimeMs: meta.runtime_ms ?? null,
          timestamp: (meta.timestamp ?? msg.timestamp) as string | undefined,
          // Rationale is embedded in the tool call arguments by the model
          rationale: extractRationale(fn.arguments),
        }
      }
    }
    return msg
  })
}

// ─── MarkdownContent ──────────────────────────────────────────────────────────
interface MdProps { className?: string; children?: React.ReactNode; href?: string }
function MarkdownContent({ content }: { content: string }) {
  return (
    <ReactMarkdown remarkPlugins={[remarkGfm]} components={{
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      code({ className, children, ...props }: any) {
        const match = /language-(\w+)/.exec(className || "")
        if (match) {
          const text = typeof children === "string" ? children : String(children ?? "")
          return (
            <div className="relative group my-2">
              <pre className="bg-neutral-900 border border-neutral-700 p-3 overflow-x-auto whitespace-pre-wrap break-all pr-10"><code className={className} {...props}>{children}</code></pre>
              <span className="absolute top-2 right-2 opacity-0 group-hover:opacity-100 transition-opacity">
                <CopyButton text={text} />
              </span>
            </div>
          )
        }
        return <code className="bg-neutral-800 px-1 text-orange-300 text-xs" {...props}>{children}</code>
      },
      blockquote({ children }: MdProps) { return <blockquote className="border-l-2 border-orange-500 pl-3 my-2 text-neutral-400 italic">{children}</blockquote> },
      a({ href, children }: MdProps) { return <a href={href} target="_blank" rel="noopener noreferrer" className="text-orange-400 underline hover:text-orange-300">{children}</a> },
      table({ children }: MdProps) { return <div className="overflow-x-auto my-2"><table className="text-xs border-collapse w-full">{children}</table></div> },
    }}>{content}</ReactMarkdown>
  )
}

// ─── WorkspacesPageInner ──────────────────────────────────────────────────────
function WorkspacesPageInner() {
  const { activeProjectId, activeProject } = useProject()
  const searchParams = useSearchParams()

  const [sessions, setSessions] = useState<WorkspaceSession[]>([])
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null)
  const activeSession = sessions.find(s => s.id === activeSessionId) ?? null

  const [messages, setMessages] = useState<ChatMsg[]>([])
  const [input, setInput] = useState("")
  const [loading, setLoading] = useState(false)
  const [loadingHistory, setLoadingHistory] = useState(false)
  const [streamingContent, setStreamingContent] = useState("")
  const [liveToolCalls, setLiveToolCalls] = useState<LiveToolCall[]>([])
  const [model, setModel] = useState(DEFAULT_CHAT_MODEL)
  const [maxToolCalls, setMaxToolCalls] = useState(() => {
    if (typeof window === "undefined") return 10
    const saved = localStorage.getItem("ferret_max_tool_calls")
    return saved !== null ? Number(saved) : 10
  })
  const [sessionSpend, setSessionSpend] = useState<number | null>(null)

  const abortControllerRef = useRef<AbortController | null>(null)
  const pendingNoticeRef = useRef<ChatMsg | null>(null)
  // Collapse state for ToolGroup — keyed by persistKey. Stored in a ref so
  // toggling doesn't cause a full re-render; a separate counter forces a
  // targeted re-render only when the user actually clicks a toggle.
  const toolGroupCollapsed = useRef<Map<string, boolean>>(new Map())
  const [, forceToolGroupRender] = useState(0)
  const handleToolGroupToggle = (key: string, collapsed: boolean) => {
    toolGroupCollapsed.current.set(key, collapsed)
    // live:N keys are ephemeral — never write to localStorage to avoid stale auto-open on next session
    if (key && !key.startsWith("live:")) {
      try { localStorage.setItem(`tg:${key}`, collapsed ? "1" : "0") } catch { /**/ }
    }
    forceToolGroupRender(n => n + 1)
  }
  const getToolGroupCollapsed = (key: string, defaultVal = true): boolean => {
    if (toolGroupCollapsed.current.has(key)) return toolGroupCollapsed.current.get(key)!
    // live:N keys are ephemeral — always use defaultVal, never read stale localStorage
    if (key.startsWith("live:")) {
      toolGroupCollapsed.current.set(key, defaultVal)
      return defaultVal
    }
    try {
      const stored = localStorage.getItem(`tg:${key}`)
      const val = stored !== null ? stored !== "0" : defaultVal
      toolGroupCollapsed.current.set(key, val)
      return val
    } catch { return defaultVal }
  }
  const inputHistoryRef = useRef<string[]>([])
  const historyIdxRef = useRef<number>(-1)
  const inputDraftRef = useRef<string>("")
  const chatInputRef = useRef<HTMLTextAreaElement>(null)
  const focusChatInputRef = useRef(false)
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const scrollContainerRef = useRef<HTMLDivElement>(null)
  const scrollPositions = useRef<Map<string, number>>(new Map())
  const isRestoringScroll = useRef(false)
  const shouldAutoScroll = useRef(true)
  const streamDoneReceived = useRef(false)

  const [workspaceFiles, setWorkspaceFiles] = useState<WorkspaceFile[]>([])
  const [selectedFilePath, setSelectedFilePath] = useState<string | null>(null)
  const [showNewFileModal, setShowNewFileModal] = useState(false)

  const [sessionFileCounts, setSessionFileCounts] = useState<Record<string, { scripts: number; tests: number; notes: number }>>({})

  const [sessionPanelOpen, setSessionPanelOpen] = useState(true)
  const [leftWidth, setLeftWidth] = useState(216)
  const leftWidthRef = useRef(216)
  const leftDragging = useRef(false)
  const leftDragStart = useRef(0)
  const leftWidthStart = useRef(0)
  const [isDraggingAny, setIsDraggingAny] = useState(false)

  const [contextOpen, setContextOpen] = useState(true)
  const [rightWidth, setRightWidth] = useState(240)
  const rightWidthRef = useRef(240)
  const [widthsReady, setWidthsReady] = useState(false)

  // Read persisted panel state synchronously before first paint — no flash, no snap
  useLayoutEffect(() => {
    const panelSaved = localStorage.getItem("ferret_session_panel_open")
    if (panelSaved !== null) setSessionPanelOpen(panelSaved === "true")
    const lw = Number(localStorage.getItem("ferret_ws_left_width"))
    if (lw > 0) { setLeftWidth(lw); leftWidthRef.current = lw }
    const rw = Number(localStorage.getItem("ferret_ws_right_width"))
    if (rw > 0) { setRightWidth(rw); rightWidthRef.current = rw }
    setWidthsReady(true)
  }, [])
  const rightDragging = useRef(false)
  const rightDragStart = useRef(0)
  const rightWidthStart = useRef(0)

  const toggleSessionPanel = () => setSessionPanelOpen(prev => {
    const next = !prev; localStorage.setItem("ferret_session_panel_open", String(next)); return next
  })
  const [contextRequests, setContextRequests] = useState<Array<{ id: string; method: string; host: string; path: string; status_code: number | null }>>([])
  const [contextReqLoading, setContextReqLoading] = useState(false)
  const [reqPage, setReqPage] = useState(0)
  const REQ_PAGE_SIZE = 25
  const [showNewModal, setShowNewModal] = useState(false)
  const [showScopePicker, setShowScopePicker] = useState(false)
  const [showModelPicker, setShowModelPicker] = useState(false)

  const modelDisplayName = model.includes("/") ? model.split("/").pop()! : model
  const userOverrodeModel = useRef(false)
  useEffect(() => {
    if (!userOverrodeModel.current && activeProject?.default_model) setModel(activeProject.default_model)
    userOverrodeModel.current = false
  }, [activeProject?.default_model])
  const handleModelSelect = (id: string) => { userOverrodeModel.current = true; setModel(id) }

  const [initialScope] = useState(() => searchParams.get("requestId") ? "single" : "blank")
  const [initialSelectedIds] = useState(() => { const r = searchParams.get("requestId"); return r ? [r] : [] })
  const [initialName] = useState(() => {
    const r = searchParams.get("requestId"); if (!r) return ""
    return `${searchParams.get("method") ?? ""} ${decodeURIComponent(searchParams.get("url") ?? "")}`.trim()
  })
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { if (searchParams.get("requestId")) setShowNewModal(true) }, [])

  const fetchSessions = useCallback(async () => {
    if (!activeProjectId) return []
    try {
      const res = await fetch(`${API_BASE}/api/chats?project_id=${activeProjectId}`)
      const data = await res.json()
      const chats = Array.isArray(data) ? data : (data.chats ?? [])
      setSessions(chats); return chats
    } catch { return [] }
  }, [activeProjectId])

  const fetchWorkspaceFiles = useCallback(async (sessionId: string) => {
    try {
      const res = await fetch(`${API_BASE}/api/workspaces/${sessionId}/files`)
      const data = await res.json()
      const files: WorkspaceFile[] = data.files ?? []
      setWorkspaceFiles(files)
      // Update sidebar counts for this session
      setSessionFileCounts(prev => ({
        ...prev,
        [sessionId]: {
          scripts: files.filter(f => f.subdir === "scripts").length,
          tests:   files.filter(f => f.subdir === "tests").length,
          notes:   files.filter(f => f.subdir === "notes").length,
        },
      }))
    } catch { setWorkspaceFiles([]) }
  }, [])

  // Fetch file counts for all sessions (lightweight sidebar population)
  const fetchAllFileCounts = useCallback(async (sessionList: WorkspaceSession[]) => {
    await Promise.all(sessionList.map(async s => {
      try {
        const res = await fetch(`${API_BASE}/api/workspaces/${s.id}/files`)
        const data = await res.json()
        const files: WorkspaceFile[] = data.files ?? []
        setSessionFileCounts(prev => ({
          ...prev,
          [s.id]: {
            scripts: files.filter(f => f.subdir === "scripts").length,
            tests:   files.filter(f => f.subdir === "tests").length,
            notes:   files.filter(f => f.subdir === "notes").length,
          },
        }))
      } catch { /* ignore */ }
    }))
  }, [])

  const handleMessagesScroll = () => {
    if (!scrollContainerRef.current || isRestoringScroll.current) return
    const el = scrollContainerRef.current
    shouldAutoScroll.current = el.scrollHeight - el.scrollTop - el.clientHeight < 150
    if (activeSessionId) {
      scrollPositions.current.set(activeSessionId, el.scrollTop)
      localStorage.setItem(`ferret_scroll:${activeSessionId}`, String(el.scrollTop))
    }
  }

  // Auto-refresh workspace files while the AI is streaming (tool calls write files).
  // Poll every 3 s during loading; stop when stream ends (fetchWorkspaceFiles is
  // also called explicitly on stream done).
  useEffect(() => {
    if (!activeSessionId || !loading) return
    const id = setInterval(() => { fetchWorkspaceFiles(activeSessionId) }, 3000)
    return () => clearInterval(id)
  }, [activeSessionId, loading, fetchWorkspaceFiles])

  useEffect(() => {
    if (!shouldAutoScroll.current) return
    messagesEndRef.current?.scrollIntoView({ behavior: "instant" })
  }, [messages, streamingContent])

  useEffect(() => {
    if (!activeSessionId || !scrollContainerRef.current) return
    const saved = scrollPositions.current.get(activeSessionId) ?? (() => {
      const v = localStorage.getItem(`ferret_scroll:${activeSessionId}`)
      return v !== null ? Number(v) : undefined
    })()
    if (saved !== undefined) {
      isRestoringScroll.current = true; shouldAutoScroll.current = false
      scrollContainerRef.current.scrollTop = saved
      requestAnimationFrame(() => { isRestoringScroll.current = false })
    } else {
      shouldAutoScroll.current = true
      scrollContainerRef.current.scrollTop = scrollContainerRef.current.scrollHeight
    }
  }, [activeSessionId, messages, selectedFilePath])

  const loadSession = useCallback(async (sessionId: string) => {
    // Capture any trailing notice that exists only in client state (e.g. "no API
    // key" warning) so we can re-append it after the server fetch overwrites state.
    // We read the ref synchronously — no setState needed.
    setMessages(prev => {
      const last = prev[prev.length - 1]
      pendingNoticeRef.current = (last?.role === "notice") ? last : null
      return prev
    })
    setActiveSessionId(sessionId); setSelectedFilePath(null)
    if (activeProjectId) localStorage.setItem(lastSessionKey(activeProjectId), sessionId)
    setLoadingHistory(true)
    try {
      const res = await fetch(`${API_BASE}/api/chats/${sessionId}/messages`)
      const data = await res.json()
      const fetched = annotateToolArgs(data.messages ?? [])
      // Re-append the notice if it wasn't already persisted in the server response
      const notice = pendingNoticeRef.current
      pendingNoticeRef.current = null
      const alreadyHasNotice = fetched.length > 0 && fetched[fetched.length - 1].role === "notice"
      setMessages(notice && !alreadyHasNotice ? [...fetched, notice] : fetched)
    } catch { /**/ } finally { setLoadingHistory(false) }
    fetchWorkspaceFiles(sessionId)
  }, [activeProjectId, fetchWorkspaceFiles])

  useEffect(() => {
    if (!activeProjectId) return
    fetchSessions().then(chats => {
      if (chats && chats.length > 0) fetchAllFileCounts(chats)
      const saved = localStorage.getItem(lastSessionKey(activeProjectId))
      if (saved && chats && chats.some((c: WorkspaceSession) => c.id === saved)) loadSession(saved)
    })
  }, [activeProjectId, fetchSessions, loadSession, fetchAllFileCounts])

  // Focus the chat input whenever a new workspace is created (flag set by onCreated)
  useEffect(() => {
    if (focusChatInputRef.current && activeSessionId) {
      focusChatInputRef.current = false
      chatInputRef.current?.focus()
    }
  }, [activeSessionId])

  useEffect(() => {
    if (!activeProjectId) { setContextRequests([]); return }
    setContextReqLoading(true)
    fetch(`${API_BASE}/api/requests?limit=200&project_id=${activeProjectId}`)
      .then(r => r.json()).then(data => setContextRequests(Array.isArray(data) ? data : (data.requests ?? data.items ?? [])))
      .catch(() => setContextRequests([])).finally(() => setContextReqLoading(false))
  }, [activeProjectId])

  const deleteSession = async (sessionId: string, e: React.MouseEvent) => {
    e.stopPropagation()
    try {
      await fetch(`${API_BASE}/api/chats/${sessionId}`, { method: "DELETE" })
      setSessions(prev => prev.filter(s => s.id !== sessionId))
      if (activeSessionId === sessionId) { setActiveSessionId(null); setMessages([]); setWorkspaceFiles([]) }
    } catch { /**/ }
  }

  const sendMessage = async () => {
    if (!activeSessionId || !input.trim() || loading) return
    const userMsg: ChatMsg = { role: "user", content: input.trim(), timestamp: nowTs() }
    const trimmed = input.trim()
    if (inputHistoryRef.current[0] !== trimmed) {
      inputHistoryRef.current.unshift(trimmed)
      if (inputHistoryRef.current.length > 100) inputHistoryRef.current.pop()
    }
    historyIdxRef.current = -1; inputDraftRef.current = ""
    setMessages(prev => [...prev, userMsg]); setInput(""); setLoading(true)
    setStreamingContent(""); setLiveToolCalls([]); shouldAutoScroll.current = true
    requestAnimationFrame(() => { messagesEndRef.current?.scrollIntoView({ behavior: "instant" }) })

    const abort = new AbortController(); abortControllerRef.current = abort
    try {
      const res = await fetch(`${API_BASE}/api/chats/${activeSessionId}/messages/stream`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: userMsg.content, model, max_tool_calls: maxToolCalls }),
        signal: abort.signal,
      })
      if (!res.ok) {
        let detail = "Unknown error"
        try { const errBody = await res.json(); detail = errBody.detail ?? detail } catch { /* ignore */ }
        const isNoKey = detail.includes("provisioned key")
        const content = isNoKey
          ? `**No API key configured for this project.**\n\nGo to **Projects → Keys → Create Key** to provision one, then come back and send your message.`
          : `Error: ${detail}`
        setMessages(prev => [...prev, { role: "notice", content, timestamp: nowTs() }])
        setLoading(false); return
      }
      if (!res.body) { setLoading(false); return }
      const reader = res.body.getReader(); const decoder = new TextDecoder(); let buffer = ""
      streamDoneReceived.current = false

      const processLine = (line: string) => {
        if (!line.startsWith("data: ")) return
        const payload = line.slice(6).trim(); if (payload === "[DONE]") return
        try {
          const evt = JSON.parse(payload)
          if (evt.type === "tool_start") {
            const isStreaming = evt.name === "run_script" || evt.name === "run_ffuf"
            setLiveToolCalls(prev => [...prev, {
              name: evt.name, toolArgsRaw: evt.args as string | undefined,
              result: null, startedAt: Date.now(),
              liveChunks: isStreaming ? [] : undefined,
              // Rationale is embedded in the tool call args by the model
              rationale: extractRationale(evt.args as string | undefined),
            }])
          } else if (evt.type === "tool_output_chunk") {
            setLiveToolCalls(prev => {
              const idx = [...prev].reverse().findIndex(e => e.name === evt.name && e.result === null)
              if (idx === -1) return prev
              const realIdx = prev.length - 1 - idx
              const tc = prev[realIdx]
              const newChunks = [...(tc.liveChunks ?? []), evt.chunk as string]
              return prev.map((e, i) => i === realIdx ? { ...e, liveChunks: newChunks } : e)
            })
          } else if (evt.type === "tool_result") {
            setLiveToolCalls(prev => {
              const idx = [...prev].reverse().findIndex(e => e.name === evt.name && e.result === null)
              if (idx === -1) return prev
              const realIdx = prev.length - 1 - idx
              const content: string = evt.content ?? ""
              const { meta } = parseMeta(content)
              const exitCode: number | null = meta.exit_code ?? null
              const runtimeMs: number | null = meta.runtime_ms ?? null
              return prev.map((e, i) => i === realIdx ? { ...e, result: content, exitCode, runtimeMs } : e)
            })
          } else if (evt.type === "delta") {
            setStreamingContent(prev => prev + (evt.content ?? ""))
          } else if (evt.type === "done") {
            streamDoneReceived.current = true
            const rawMsgs: ChatMsg[] = (evt.messages ?? []).map((m: Record<string, unknown>) => ({
              role: m.role as ChatMsg["role"],
              content: typeof m.content === "string" ? m.content : "",
              name: typeof m.name === "string" ? m.name : undefined,
              tool_call_id: typeof m.tool_call_id === "string" ? m.tool_call_id : undefined,
              tool_calls: Array.isArray(m.tool_calls) ? m.tool_calls as ChatMsg["tool_calls"] : undefined,
              timestamp: typeof m.timestamp === "string" ? m.timestamp : undefined,
            }))
            // Remap live:N collapse states → sessionId:msgIndex so the persisted
            // ToolGroup instances inherit the expanded/collapsed state the user set
            // during streaming, surviving the live→persisted DOM transition.
            // Only count tool messages from the last user message onwards so that
            // liveIdx correctly maps to live:0, live:1, … for the current turn.
            if (activeSessionId) {
              const lastUserIdx = rawMsgs.reduce((acc, m, i) => m.role === "user" ? i : acc, -1)
              let liveIdx = 0
              rawMsgs.forEach((m, msgIdx) => {
                if (msgIdx <= lastUserIdx) return
                if (m.role === "tool") {
                  const liveKey = `live:${liveIdx}`
                  const persistedKey = `${activeSessionId}:${msgIdx}`
                  if (toolGroupCollapsed.current.has(liveKey)) {
                    const val = toolGroupCollapsed.current.get(liveKey)!
                    toolGroupCollapsed.current.set(persistedKey, val)
                    toolGroupCollapsed.current.delete(liveKey)
                  }
                  liveIdx++
                }
              })
            }
            setMessages(annotateToolArgs(rawMsgs)); setStreamingContent(""); setLiveToolCalls([]); setLoading(false)
            fetchWorkspaceFiles(activeSessionId)
            if (activeProjectId) {
              fetch(`${API_BASE}/api/projects/${activeProjectId}/spend`).then(r => r.ok ? r.json() : null)
                .then(d => { if (d) setSessionSpend(d.total_usd ?? null) }).catch(() => {})
            }
          } else if (evt.type === "error") {
            streamDoneReceived.current = true
            const detail: string = evt.detail ?? evt.message ?? "Unknown error"
            const isNoKey = detail.includes("provisioned key")
            const content = isNoKey
              ? `**No API key configured for this project.**\n\nGo to **Projects → Keys → Create Key** to provision one, then come back and send your message.`
              : `Error: ${detail}`
            // Use "notice" role for no-key errors so the styling matches what is
            // persisted in the DB and shown on reload. Generic errors use "assistant".
            const role: ChatMsg["role"] = isNoKey ? "notice" : "assistant"
            setMessages(prev => [...prev, { role, content, timestamp: nowTs() }])
            setStreamingContent(""); setLiveToolCalls([]); setLoading(false)
          }
        } catch { /**/ }
      }

      while (true) {
        const { done, value } = await reader.read(); if (done) break
        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split("\n"); buffer = lines.pop() ?? ""
        for (const line of lines) processLine(line)
      }
      if (buffer) processLine(buffer)
      if (!streamDoneReceived.current) { setStreamingContent(""); setLiveToolCalls([]); setLoading(false) }
    } catch { setLoading(false); setStreamingContent(""); setLiveToolCalls([]) }
    finally { abortControllerRef.current = null }
  }

  const stopStream = () => { abortControllerRef.current?.abort() }

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendMessage(); return }
    if (e.key === "ArrowUp" || e.key === "ArrowDown") {
      const history = inputHistoryRef.current; if (history.length === 0) return
      const ta = e.currentTarget
      const onFirstLine = ta.selectionStart <= ta.value.indexOf("\n") || !ta.value.includes("\n")
      const onLastLine = ta.selectionEnd >= ta.value.lastIndexOf("\n") + 1 || !ta.value.includes("\n")
      if (e.key === "ArrowUp" && onFirstLine) {
        e.preventDefault()
        if (historyIdxRef.current === -1) inputDraftRef.current = input
        historyIdxRef.current = Math.min(historyIdxRef.current + 1, history.length - 1)
        setInput(history[historyIdxRef.current])
      } else if (e.key === "ArrowDown" && onLastLine) {
        e.preventDefault()
        if (historyIdxRef.current <= 0) { historyIdxRef.current = -1; setInput(inputDraftRef.current) }
        else { historyIdxRef.current -= 1; setInput(history[historyIdxRef.current]) }
      }
    }
  }

  const exportChat = () => {
    if (!activeSession || messages.length === 0) return
    const blob = new Blob([JSON.stringify({ session: activeSession, model, exported_at: new Date().toISOString(), messages }, null, 2)], { type: "application/json" })
    const url = URL.createObjectURL(blob); const a = document.createElement("a")
    a.href = url; a.download = `workspace-${activeSession.name.replace(/[^a-z0-9]/gi, "_")}-${Date.now()}.json`
    a.click(); URL.revokeObjectURL(url)
  }

  // ── Left sidebar drag ────────────────────────────────────────────────────────
  const handleLeftDragStart = (e: React.MouseEvent) => {
    leftDragging.current = true
    leftDragStart.current = e.clientX
    leftWidthStart.current = leftWidthRef.current   // use ref — always current value
    setIsDraggingAny(true)
    e.preventDefault()
  }

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (!leftDragging.current) return
      const next = Math.max(140, Math.min(360, leftWidthStart.current + (e.clientX - leftDragStart.current)))
      leftWidthRef.current = next
      setLeftWidth(next)
    }
    const onUp = () => {
      if (!leftDragging.current) return
      leftDragging.current = false
      setIsDraggingAny(false)
      localStorage.setItem("ferret_ws_left_width", String(leftWidthRef.current))
    }
    document.addEventListener("mousemove", onMove)
    document.addEventListener("mouseup", onUp)
    return () => { document.removeEventListener("mousemove", onMove); document.removeEventListener("mouseup", onUp) }
  }, [])

  // ── Right context panel drag ─────────────────────────────────────────────────
  const handleRightDragStart = (e: React.MouseEvent) => {
    rightDragging.current = true
    rightDragStart.current = e.clientX
    rightWidthStart.current = rightWidthRef.current  // use ref — always current value
    setIsDraggingAny(true)
    e.preventDefault()
  }

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (!rightDragging.current) return
      const next = Math.max(180, Math.min(400, rightWidthStart.current + (rightDragStart.current - e.clientX)))
      rightWidthRef.current = next
      setRightWidth(next)
    }
    const onUp = () => {
      if (!rightDragging.current) return
      rightDragging.current = false
      setIsDraggingAny(false)
      localStorage.setItem("ferret_ws_right_width", String(rightWidthRef.current))
    }
    document.addEventListener("mousemove", onMove)
    document.addEventListener("mouseup", onUp)
    return () => { document.removeEventListener("mousemove", onMove); document.removeEventListener("mouseup", onUp) }
  }, [])

  // suppress unused warning — contextReqLoading / reqPage used in context panel
  void contextReqLoading; void reqPage; void setReqPage; void contextRequests

  if (!widthsReady) return <div className="flex h-full bg-neutral-950" />

  return (
    <div className={`flex h-full bg-neutral-950 text-white overflow-hidden${isDraggingAny ? " select-none" : ""}`}>

      {/* ── Left: Workspace list ── */}
      <div
        className="flex flex-col flex-shrink-0 bg-neutral-950 overflow-hidden"
        style={{
          width: sessionPanelOpen ? `${leftWidth}px` : "0px",
          borderRightWidth: sessionPanelOpen ? "1px" : "0px",
          borderRightColor: "#262626",
          borderRightStyle: "solid",
        }}
      >
        {/* Sidebar inner — fixed width so content doesn't reflow during animation */}
        <div className="flex flex-col h-full" style={{ width: `${leftWidth}px` }}>
          <div className="flex items-center justify-between h-9 px-3 border-b border-neutral-800 bg-neutral-900/60 flex-shrink-0">
            <span className="text-xs font-semibold text-white">Workspaces</span>
            <div className="flex items-center gap-1">
              <button onClick={() => setShowNewModal(true)} title="New workspace"
                className="text-neutral-500 hover:text-orange-400 transition-colors">
                <Plus className="w-3 h-3" />
              </button>
            </div>
          </div>
          <div className="flex-1 overflow-y-auto">
            {sessions.map(session => {
              const isActive = session.id === activeSessionId
              const counts = sessionFileCounts[session.id]
              // Relative time label
              const createdMs = new Date(session.created_at).getTime()
              const diffMin = Math.floor((Date.now() - createdMs) / 60000)
              const relTime = diffMin < 1 ? "just now"
                : diffMin < 60 ? `${diffMin}m ago`
                : diffMin < 1440 ? `${Math.floor(diffMin / 60)}h ago`
                : diffMin < 2880 ? "yesterday"
                : new Date(session.created_at).toLocaleDateString()

              return (
                <div key={session.id} className="flex flex-col">
                  {/* ── Main item row ── */}
                  <div
                    onClick={() => {
                      // Clicking the already-active session while a file is open → close file view
                      if (session.id === activeSessionId && selectedFilePath) {
                        setSelectedFilePath(null)
                        return
                      }
                      loadSession(session.id)
                    }}
                    className={`group flex flex-col px-2 py-1.5 cursor-pointer border-b border-neutral-800/50 gap-0.5 transition-colors ${
                      isActive
                        ? "bg-neutral-800 border-l-2 border-l-orange-500 px-[6px]"
                        : "hover:bg-neutral-900"
                    }`}
                  >
                    {/* Row 1: name + delete (WS badge removed — redundant in Workspaces sidebar) */}
                    <div className="flex items-center gap-1 min-w-0">
                      <span className={`flex-1 text-[10px] font-mono truncate min-w-0 ${
                        isActive ? "text-orange-300" : "text-neutral-300"
                      }`} title={session.name}>
                        {session.name}
                      </span>
                      <button
                        onClick={e => deleteSession(session.id, e)}
                        className="opacity-0 group-hover:opacity-100 text-neutral-600 hover:text-red-400 transition-all flex-shrink-0"
                        title="Delete workspace"
                      >
                        <Trash2 className="w-2.5 h-2.5" />
                      </button>
                    </div>

                    {/* Row 2: file counts (only when counts are known and non-zero total) */}
                    {counts && (counts.scripts + counts.tests + counts.notes) > 0 && (
                      <div className="flex items-center gap-2 pl-px">
                        {counts.scripts > 0 && (
                          <span className={`flex items-center gap-0.5 text-[9px] font-mono ${isActive ? "text-neutral-500" : "text-neutral-600"}`}>
                            <Terminal className="w-2 h-2 flex-shrink-0" />
                            {counts.scripts}
                          </span>
                        )}
                        {counts.tests > 0 && (
                          <span className={`flex items-center gap-0.5 text-[9px] font-mono ${isActive ? "text-neutral-500" : "text-neutral-600"}`}>
                            <FileCode className="w-2 h-2 flex-shrink-0" />
                            {counts.tests}
                          </span>
                        )}
                        {counts.notes > 0 && (
                          <span className={`flex items-center gap-0.5 text-[9px] font-mono ${isActive ? "text-neutral-500" : "text-neutral-600"}`}>
                            <FileText className="w-2 h-2 flex-shrink-0" />
                            {counts.notes}
                          </span>
                        )}
                      </div>
                    )}

                    {/* Row 3: timestamp + scope icon */}
                    <div className="flex items-center gap-1 pl-px">
                      <span className={`text-[9px] font-mono ${isActive ? "text-neutral-600" : "text-neutral-700"}`}>
                        {relTime}
                      </span>
                      <span className="ml-auto text-[10px] leading-none flex-shrink-0" title={session.scope}>
                        {SCOPE_ICONS[session.scope] ?? "💬"}
                      </span>
                    </div>
                  </div>

                  {/* Inline file tree for active session — flush with the row above,
                      scrollable so long file lists don't get clipped */}
                  {isActive && (
                    <div className="border-b border-neutral-800/60 overflow-y-auto" style={{ maxHeight: "calc(100vh - 280px)" }}>
                      <FileTree files={workspaceFiles} selectedPath={selectedFilePath}
                        onSelectFile={path => setSelectedFilePath(path)}
                        onRefresh={() => fetchWorkspaceFiles(session.id)}
                        onNewFile={() => setShowNewFileModal(true)} />
                    </div>
                  )}
                </div>
              )
            })}
            {sessions.length === 0 && (
              <p className="text-[10px] text-neutral-700 px-3 py-4 text-center leading-relaxed">No workspaces yet.<br />Click + to start one.</p>
            )}
          </div>
        </div>
      </div>

      {/* Left sidebar resize handle */}
      {sessionPanelOpen && (
        <div
          className="w-1 flex-shrink-0 bg-neutral-800 hover:bg-orange-500 transition-colors cursor-col-resize z-10"
          onMouseDown={handleLeftDragStart}
        />
      )}

      {/* ── Centre: Chat or File Editor ── */}
      <section className="flex-1 flex flex-col min-w-0 overflow-hidden">
        {selectedFilePath && activeSessionId ? (
          <FileEditor sessionId={activeSessionId} filePath={selectedFilePath}
            onBack={() => setSelectedFilePath(null)}
            onDeleted={() => { setSelectedFilePath(null); if (activeSessionId) fetchWorkspaceFiles(activeSessionId) }} />
        ) : (
          <>
            {/* Chat header — h-9 to match sidebar/context headers */}
            <div className="flex items-center h-9 px-3 border-b border-neutral-800 bg-neutral-900/60 flex-shrink-0 gap-1.5">
              {!sessionPanelOpen && (
                <button onClick={toggleSessionPanel} className="text-neutral-500 hover:text-neutral-300 transition-colors mr-1" title="Show sidebar">
                  <PanelLeftOpen className="w-3 h-3" />
                </button>
              )}
              {sessionPanelOpen && (
                <button onClick={toggleSessionPanel} className="text-neutral-500 hover:text-neutral-300 transition-colors mr-1" title="Hide sidebar">
                  <PanelLeftClose className="w-3 h-3" />
                </button>
              )}
              <div className="flex-1 min-w-0">
                {activeSession ? (
                  <div className="flex items-center gap-2">
                    <span className="text-sm leading-none">{SCOPE_ICONS[activeSession.scope] ?? "💬"}</span>
                    <span className="text-xs font-semibold text-white truncate">{activeSession.name}</span>
                    <span className="text-[10px] text-neutral-500 flex-shrink-0 font-mono">{SCOPE_LABELS[activeSession.scope] ?? activeSession.scope}</span>
                  </div>
                ) : <span className="text-xs font-semibold text-neutral-600">No workspace selected</span>}
              </div>
              <div className="flex items-center gap-1 flex-shrink-0">
                <button onClick={() => setShowModelPicker(true)}
                  className="text-[10px] text-neutral-500 hover:text-orange-400 font-mono px-1.5 py-0.5 border border-neutral-800 hover:border-neutral-700 transition-colors">
                  {modelDisplayName}
                </button>
                <button onClick={exportChat} disabled={!activeSession || messages.length === 0}
                  className="text-neutral-500 hover:text-neutral-300 disabled:opacity-30 transition-colors" title="Export">
                  <Download className="w-3 h-3" />
                </button>
                {!contextOpen && (
                  <button onClick={() => setContextOpen(true)} className="text-neutral-500 hover:text-orange-400 transition-colors" title="Open context">
                    <PanelRight className="w-3 h-3" />
                  </button>
                )}
              </div>
            </div>

            {/* Messages */}
            <div ref={scrollContainerRef} onScroll={handleMessagesScroll} className="flex-1 overflow-y-auto px-3 py-3 space-y-2">
              {!activeSessionId && (
                <div className="flex flex-col items-center justify-center h-full text-neutral-500">
                  <LayoutDashboard className="w-8 h-8 mb-2 opacity-20" />
                  <p className="text-sm mb-1">Select a workspace or start a new one</p>
                  <button onClick={() => setShowNewModal(true)}
                    className="mt-2 px-4 py-1.5 text-xs bg-orange-500 hover:bg-orange-600 text-white transition-colors flex items-center gap-1.5">
                    <Plus className="w-3 h-3" />New Workspace
                  </button>
                </div>
              )}
              {loadingHistory && <div className="flex items-center justify-center py-8"><Loader2 className="w-5 h-5 animate-spin text-orange-500" /></div>}
              {messages.map((msg, i) => {
                if (msg.role === "tool") {
                  const toolName = msg.name ?? "tool"
                  const isRunning = msg.content?.startsWith("Running ") ?? false
                  const result = isRunning ? null : (msg.content ?? "")
                  const persistKey = activeSessionId ? `${activeSessionId}:${i}` : undefined
                  return (
                    <ToolGroup key={i} toolName={toolName} toolArgs={msg.toolArgs ?? ""} toolArgsRaw={msg.toolArgsRaw}
                      result={result} isRunning={isRunning} persistKey={persistKey}
                      exitCode={msg.exitCode} runtimeMs={msg.runtimeMs} liveChunks={undefined}
                      collapsedOverride={persistKey ? getToolGroupCollapsed(persistKey) : undefined}
                      onToggle={handleToolGroupToggle}
                      rationale={msg.rationale} />
                  )
                }
                if (msg.role === "assistant" && !(msg.content ?? "").trim()) return null
                if (msg.role === "notice") {
                  return (
                    <div key={i} className="flex flex-col items-start">
                      <div className="max-w-[80%] px-3 py-2 text-sm border bg-orange-500/10 text-orange-200 border-orange-500/30">
                        <MarkdownContent content={msg.content ?? ""} />
                      </div>
                      <div className="flex items-center gap-2 mt-0.5 px-1">
                        <span className="text-[10px] text-neutral-700">{msg.timestamp ?? ""}</span>
                      </div>
                    </div>
                  )
                }
                return (
                  <div key={i} className={`flex flex-col ${msg.role === "user" ? "items-end" : "items-start"}`}>
                    <div className={`max-w-[80%] px-3 py-2 text-sm border ${msg.role === "user" ? "bg-orange-500/15 text-white border-orange-500/20" : "bg-neutral-900 text-neutral-200 border-neutral-800"}`}>
                      {msg.role === "assistant" && <div className="text-[10px] text-orange-400 font-semibold mb-1 uppercase tracking-wider">AI</div>}
                      {msg.role === "assistant" ? <MarkdownContent content={msg.content ?? ""} /> : <div className="whitespace-pre-wrap leading-relaxed">{msg.content}</div>}
                    </div>
                    <div className={`flex items-center gap-2 mt-0.5 px-1 ${msg.role === "user" ? "flex-row-reverse" : "flex-row"}`}>
                      <span className="text-[10px] text-neutral-700">{msg.timestamp ?? ""}</span>
                      <CopyButton text={msg.content ?? ""} />
                    </div>
                  </div>
                )
              })}
              {loading && liveToolCalls.length > 0 && (
                <div className="space-y-1">
                  {liveToolCalls.map((tc, idx) => {
                    const liveKey = `live:${idx}`
                    return (
                      <ToolGroup key={idx} toolName={tc.name}
                        toolArgs={tc.toolArgsRaw ? formatToolArgs(tc.name, tc.toolArgsRaw) : ""}
                        toolArgsRaw={tc.toolArgsRaw}
                        result={tc.result}
                        isRunning={tc.result === null} exitCode={tc.exitCode} runtimeMs={tc.runtimeMs}
                        liveChunks={tc.liveChunks}
                        persistKey={liveKey}
                        collapsedOverride={getToolGroupCollapsed(liveKey)}
                        onToggle={handleToolGroupToggle}
                        rationale={tc.rationale} />
                    )
                  })}
                </div>
              )}
              {loading && streamingContent && (
                <div className="flex flex-col items-start">
                  <div className="max-w-[80%] px-3 py-2 text-sm bg-neutral-900 text-neutral-200 border border-neutral-800">
                    <div className="text-[10px] text-orange-400 font-semibold mb-1 uppercase tracking-wider">AI</div>
                    <MarkdownContent content={streamingContent} />
                    <span className="inline-block w-1.5 h-4 bg-orange-400 animate-pulse ml-0.5 align-middle" />
                  </div>
                </div>
              )}
              {loading && !streamingContent && liveToolCalls.length === 0 && (
                <div className="flex justify-start">
                  <div className="bg-neutral-900 border border-neutral-800 px-3 py-2">
                    <div className="flex items-center gap-1.5">
                      <span className="w-1.5 h-1.5 bg-orange-400 opacity-40 animate-bounce" style={{ animationDelay: "0ms" }} />
                      <span className="w-1.5 h-1.5 bg-orange-400 opacity-40 animate-bounce" style={{ animationDelay: "150ms" }} />
                      <span className="w-1.5 h-1.5 bg-orange-400 opacity-40 animate-bounce" style={{ animationDelay: "300ms" }} />
                    </div>
                  </div>
                </div>
              )}
              <div ref={messagesEndRef} />
            </div>

            {/* Input bar */}
            <div className="border-t border-neutral-800 px-3 py-2 bg-neutral-900 flex-shrink-0">
              <div className="flex items-end gap-2">
                <Textarea ref={chatInputRef} value={input} onChange={e => setInput(e.target.value)} onKeyDown={handleKeyDown}
                  placeholder={activeSessionId ? "Message… (Enter to send, Shift+Enter for newline)" : "Select a workspace first"}
                  disabled={!activeSessionId || loading}
                  className="flex-1 text-sm bg-neutral-800 border-neutral-700 text-white resize-none min-h-[40px] max-h-40 placeholder:text-neutral-600 focus-visible:ring-orange-500/50" rows={2} />
                {loading
                  ? <button onClick={stopStream} className="bg-neutral-700 hover:bg-red-900/60 border border-neutral-600 hover:border-red-500/50 text-neutral-300 hover:text-red-400 h-10 w-10 flex items-center justify-center flex-shrink-0 transition-colors">
                      <Square className="w-4 h-4" />
                    </button>
                  : <button onClick={sendMessage} disabled={!activeSessionId || !input.trim()}
                      className="bg-orange-500 hover:bg-orange-600 disabled:opacity-40 text-white h-10 w-10 flex items-center justify-center flex-shrink-0 transition-colors">
                      <Send className="w-4 h-4" />
                    </button>}
              </div>
              <p className="text-[10px] text-neutral-700 mt-1">Model: {model}</p>
            </div>
          </>
        )}
      </section>

      {/* Right context panel resize handle */}
      {contextOpen && !selectedFilePath && (
        <div
          className="w-1 flex-shrink-0 bg-neutral-800 hover:bg-orange-500 transition-colors cursor-col-resize z-10"
          onMouseDown={handleRightDragStart}
        />
      )}

      {/* ── Right: Context panel — always rendered, width-animated ── */}
      <div
        className="flex flex-col flex-shrink-0 bg-neutral-950 overflow-hidden"
        style={{
          width: contextOpen && !selectedFilePath ? `${rightWidth}px` : "0px",
          borderLeftWidth: contextOpen && !selectedFilePath ? "1px" : "0px",
          borderLeftColor: "#262626",
          borderLeftStyle: "solid",
        }}
      >
        <div className="flex flex-col h-full" style={{ width: `${rightWidth}px` }}>
        <div className="flex items-center justify-between h-9 px-3 border-b border-neutral-800 bg-neutral-900/60 flex-shrink-0">
          <span className="text-xs font-semibold text-white">Context</span>
          <div className="flex items-center gap-1">
            {activeSession && (
              <button onClick={() => setShowScopePicker(true)} className="text-neutral-500 hover:text-orange-400 transition-colors">
                <Pencil className="w-3 h-3" />
              </button>
            )}
            <button onClick={() => setContextOpen(false)} className="text-neutral-600 hover:text-neutral-400 transition-colors">
              <ChevronRight className="w-3 h-3" />
            </button>
          </div>
        </div>
        <div className="flex-1 overflow-y-auto divide-y divide-neutral-800">
          {!activeSession ? (
            <p className="text-xs text-neutral-600 leading-relaxed p-3">Select or create a workspace to see its context.</p>
          ) : (
            <>
              {/* Scope */}
              <div className="px-3 py-2">
                <p className="text-[10px] text-neutral-500 uppercase tracking-wider mb-1.5">Scope</p>
                <div className="flex items-center gap-2 bg-neutral-800 border border-neutral-700 px-2 py-1.5">
                  <span className="text-base leading-none">{SCOPE_ICONS[activeSession.scope] ?? "💬"}</span>
                  <div className="flex-1 min-w-0">
                    <div className="text-xs text-neutral-200 truncate">{SCOPE_LABELS[activeSession.scope] ?? activeSession.scope}</div>
                  </div>
                  <button onClick={() => setShowScopePicker(true)}
                    className="text-[10px] text-neutral-500 hover:text-orange-400 transition-colors flex-shrink-0 px-1.5 py-0.5 border border-neutral-700 hover:border-orange-500/40">
                    Edit
                  </button>
                </div>
              </div>
              {/* Session info */}
              <div className="px-3 py-2">
                <p className="text-[10px] text-neutral-500 uppercase tracking-wider mb-1.5">Session</p>
                <div className="text-[10px] text-neutral-500 space-y-1 leading-relaxed">
                  <div>Created: <span className="text-neutral-300">{formatTs(activeSession.created_at)}</span></div>
                  <div>Messages: <span className="text-neutral-300">{messages.length}</span></div>
                  <div>Model: <span className="text-neutral-300">{modelDisplayName}</span></div>
                  <div>Cost: {sessionSpend != null ? <span className="text-green-400 font-mono">${sessionSpend.toFixed(4)}</span> : <span className="text-neutral-600">—</span>}</div>
                </div>
              </div>
              {/* Limits */}
              <div className="px-3 py-2">
                <p className="text-[10px] text-neutral-500 uppercase tracking-wider mb-1.5">Limits</p>
                <div className="flex items-center gap-2">
                  <label className="text-[10px] text-neutral-400 flex-1">Max tool calls</label>
                  <input type="number" min={1} max={50} value={maxToolCalls}
                    onChange={e => { const v = Math.max(1, Math.min(50, Number(e.target.value))); setMaxToolCalls(v); localStorage.setItem("ferret_max_tool_calls", String(v)) }}
                    className="w-14 text-[10px] text-center bg-neutral-800 border border-neutral-700 px-1 py-0.5 text-neutral-200 focus:outline-none focus:border-orange-500/60" />
                </div>
              </div>
              {/* AI Tools */}
              <div className="px-3 py-2">
                <p className="text-[10px] text-neutral-500 uppercase tracking-wider mb-1.5">AI Tools</p>
                <div className="space-y-0.5">
                  {["search_requests","get_request_detail","http_request","create_finding","list_findings","write_test","run_test","read_test","run_script","run_ffuf"].map(tool => (
                    <div key={tool} className="flex items-center gap-2 py-0.5">
                      <input type="checkbox" defaultChecked id={`tool-${tool}`} className="w-3 h-3 accent-orange-500 flex-shrink-0" />
                      <label htmlFor={`tool-${tool}`} className="text-[10px] text-neutral-300 font-mono flex-1 truncate cursor-pointer">{tool}</label>
                    </div>
                  ))}
                </div>
              </div>
            </>
          )}
        </div>
        </div>
      </div>

      {/* ── Modals ── */}
      {showNewModal && (
        <NewChatModal activeProjectId={activeProjectId} onClose={() => setShowNewModal(false)}
          onCreated={session => {
            setSessions(prev => [{ ...session, workspace_dir: (session as WorkspaceSession).workspace_dir ?? null } as WorkspaceSession, ...prev])
            setShowNewModal(false)
            focusChatInputRef.current = true
            loadSession(session.id)
          }}
          initialScope={initialScope ?? "all"} initialSelectedIds={initialSelectedIds} initialName={initialName} />
      )}
      {showScopePicker && activeSession && activeSessionId && (
        <ScopePickerModal activeProjectId={activeProjectId} initialScope={activeSession.scope}
          initialScopeData={activeSession.scope_data} sessionId={activeSessionId}
          onClose={() => setShowScopePicker(false)}
          onSaved={({ scope, scope_data }) => {
            setSessions(prev => prev.map(s => s.id === activeSessionId ? { ...s, scope, scope_data } : s))
            setShowScopePicker(false)
          }} />
      )}
      {showModelPicker && (
        <ModelPickerModal currentModel={model} onSelect={handleModelSelect} onClose={() => setShowModelPicker(false)} />
      )}
      {showNewFileModal && activeSessionId && (
        <NewFileModal sessionId={activeSessionId}
          onCreated={path => { setShowNewFileModal(false); fetchWorkspaceFiles(activeSessionId); setSelectedFilePath(path) }}
          onClose={() => setShowNewFileModal(false)} />
      )}
    </div>
  )
}

export default function WorkspacesPage() {
  return (
    <Suspense fallback={
      <div className="flex items-center justify-center h-full text-neutral-500">
        <Loader2 className="w-5 h-5 animate-spin mr-2" />Loading…
      </div>
    }>
      <WorkspacesPageInner />
    </Suspense>
  )
}
