"use client"

import React, { useRef, memo, useState, useEffect } from "react"
import { Textarea } from "@/components/ui/textarea"
import {
  Loader2, Download, Send, Square,
  PanelLeftClose, PanelLeftOpen, PanelRight,
  LayoutDashboard, Plus, Pencil, ChevronRight, ChevronDown, MessageCircle,
} from "lucide-react"
import { SCOPE_LABELS } from "../chat/NewChatModal"
import { ToolGroup, formatTs } from "./tool-views"
import { CopyButton } from "./tool-views"
import { FileEditor } from "./FileEditor"
import { MarkdownContent } from "./MarkdownContent"
import { formatToolArgs } from "./helpers"
import type { WorkspaceSession, ChatMsg, LiveToolCall } from "./types"
import type { WorkspaceFile } from "./FileTree"
import { apiFetch } from "@/lib/api-fetch"

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000"

// ── ThinkingBlock — collapsible chain-of-thought reasoning block ──
const THINKING_STORAGE_PREFIX = "ferret_thinking_collapsed:"

function ThinkingBlock({ content, persistKey }: { content: string; persistKey?: string }) {
  const [collapsed, setCollapsed] = useState(() => {
    if (!persistKey) return true
    try {
      const stored = localStorage.getItem(THINKING_STORAGE_PREFIX + persistKey)
      return stored !== null ? stored === "1" : true
    } catch { return true }
  })

  const toggle = () => {
    setCollapsed(c => {
      const next = !c
      if (persistKey) {
        try { localStorage.setItem(THINKING_STORAGE_PREFIX + persistKey, next ? "1" : "0") } catch { /* ignore */ }
      }
      return next
    })
  }

  return (
    <div className="border border-neutral-700 rounded bg-neutral-900/60 text-xs my-1">
      <button
        onClick={toggle}
        className="w-full flex items-center gap-2 px-3 py-1.5 text-left hover:bg-neutral-800/40 transition-colors"
      >
        <MessageCircle className="w-3 h-3 text-neutral-400 flex-shrink-0" />
        <span className="text-neutral-300 font-mono">thinking</span>
        <span className="flex-1" />
        {collapsed
          ? <ChevronRight className="w-3 h-3 text-neutral-600 flex-shrink-0" />
          : <ChevronDown className="w-3 h-3 text-neutral-600 flex-shrink-0" />}
      </button>
      {!collapsed && (
        <div className="border-t border-neutral-700/60 px-3 py-2 text-neutral-400 whitespace-pre-wrap font-mono leading-relaxed text-[11px] max-h-64 overflow-y-auto bg-neutral-950">
          {content}
        </div>
      )}
    </div>
  )
}

