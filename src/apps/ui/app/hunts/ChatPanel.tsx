"use client"

import React, { useRef, memo } from "react"
import { Textarea } from "@/components/ui/textarea"
import {
  Loader2, Download, Send, Square,
  PanelLeftClose, PanelLeftOpen, PanelRight,
  LayoutDashboard, Plus, Pencil, ChevronRight,
} from "lucide-react"
import { SCOPE_LABELS } from "../chat/NewChatModal"
import { ToolGroup, formatTs } from "./tool-views"
import { CopyButton } from "./tool-views"
import { FileEditor } from "./FileEditor"
import { MarkdownContent } from "./MarkdownContent"
import { formatToolArgs } from "./helpers"
import type { WorkspaceSession, ChatMsg, LiveToolCall } from "./types"
import type { WorkspaceFile } from "./FileTree"

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
    </>
  )
})

interface ChatPanelProps {
  activeSession: WorkspaceSession | null
  activeSessionId: string | null
  messages: ChatMsg[]
  input: string
  loading: boolean
  loadingHistory: boolean
  streamingContent: string
  liveToolCalls: LiveToolCall[]
  model: string
  modelDisplayName: string
  maxToolCalls: number
  sessionSpend: number | null
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
  /** Called by XTermView when it's ready to receive chunks; idx is the liveToolCalls index */
  onRegisterLiveWriter: (idx: number, write: (chunk: string) => void) => void
}

export function ChatPanel({
  activeSession,
  activeSessionId,
  messages,
  input,
  loading,
  loadingHistory,
  streamingContent,
  liveToolCalls,
  model,
  modelDisplayName,
  maxToolCalls,
  sessionSpend,
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
  onRegisterLiveWriter,
}: ChatPanelProps) {
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
                  className="text-[10px] text-neutral-500 hover:text-orange-400 font-mono px-1.5 py-0.5 border border-neutral-800 hover:border-neutral-700 transition-colors">
                  {modelDisplayName}
                </button>
                <button onClick={onExportChat} disabled={!activeSession || messages.length === 0}
                  className="text-neutral-500 hover:text-neutral-300 disabled:opacity-30 transition-colors" title="Export">
                  <Download className="w-3 h-3" />
                </button>
                {!contextOpen && (
                  <button onClick={onOpenContext} className="text-neutral-500 hover:text-orange-400 transition-colors" title="Open context">
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
                    className="mt-2 px-4 py-1.5 text-xs bg-orange-500 hover:bg-orange-600 text-white transition-colors flex items-center gap-1.5">
                    <Plus className="w-3 h-3" />New Hunt
                  </button>
                </div>
              )}
              {loadingHistory && (
                <div className="flex items-center justify-center py-8">
                  <Loader2 className="w-5 h-5 animate-spin text-orange-500" />
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
              <div className="flex items-stretch gap-2">
                <Textarea ref={chatInputRef} value={input} onChange={e => onInputChange(e.target.value)} onKeyDown={onKeyDown}
                  placeholder={activeSessionId ? "Message... (Enter to send, Shift+Enter for newline)" : "Select a hunt first"}
                  disabled={!activeSessionId || loading}
                  className="flex-1 text-sm bg-neutral-800 border-neutral-700 text-white resize-none min-h-[40px] max-h-40 placeholder:text-neutral-600 focus-visible:ring-orange-500/50" rows={2} />
                {loading
                  ? <button onClick={onStopStream} className="bg-neutral-700 hover:bg-red-900/60 border border-neutral-600 hover:border-red-500/50 text-neutral-300 hover:text-red-400 w-10 flex items-center justify-center flex-shrink-0 transition-colors">
                      <Square className="w-4 h-4" />
                    </button>
                  : <button onClick={onSendMessage} disabled={!activeSessionId || !input.trim()}
                      className="bg-orange-500 hover:bg-orange-600 disabled:opacity-40 text-white w-10 flex items-center justify-center flex-shrink-0 transition-colors">
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
                <button onClick={onOpenScopePicker} className="text-neutral-500 hover:text-orange-400 transition-colors">
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
                    {activeSession.target_url && (
                      <div>Target: <span className="text-orange-300 font-mono break-all">{activeSession.target_url}</span></div>
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
    </>
  )
}
