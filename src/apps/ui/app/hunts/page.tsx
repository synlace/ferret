"use client"

import React, { useState, useEffect, useLayoutEffect, useCallback, useRef, Suspense } from "react"
import { useSearchParams } from "next/navigation"
import { Loader2 } from "lucide-react"
import { useProject } from "../context/project-context"
import { NewChatModal } from "../chat/NewChatModal"
import { ModelPickerModal } from "../projects/ModelPickerModal"
import { ScopePickerModal } from "../chat/ScopePickerModal"
import { NewFileModal } from "./NewFileModal"
import { HuntsList } from "./HuntsList"
import { ChatPanel } from "./ChatPanel"
import { annotateToolArgs, formatToolArgs, extractRationale } from "./helpers"
import { nowTs } from "./tool-views"
import type { WorkspaceFile } from "./FileTree"
import type { WorkspaceSession, ChatMsg, LiveToolCall } from "./types"

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000"
const DEFAULT_CHAT_MODEL = "google/gemini-3-flash-preview"
const lastSessionKey = (projectId: string) => `ferret_last_chat_session:${projectId}`

function HuntsPageInner() {
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
  const liveToolCallsRef = useRef<LiveToolCall[]>([])
  const streamingContentRef = useRef("")
  const pendingNoticeRef = useRef<ChatMsg | null>(null)
  const toolGroupCollapsed = useRef<Map<string, boolean>>(new Map())
  const [, forceToolGroupRender] = useState(0)

  const handleToolGroupToggle = (key: string, collapsed: boolean) => {
    toolGroupCollapsed.current.set(key, collapsed)
    if (key && !key.startsWith("live:")) {
      try { localStorage.setItem(`tg:${key}`, collapsed ? "1" : "0") } catch { /**/ }
    }
    forceToolGroupRender(n => n + 1)
  }

  const getToolGroupCollapsed = (key: string, defaultVal = true): boolean => {
    if (toolGroupCollapsed.current.has(key)) return toolGroupCollapsed.current.get(key)!
    if (key.startsWith("live:")) { toolGroupCollapsed.current.set(key, defaultVal); return defaultVal }
    try {
      const stored = localStorage.getItem(`tg:${key}`)
      const val = stored !== null ? stored !== "0" : defaultVal
      toolGroupCollapsed.current.set(key, val); return val
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
  const rightDragging = useRef(false)
  const rightDragStart = useRef(0)
  const rightWidthStart = useRef(0)
  const [widthsReady, setWidthsReady] = useState(false)

  const [showNewModal, setShowNewModal] = useState(false)
  const [showScopePicker, setShowScopePicker] = useState(false)
  const [showModelPicker, setShowModelPicker] = useState(false)
  const [wsFilter, setWsFilter] = useState("")
  const [wsSort, setWsSort] = useState<"newest" | "oldest" | "az" | "za">("newest")

  useLayoutEffect(() => {
    const panelSaved = localStorage.getItem("ferret_hunt_panel_open")
    if (panelSaved !== null) setSessionPanelOpen(panelSaved === "true")
    const lw = Number(localStorage.getItem("ferret_hunt_left_width"))
    if (lw > 0) { setLeftWidth(lw); leftWidthRef.current = lw }
    const rw = Number(localStorage.getItem("ferret_hunt_right_width"))
    if (rw > 0) { setRightWidth(rw); rightWidthRef.current = rw }
    setWidthsReady(true)
  }, [])

  const toggleSessionPanel = () => setSessionPanelOpen(prev => {
    const next = !prev; localStorage.setItem("ferret_hunt_panel_open", String(next)); return next
  })

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

  useEffect(() => {
    if (focusChatInputRef.current && activeSessionId) {
      focusChatInputRef.current = false
      chatInputRef.current?.focus()
    }
  }, [activeSessionId])

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
    setStreamingContent(""); streamingContentRef.current = ""
    setLiveToolCalls([]); liveToolCallsRef.current = []
    shouldAutoScroll.current = true
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
            const newEntry: LiveToolCall = {
              name: evt.name, toolArgsRaw: evt.args as string | undefined,
              result: null, startedAt: Date.now(),
              liveChunks: isStreaming ? [] : undefined,
              rationale: extractRationale(evt.args as string | undefined),
            }
            liveToolCallsRef.current = [...liveToolCallsRef.current, newEntry]
            setLiveToolCalls(liveToolCallsRef.current)
          } else if (evt.type === "tool_output_chunk") {
            const prev = liveToolCallsRef.current
            const idx = [...prev].reverse().findIndex(e => e.name === evt.name && e.result === null)
            if (idx !== -1) {
              const realIdx = prev.length - 1 - idx
              const tc = prev[realIdx]
              const newChunks = [...(tc.liveChunks ?? []), evt.chunk as string]
              liveToolCallsRef.current = prev.map((e, i) => i === realIdx ? { ...e, liveChunks: newChunks } : e)
              setLiveToolCalls(liveToolCallsRef.current)
            }
          } else if (evt.type === "tool_result") {
            const prev = liveToolCallsRef.current
            const idx = [...prev].reverse().findIndex(e => e.name === evt.name && e.result === null)
            if (idx !== -1) {
              const realIdx = prev.length - 1 - idx
              liveToolCallsRef.current = prev.map((e, i) => i === realIdx ? { ...e, result: evt.content ?? "" } : e)
              setLiveToolCalls(liveToolCallsRef.current)
            }
          } else if (evt.type === "delta") {
            streamingContentRef.current += evt.content ?? ""
            setStreamingContent(streamingContentRef.current)
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
            setMessages(annotateToolArgs(rawMsgs))
            setStreamingContent(""); streamingContentRef.current = ""
            setLiveToolCalls([]); liveToolCallsRef.current = []
            setLoading(false)
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
            const role: ChatMsg["role"] = isNoKey ? "notice" : "assistant"
            setMessages(prev => [...prev, { role, content, timestamp: nowTs() }])
            setStreamingContent(""); streamingContentRef.current = ""
            setLiveToolCalls([]); liveToolCallsRef.current = []
            setLoading(false)
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
      if (!streamDoneReceived.current) {
        setStreamingContent(""); streamingContentRef.current = ""
        setLiveToolCalls([]); liveToolCallsRef.current = []
        setLoading(false)
      }
    } catch {
      const snapshot = liveToolCallsRef.current
      const partialText = streamingContentRef.current.trim()
      const promotedMsgs: ChatMsg[] = snapshot.map(tc => ({
        role: "tool" as const, content: tc.result ?? "", name: tc.name,
        toolArgs: tc.toolArgsRaw ? formatToolArgs(tc.name, tc.toolArgsRaw) : "",
        toolArgsRaw: tc.toolArgsRaw, exitCode: tc.exitCode, runtimeMs: tc.runtimeMs,
        rationale: tc.rationale, timestamp: nowTs(),
      }))
      if (partialText) promotedMsgs.push({ role: "assistant" as const, content: partialText, timestamp: nowTs() })
      if (promotedMsgs.length > 0) setMessages(prev => [...prev, ...promotedMsgs])
      setLiveToolCalls([]); liveToolCallsRef.current = []
      setStreamingContent(""); streamingContentRef.current = ""
      setLoading(false)
    } finally { abortControllerRef.current = null }
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
    a.href = url; a.download = `hunt-${activeSession.name.replace(/[^a-z0-9]/gi, "_")}-${Date.now()}.json`
    a.click(); URL.revokeObjectURL(url)
  }

  // ── Left sidebar drag ────────────────────────────────────────────────────────
  const handleLeftDragStart = (e: React.MouseEvent) => {
    leftDragging.current = true; leftDragStart.current = e.clientX
    leftWidthStart.current = leftWidthRef.current; setIsDraggingAny(true); e.preventDefault()
  }
  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (!leftDragging.current) return
      const next = Math.max(140, Math.min(360, leftWidthStart.current + (e.clientX - leftDragStart.current)))
      leftWidthRef.current = next; setLeftWidth(next)
    }
    const onUp = () => {
      if (!leftDragging.current) return
      leftDragging.current = false; setIsDraggingAny(false)
      localStorage.setItem("ferret_hunt_left_width", String(leftWidthRef.current))
    }
    document.addEventListener("mousemove", onMove); document.addEventListener("mouseup", onUp)
    return () => { document.removeEventListener("mousemove", onMove); document.removeEventListener("mouseup", onUp) }
  }, [])

  // ── Right context panel drag ─────────────────────────────────────────────────
  const handleRightDragStart = (e: React.MouseEvent) => {
    rightDragging.current = true; rightDragStart.current = e.clientX
    rightWidthStart.current = rightWidthRef.current; setIsDraggingAny(true); e.preventDefault()
  }
  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (!rightDragging.current) return
      const next = Math.max(180, Math.min(400, rightWidthStart.current + (rightDragStart.current - e.clientX)))
      rightWidthRef.current = next; setRightWidth(next)
    }
    const onUp = () => {
      if (!rightDragging.current) return
      rightDragging.current = false; setIsDraggingAny(false)
      localStorage.setItem("ferret_hunt_right_width", String(rightWidthRef.current))
    }
    document.addEventListener("mousemove", onMove); document.addEventListener("mouseup", onUp)
    return () => { document.removeEventListener("mousemove", onMove); document.removeEventListener("mouseup", onUp) }
  }, [])

  if (!widthsReady) return <div className="flex h-full bg-neutral-950" />

  return (
    <div className={`flex h-full bg-neutral-950 text-white overflow-hidden${isDraggingAny ? " select-none" : ""}`}>

      {/* ── Left: Hunt list ── */}
      <div
        className="flex flex-col flex-shrink-0 bg-neutral-950 overflow-hidden"
        style={{
          width: sessionPanelOpen ? `${leftWidth}px` : "0px",
          borderRightWidth: sessionPanelOpen ? "1px" : "0px",
          borderRightColor: "#262626",
          borderRightStyle: "solid",
        }}
      >
        <HuntsList
          sessions={sessions}
          activeSessionId={activeSessionId}
          selectedFilePath={selectedFilePath}
          workspaceFiles={workspaceFiles}
          sessionFileCounts={sessionFileCounts}
          wsFilter={wsFilter}
          wsSort={wsSort}
          leftWidth={leftWidth}
          onFilterChange={setWsFilter}
          onSortChange={setWsSort}
          onSelectSession={loadSession}
          onDeleteSession={deleteSession}
          onSelectFile={path => path ? setSelectedFilePath(path) : setSelectedFilePath(null)}
          onNewHunt={() => setShowNewModal(true)}
        />
      </div>

      {/* Left sidebar resize handle */}
      {sessionPanelOpen && (
        <div
          className="w-1 flex-shrink-0 bg-neutral-800 hover:bg-orange-500 transition-colors cursor-col-resize z-10"
          onMouseDown={handleLeftDragStart}
        />
      )}

      {/* ── Centre + Right panels ── */}
      <ChatPanel
        activeSession={activeSession}
        activeSessionId={activeSessionId}
        messages={messages}
        input={input}
        loading={loading}
        loadingHistory={loadingHistory}
        streamingContent={streamingContent}
        liveToolCalls={liveToolCalls}
        model={model}
        modelDisplayName={modelDisplayName}
        maxToolCalls={maxToolCalls}
        sessionSpend={sessionSpend}
        sessionPanelOpen={sessionPanelOpen}
        contextOpen={contextOpen}
        rightWidth={rightWidth}
        selectedFilePath={selectedFilePath}
        workspaceFiles={workspaceFiles}
        chatInputRef={chatInputRef}
        messagesEndRef={messagesEndRef}
        scrollContainerRef={scrollContainerRef}
        getToolGroupCollapsed={getToolGroupCollapsed}
        handleToolGroupToggle={handleToolGroupToggle}
        handleRightDragStart={handleRightDragStart}
        onToggleSessionPanel={toggleSessionPanel}
        onOpenContext={() => setContextOpen(true)}
        onCloseContext={() => setContextOpen(false)}
        onOpenModelPicker={() => setShowModelPicker(true)}
        onOpenScopePicker={() => setShowScopePicker(true)}
        onExportChat={exportChat}
        onSendMessage={sendMessage}
        onStopStream={stopStream}
        onInputChange={setInput}
        onKeyDown={handleKeyDown}
        onMaxToolCallsChange={v => { setMaxToolCalls(v); localStorage.setItem("ferret_max_tool_calls", String(v)) }}
        onMessagesScroll={handleMessagesScroll}
        onNewHunt={() => setShowNewModal(true)}
        onBackFromFile={() => setSelectedFilePath(null)}
        onFileDeleted={() => { setSelectedFilePath(null); if (activeSessionId) fetchWorkspaceFiles(activeSessionId) }}
      />

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

export default function HuntsPage() {
  return (
    <Suspense fallback={
      <div className="flex items-center justify-center h-full text-neutral-500">
        <Loader2 className="w-5 h-5 animate-spin mr-2" />Loading...
      </div>
    }>
      <HuntsPageInner />
    </Suspense>
  )
}