// ── MessageList — memoized so it does NOT re-render on every streaming delta ──
// Only re-renders when `messages`, `activeSessionId`, or the collapse helpers change.
interface MessageListProps {
  messages: ChatMsg[]
  activeSessionId: string | null
  getToolGroupCollapsed: (key: string, defaultVal?: boolean) => boolean
  handleToolGroupToggle: (key: string, collapsed: boolean) => void
}
const MessageList = memo(function MessageList({
  messages,
  activeSessionId,
  getToolGroupCollapsed,
  handleToolGroupToggle,
}: MessageListProps) {
  return (
    <>
      {messages.map((msg, i) => {
        if (msg.role === "tool") {
          const toolName = msg.name ?? "tool"
          const isRunning = msg.content?.startsWith("Running ") ?? false
          const result = isRunning ? null : (msg.content ?? "")
          const persistKey = activeSessionId ? `${activeSessionId}:${i}` : undefined
          return (
            <ToolGroup key={i} toolName={toolName} toolArgs={msg.toolArgs ?? ""} toolArgsRaw={msg.toolArgsRaw}
              result={result} isRunning={isRunning} persistKey={persistKey}
              exitCode={msg.exitCode} runtimeMs={msg.runtimeMs}
              collapsedOverride={persistKey ? getToolGroupCollapsed(persistKey) : undefined}
              onToggle={handleToolGroupToggle}
              rationale={msg.rationale} />
          )
        }
        if (msg.role === "assistant" && !(msg.content ?? "").trim() && !msg.thinking) return null
        if (msg.role === "notice") {
          return (
            <div key={i} className="flex flex-col items-start">
              <div className="max-w-[80%] px-3 py-2 text-sm border bg-brand-500/10 text-brand-200 border-brand-500/30">
                <MarkdownContent content={msg.content ?? ""} />
              </div>
              <div className="flex items-center gap-2 mt-0.5 px-1">
                <span className="text-[10px] text-neutral-700">{msg.timestamp ?? ""}</span>
              </div>
            </div>
          )
        }
        // Thinking-only assistant message (content was fully extracted into thinking)
        if (msg.role === "assistant" && !(msg.content ?? "").trim() && msg.thinking) {
          const thinkKey = activeSessionId ? `${activeSessionId}:${i}:thinking` : undefined
          return <ThinkingBlock key={i} content={msg.thinking} persistKey={thinkKey} />
        }
        return (
          <React.Fragment key={i}>
            {msg.role === "assistant" && msg.thinking && (
              <ThinkingBlock
                content={msg.thinking}
                persistKey={activeSessionId ? `${activeSessionId}:${i}:thinking` : undefined}
              />
            )}
            <div className={`flex flex-col ${msg.role === "user" ? "items-end" : "items-start"}`}>
              <div className={`max-w-[80%] px-3 py-2 text-sm border ${msg.role === "user" ? "bg-brand-500/15 text-neutral-100 border-brand-500/20" : "bg-neutral-900 text-neutral-200 border-neutral-800"}`}>
                {msg.role === "assistant" && <div className="text-[10px] text-brand-400 font-semibold mb-1 uppercase tracking-wider">AI</div>}
                {msg.role === "assistant" ? <MarkdownContent content={msg.content ?? ""} /> : <div className="whitespace-pre-wrap leading-relaxed">{msg.content}</div>}
              </div>
              <div className={`flex items-center gap-2 mt-0.5 px-1 ${msg.role === "user" ? "flex-row-reverse" : "flex-row"}`}>
                <span className="text-[10px] text-neutral-700">{msg.timestamp ?? ""}</span>
                <CopyButton text={msg.content ?? ""} />
              </div>
            </div>
          </React.Fragment>
        )
      })}
    </>
  )
})

interface ToolInfo {
  name: string
  label: string
  group?: string
}

// Canonical group order for the AI Tools panel
const TOOL_GROUP_ORDER = ["Proxy History", "Findings", "Testing", "Execution", "Sources"]

const TOOL_GROUP_STORAGE_KEY = "ferret_tool_group_collapsed"

function loadToolGroupCollapsed(): Record<string, boolean> {
  try {
    const raw = localStorage.getItem(TOOL_GROUP_STORAGE_KEY)
    return raw ? JSON.parse(raw) : {}
  } catch { return {} }
}

function saveToolGroupCollapsed(state: Record<string, boolean>) {
  try { localStorage.setItem(TOOL_GROUP_STORAGE_KEY, JSON.stringify(state)) } catch { /* ignore */ }
}

interface ChatPanelProps {
  activeSession: WorkspaceSession | null
  activeSessionId: string | null
  messages: ChatMsg[]
  input: string
  loading: boolean
  loadingHistory: boolean
  streamingContent: string
  streamingThinking: string
  liveToolCalls: LiveToolCall[]
  model: string
  modelDisplayName: string
  maxToolCalls: number
  /** null = all tools enabled; string[] = only these names are enabled */
  enabledTools: string[] | null
  sessionSpend: number | null
  lastUsage: { prompt_tokens: number; completion_tokens: number; total_tokens: number } | null
  sessionPanelOpen: boolean
  contextOpen: boolean
  rightWidth: number
  selectedFilePath: string | null
  workspaceFiles: WorkspaceFile[]
  chatInputRef: React.RefObject<HTMLTextAreaElement | null>
  messagesEndRef: React.RefObject<HTMLDivElement | null>
  scrollContainerRef: React.RefObject<HTMLDivElement | null>
  getToolGroupCollapsed: (key: string, defaultVal?: boolean) => boolean
  handleToolGroupToggle: (key: string, collapsed: boolean) => void
  handleRightDragStart: (e: React.MouseEvent) => void
  onToggleSessionPanel: () => void
  onOpenContext: () => void
  onCloseContext: () => void
  onOpenModelPicker: () => void
  onOpenScopePicker: () => void
  onExportChat: () => void
  onSendMessage: () => void
  onStopStream: () => void
  onInputChange: (v: string) => void
  onKeyDown: (e: React.KeyboardEvent<HTMLTextAreaElement>) => void
  onMaxToolCallsChange: (v: number) => void
  onMessagesScroll: () => void
  onNewHunt: () => void
  onBackFromFile: () => void
  onFileDeleted: () => void
  onToolToggle: (name: string, enabled: boolean) => void
  /** PATCH enabled_tools: null (all enabled) in a single request */
  onEnableAll: () => void
  /** PATCH enabled_tools: [] (all disabled) in a single request */
  onDisableAll: () => void
  /** Called by XTermView when it's ready to receive chunks; idx is the liveToolCalls index */
  onRegisterLiveWriter: (idx: number, write: (chunk: string) => void) => void
  /** Move a workspace file to a new subdir (promotion). srcPath = "workspace/foo.py", dstSubdir = "scripts" */
  onMoveFile?: (srcPath: string, dstSubdir: string) => void
}

export function ChatPanel({
  activeSession,
  activeSessionId,
  messages,
  input,
  loading,
  loadingHistory,
  streamingContent,
  streamingThinking,
  liveToolCalls,
  model,
  modelDisplayName,
  maxToolCalls,
  enabledTools,
  sessionSpend,
  lastUsage,
  sessionPanelOpen,
  contextOpen,
  rightWidth,
  selectedFilePath,
  chatInputRef,
  messagesEndRef,
  scrollContainerRef,
  getToolGroupCollapsed,
  handleToolGroupToggle,
  handleRightDragStart,
  onToggleSessionPanel,
  onOpenContext,
  onCloseContext,
  onOpenModelPicker,
  onOpenScopePicker,
  onExportChat,
  onSendMessage,
  onStopStream,
  onInputChange,
  onKeyDown,
  onMaxToolCallsChange,
  onMessagesScroll,
  onNewHunt,
  onBackFromFile,
  onFileDeleted,
  onToolToggle,
  onEnableAll,
  onDisableAll,
  onRegisterLiveWriter,
  onMoveFile,
}: ChatPanelProps) {
  const [availableTools, setAvailableTools] = useState<ToolInfo[]>([])
  useEffect(() => {
    apiFetch(`${API_BASE}/api/tools`)
      .then(r => r.ok ? r.json() : Promise.reject())
      .then((tools: ToolInfo[]) => setAvailableTools(tools))
      .catch(() => {/* silently ignore — non-critical */})
  }, [])

  const [collapsedGroups, setCollapsedGroups] = useState<Record<string, boolean>>(() => loadToolGroupCollapsed())

  const toggleToolGroup = (group: string) => {
    setCollapsedGroups(prev => {
      const next = { ...prev, [group]: !prev[group] }
      saveToolGroupCollapsed(next)
      return next
    })
  }

  return (
    <>
      {/* ── Centre: Chat or File Editor ── */}
      <section className="flex-1 flex flex-col min-w-0 overflow-hidden">
        {selectedFilePath && activeSessionId ? (
          <FileEditor
            sessionId={activeSessionId}
            filePath={selectedFilePath}
            onBack={onBackFromFile}
            onDeleted={onFileDeleted}
          />
        ) : (
          <>
            {/* Chat header */}
            <div className="flex items-center h-9 px-3 border-b border-neutral-800 bg-neutral-900/60 flex-shrink-0 gap-1.5">
              {!sessionPanelOpen ? (
                <button onClick={onToggleSessionPanel} className="text-neutral-500 hover:text-neutral-300 transition-colors mr-1" title="Show sidebar">
                  <PanelLeftOpen className="w-3 h-3" />
                </button>
              ) : (
                <button onClick={onToggleSessionPanel} className="text-neutral-500 hover:text-neutral-300 transition-colors mr-1" title="Hide sidebar">
                  <PanelLeftClose className="w-3 h-3" />
                </button>
              )}
              <div className="flex-1 min-w-0">
                {activeSession ? (
                  <div className="flex items-center gap-2">
                    <span className="text-xs font-semibold text-white truncate">{activeSession.name}</span>
                    <span className="text-[10px] text-neutral-500 flex-shrink-0 font-mono">{SCOPE_LABELS[activeSession.scope] ?? activeSession.scope}</span>
                  </div>
                ) : (
                  <span className="text-xs font-semibold text-neutral-600">No hunt selected</span>
                )}
              </div>
              <div className="flex items-center gap-1 flex-shrink-0">
                <button onClick={onOpenModelPicker}
                  className="text-[10px] text-neutral-500 hover:text-brand-400 font-mono px-1.5 py-0.5 border border-neutral-800 hover:border-neutral-700 transition-colors">
                  {modelDisplayName}
                </button>
                <button onClick={onExportChat} disabled={!activeSession || messages.length === 0}
                  className="text-neutral-500 hover:text-neutral-300 disabled:opacity-30 transition-colors" title="Export">
                  <Download className="w-3 h-3" />
                </button>
                {!contextOpen && (
                  <button onClick={onOpenContext} className="text-neutral-500 hover:text-brand-400 transition-colors" title="Open context">
                    <PanelRight className="w-3 h-3" />
                  </button>
                )}
              </div>
            </div>

            {/* Messages */}
            <div ref={scrollContainerRef} onScroll={onMessagesScroll} className="flex-1 overflow-y-auto px-3 py-3 space-y-2">
              {!activeSessionId && (
                <div className="flex flex-col items-center justify-center h-full text-neutral-500">
                  <LayoutDashboard className="w-8 h-8 mb-2 opacity-20" />
                  <p className="text-sm mb-1">Select a hunt or start a new one</p>
                  <button onClick={onNewHunt}
                    className="mt-2 px-4 py-1.5 text-xs bg-brand-500 hover:bg-brand-600 text-neutral-900 transition-colors flex items-center gap-1.5">
                    <Plus className="w-3 h-3" />New Hunt
                  </button>
                </div>
              )}
              {loadingHistory && (
                <div className="flex items-center justify-center py-8">
                  <Loader2 className="w-5 h-5 animate-spin text-brand-500" />
                </div>
              )}
              <MessageList
                messages={messages}
                activeSessionId={activeSessionId}
                getToolGroupCollapsed={getToolGroupCollapsed}
                handleToolGroupToggle={handleToolGroupToggle}
              />
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
                        registerWriter={(write) => onRegisterLiveWriter(idx, write)}
                        persistKey={liveKey}
                        collapsedOverride={getToolGroupCollapsed(liveKey)}
                        onToggle={handleToolGroupToggle}
                        rationale={tc.rationale} />
                    )
                  })}
                </div>
              )}
              {loading && (streamingContent || streamingThinking) && (
                <>
                  {streamingThinking && <ThinkingBlock content={streamingThinking} />}
                  <div className="flex flex-col items-start">
                    <div className="max-w-[80%] px-3 py-2 text-sm bg-neutral-900 text-neutral-200 border border-neutral-800">
                      <div className="text-[10px] text-brand-400 font-semibold mb-1 uppercase tracking-wider">AI</div>
                      {streamingContent && (
                        <>
                          <MarkdownContent content={streamingContent} />
                          <span className="inline-block w-1.5 h-4 bg-brand-400 animate-pulse ml-0.5 align-middle" />
                        </>
                      )}
                      {!streamingContent && (
                        <div className="flex items-center gap-1.5 py-1">
                          <span className="w-1.5 h-1.5 bg-brand-400 opacity-40 animate-bounce" style={{ animationDelay: "0ms" }} />
                          <span className="w-1.5 h-1.5 bg-brand-400 opacity-40 animate-bounce" style={{ animationDelay: "150ms" }} />
                          <span className="w-1.5 h-1.5 bg-brand-400 opacity-40 animate-bounce" style={{ animationDelay: "300ms" }} />
                        </div>
                      )}
                    </div>
                  </div>
                </>
              )}
              {loading && !streamingContent && !streamingThinking && liveToolCalls.length === 0 && (
                <div className="flex justify-start">
                  <div className="bg-neutral-900 border border-neutral-800 px-3 py-2">
                    <div className="flex items-center gap-1.5">
                      <span className="w-1.5 h-1.5 bg-brand-400 opacity-40 animate-bounce" style={{ animationDelay: "0ms" }} />
                      <span className="w-1.5 h-1.5 bg-brand-400 opacity-40 animate-bounce" style={{ animationDelay: "150ms" }} />
                      <span className="w-1.5 h-1.5 bg-brand-400 opacity-40 animate-bounce" style={{ animationDelay: "300ms" }} />
                    </div>
                  </div>
                </div>
              )}
              <div ref={messagesEndRef} />
            </div>

            {/* Input bar */}
            <div className="border-t border-neutral-800 px-3 py-2 bg-neutral-900 flex-shrink-0">
              <div className="flex items-stretch gap-2">
                <Textarea ref={chatInputRef} value={input} onChange={e => onInputChange(e.target.value)} onKeyDown={onKeyDown}
                  placeholder={activeSessionId ? "Message... (Enter to send, Shift+Enter for newline)" : "Select a hunt first"}
                  disabled={!activeSessionId || loading}
                  tabIndex={1}
                  className="flex-1 text-sm bg-neutral-800 border-neutral-700 text-white resize-none min-h-[40px] max-h-40 placeholder:text-neutral-600 focus-visible:outline-none focus-visible:ring-0 focus-visible:ring-offset-0 focus-visible:border-brand-500" rows={2} />
                {loading
                  ? <button onClick={onStopStream} className="bg-neutral-700 hover:bg-red-900/60 border border-neutral-600 hover:border-red-500/50 text-neutral-300 hover:text-red-400 w-10 flex items-center justify-center flex-shrink-0 transition-colors">
                      <Square className="w-4 h-4" />
                    </button>
                  : <button onClick={onSendMessage} disabled={!activeSessionId || !input.trim()}
                      className="bg-brand-500 hover:bg-brand-600 disabled:opacity-40 text-neutral-900 w-10 flex items-center justify-center flex-shrink-0 transition-colors">
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
          className="w-1 flex-shrink-0 bg-neutral-800 hover:bg-brand-500 transition-colors cursor-col-resize z-10"
          onMouseDown={handleRightDragStart}
        />
      )}

      {/* ── Right: Context panel ── */}
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
                <button onClick={onOpenScopePicker} className="text-neutral-500 hover:text-brand-400 transition-colors">
                  <Pencil className="w-3 h-3" />
                </button>
              )}
              <button onClick={onCloseContext} className="text-neutral-600 hover:text-neutral-400 transition-colors">
                <ChevronRight className="w-3 h-3" />
              </button>
            </div>
          </div>
          <div className="flex-1 overflow-y-auto divide-y divide-neutral-800">
            {!activeSession ? (
              <p className="text-xs text-neutral-600 leading-relaxed p-3">Select or create a hunt to see its context.</p>
            ) : (
              <>
                {/* Scope */}
                <div className="px-3 py-2">
                  <p className="text-[10px] text-neutral-500 uppercase tracking-wider mb-1.5">Scope</p>
                  <div className="flex items-center gap-2 bg-neutral-800 border border-neutral-700 px-2 py-1.5">
                    <div className="flex-1 min-w-0">
                      <div className="text-xs text-neutral-200 truncate">{SCOPE_LABELS[activeSession.scope] ?? activeSession.scope}</div>
                    </div>
                    <button onClick={onOpenScopePicker}
                      className="text-[10px] text-neutral-500 hover:text-brand-400 transition-colors flex-shrink-0 px-1.5 py-0.5 border border-neutral-700 hover:border-brand-500/40">
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
                    {lastUsage && (
                      <div className="flex items-center gap-1">
                        <span>Tokens:</span>
                        <span className="text-neutral-300 font-mono">↑{lastUsage.prompt_tokens.toLocaleString()} ↓{lastUsage.completion_tokens.toLocaleString()}</span>
                      </div>
                    )}
                    {activeSession.target_url && (
                      <div>Target: <span className="text-brand-300 font-mono break-all">{activeSession.target_url}</span></div>
                    )}
                  </div>
                </div>
                {/* Limits */}
                <div className="px-3 py-2">
                  <p className="text-[10px] text-neutral-500 uppercase tracking-wider mb-1.5">Limits</p>
                  <div className="flex items-center gap-2">
                    <label className="text-[10px] text-neutral-400 flex-1">Max tool calls</label>
                    <input type="number" min={1} max={50} value={maxToolCalls}
                      onChange={e => onMaxToolCallsChange(Math.max(1, Math.min(50, Number(e.target.value))))}
                      tabIndex={3}
                      className="w-14 text-[10px] text-center bg-neutral-800 border border-neutral-700 px-1 py-0.5 text-neutral-200 focus:outline-none focus:border-brand-500/60" />
                  </div>
                </div>
                {/* AI Tools */}
                <div className="px-3 py-2">
                  <div className="flex items-center justify-between mb-1.5">
                    <p className="text-[10px] text-neutral-500 uppercase tracking-wider">AI Tools</p>
                    {availableTools.length > 0 && (
                      <div className="flex items-center gap-2">
                        <button
                          onClick={onEnableAll}
                          className="text-[9px] text-neutral-600 hover:text-neutral-400 transition-colors"
                        >
                          enable all
                        </button>
                        <span className="text-[9px] text-neutral-700">·</span>
                        <button
                          onClick={onDisableAll}
                          className="text-[9px] text-neutral-600 hover:text-neutral-400 transition-colors"
                        >
                          disable all
                        </button>
                      </div>
                    )}
                  </div>
                  {availableTools.length === 0 ? (
                    <p className="text-[10px] text-neutral-600 italic">Loading…</p>
                  ) : (() => {
                    // Group tools by their `group` field, preserving canonical order
                    const byGroup = availableTools.reduce<Record<string, ToolInfo[]>>((acc, t) => {
                      const g = t.group ?? "Other"
                      ;(acc[g] ??= []).push(t)
                      return acc
                    }, {})
                    const orderedGroups = [
                      ...TOOL_GROUP_ORDER.filter(g => g in byGroup),
                      ...Object.keys(byGroup).filter(g => !TOOL_GROUP_ORDER.includes(g)),
                    ]
                    return orderedGroups.map(group => {
                      const isCollapsed = !!collapsedGroups[group]
                      return (
                        <div key={group} className="mb-1.5 last:mb-0">
                          <button
                            onClick={() => toggleToolGroup(group)}
                            className="w-full flex items-center gap-1 py-0.5 text-left group/gh"
                          >
                            <ChevronRight
                              className={`w-2.5 h-2.5 text-neutral-600 group-hover/gh:text-neutral-400 flex-shrink-0 transition-transform ${isCollapsed ? "" : "rotate-90"}`}
                            />
                            <span className="text-[9px] text-neutral-600 group-hover/gh:text-neutral-400 uppercase tracking-wider transition-colors">{group}</span>
                          </button>
                          {!isCollapsed && (
                            <div className="space-y-0.5 pl-3.5">
                              {byGroup[group].map(({ name, label }) => {
                                const checked = enabledTools === null || enabledTools.includes(name)
                                return (
                                  <div key={name} className="flex items-center gap-2 py-0.5">
                                    <input
                                      type="checkbox"
                                      checked={checked}
                                      onChange={e => onToolToggle(name, e.target.checked)}
                                      id={`tool-${name}`}
                                      className="w-3 h-3 accent-brand-500 flex-shrink-0 cursor-pointer"
                                    />
                                    <label htmlFor={`tool-${name}`} className="text-[10px] text-neutral-300 flex-1 truncate cursor-pointer" title={name}>
                                      {label}
                                    </label>
                                  </div>
                                )
                              })}
                            </div>
                          )}
                        </div>
                      )
                    })
                  })()}
                </div>
              </>
            )}
          </div>
        </div>
      </div>
    </>
  )
}
