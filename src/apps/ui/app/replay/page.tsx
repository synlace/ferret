"use client"

import React, { useState, useEffect, useCallback } from "react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Badge } from "@/components/ui/badge"
import { Textarea } from "@/components/ui/textarea"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import {
  Play, RefreshCw, Send, Copy, Check, X, ChevronRight,
  MessageSquare, Loader2, RotateCcw, Clock, Zap
} from "lucide-react"

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ApiRequest {
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

interface ReplayResult {
  status_code: number
  response_time: number
  response_size: number
  response_headers: Record<string, string>
  response_body: string
}

interface ChatMsg {
  role: "user" | "assistant"
  content: string
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const getStatusColor = (status: number | null) => {
  if (!status) return "bg-gray-600"
  if (status >= 200 && status < 300) return "bg-green-500"
  if (status >= 300 && status < 400) return "bg-yellow-500"
  if (status >= 400 && status < 500) return "bg-red-500"
  if (status >= 500) return "bg-purple-500"
  return "bg-gray-500"
}

const getMethodColor = (method: string) => {
  switch (method) {
    case "GET":    return "bg-blue-500"
    case "POST":   return "bg-green-500"
    case "PUT":    return "bg-yellow-500"
    case "DELETE": return "bg-red-500"
    case "PATCH":  return "bg-purple-500"
    default:       return "bg-gray-500"
  }
}

const formatTime = (iso: string) => {
  try { return new Date(iso).toLocaleTimeString("en-GB", { hour12: false }) }
  catch { return iso }
}

const buildRawRequest = (req: ApiRequest): string => {
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

// ---------------------------------------------------------------------------
// Main page
// ---------------------------------------------------------------------------

export default function ReplayPage() {
  // Left panel — request list
  const [requests, setRequests] = useState<ApiRequest[]>([])
  const [loadingList, setLoadingList] = useState(false)
  const [methodFilter, setMethodFilter] = useState("all")
  const [searchFilter, setSearchFilter] = useState("")
  const [selectedId, setSelectedId] = useState<string | null>(null)

  // Center panel — editable replay fields
  const [editMethod, setEditMethod] = useState("GET")
  const [editUrl, setEditUrl] = useState("")
  const [editHeaders, setEditHeaders] = useState("")
  const [editBody, setEditBody] = useState("")
  const [activeTab, setActiveTab] = useState<"request" | "response">("request")

  // Replay state
  const [replaying, setReplaying] = useState(false)
  const [replayResult, setReplayResult] = useState<ReplayResult | null>(null)
  const [replayError, setReplayError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)

  // Right panel — AI chat
  const [chatOpen, setChatOpen] = useState(false)
  const [chatMessages, setChatMessages] = useState<ChatMsg[]>([])
  const [chatInput, setChatInput] = useState("")
  const [chatLoading, setChatLoading] = useState(false)

  // ---------------------------------------------------------------------------
  // Fetch captured requests for the left panel
  // ---------------------------------------------------------------------------

  const fetchRequests = useCallback(async () => {
    setLoadingList(true)
    try {
      const params = new URLSearchParams({ limit: "200" })
      if (methodFilter !== "all") params.set("method", methodFilter)
      if (searchFilter.trim()) params.set("search", searchFilter.trim())
      const res = await fetch(`${API_BASE}/api/requests?${params}`)
      if (res.ok) setRequests(await res.json())
    } catch {
      // ignore
    } finally {
      setLoadingList(false)
    }
  }, [methodFilter, searchFilter])

  useEffect(() => { fetchRequests() }, [fetchRequests])

  // ---------------------------------------------------------------------------
  // Select a request — populate editable fields
  // ---------------------------------------------------------------------------

  const selectRequest = (req: ApiRequest) => {
    setSelectedId(req.id)
    setEditMethod(req.method)
    setEditUrl(req.url)
    setReplayResult(null)
    setReplayError(null)
    setActiveTab("request")

    // Serialise headers to "Key: Value\n..." format for the textarea
    const headerLines = req.headers
      ? Object.entries(req.headers)
          .filter(([k]) => k.toLowerCase() !== "host")
          .map(([k, v]) => `${k}: ${v}`)
          .join("\n")
      : ""
    setEditHeaders(headerLines)
    setEditBody(req.body ?? "")
  }

  // ---------------------------------------------------------------------------
  // Parse the headers textarea back into a Record
  // ---------------------------------------------------------------------------

  const parseHeaders = (raw: string): Record<string, string> => {
    const result: Record<string, string> = {}
    for (const line of raw.split("\n")) {
      const colon = line.indexOf(":")
      if (colon > 0) {
        const key = line.slice(0, colon).trim()
        const val = line.slice(colon + 1).trim()
        if (key) result[key] = val
      }
    }
    return result
  }

  // ---------------------------------------------------------------------------
  // Send replay
  // ---------------------------------------------------------------------------

  const sendReplay = async () => {
    if (!editUrl.trim()) return
    setReplaying(true)
    setReplayResult(null)
    setReplayError(null)
    setActiveTab("response")
    try {
      const res = await fetch(`${API_BASE}/api/replay`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          method: editMethod,
          url: editUrl,
          headers: parseHeaders(editHeaders),
          body: editBody || null,
        }),
      })
      if (res.ok) {
        setReplayResult(await res.json())
      } else {
        const data = await res.json().catch(() => ({ detail: res.statusText }))
        setReplayError(data.detail ?? `HTTP ${res.status}`)
      }
    } catch (e) {
      setReplayError(e instanceof Error ? e.message : "Replay failed")
    } finally {
      setReplaying(false)
    }
  }

  // ---------------------------------------------------------------------------
  // Reset editable fields to the original captured request
  // ---------------------------------------------------------------------------

  const resetToOriginal = () => {
    const req = requests.find(r => r.id === selectedId)
    if (!req) return
    selectRequest(req)
  }

  // ---------------------------------------------------------------------------
  // Copy response body
  // ---------------------------------------------------------------------------

  const copyResponse = () => {
    if (!replayResult) return
    navigator.clipboard.writeText(replayResult.response_body).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    }).catch(() => {})
  }

  // ---------------------------------------------------------------------------
  // AI chat
  // ---------------------------------------------------------------------------

  const sendChat = async () => {
    if (!chatInput.trim()) return
    const userMsg: ChatMsg = { role: "user", content: chatInput }
    setChatMessages(prev => [...prev, userMsg])
    setChatInput("")
    setChatLoading(true)
    try {
      const res = await fetch(`${API_BASE}/api/replay/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: chatInput,
          context: {
            method: editMethod,
            url: editUrl,
            headers: editHeaders,
            body: editBody,
            response: replayResult ?? null,
          },
        }),
      })
      if (res.ok) {
        const data = await res.json()
        setChatMessages(prev => [...prev, { role: "assistant", content: data.reply ?? "" }])
      }
    } catch {
      setChatMessages(prev => [...prev, { role: "assistant", content: "Error contacting AI." }])
    } finally {
      setChatLoading(false)
    }
  }

  // ---------------------------------------------------------------------------
  // Derived
  // ---------------------------------------------------------------------------

  const selectedRequest = requests.find(r => r.id === selectedId) ?? null

  const filteredRequests = requests.filter(r => {
    if (methodFilter !== "all" && r.method !== methodFilter) return false
    if (searchFilter.trim()) {
      const q = searchFilter.toLowerCase()
      return r.url.toLowerCase().includes(q) || r.host.toLowerCase().includes(q)
    }
    return true
  })

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  return (
    <div className="flex h-full bg-neutral-950 text-white">

      {/* ------------------------------------------------------------------ */}
      {/* Left panel — captured request list                                  */}
      {/* ------------------------------------------------------------------ */}
      <aside className="w-72 border-r border-neutral-700 flex flex-col bg-neutral-900 shrink-0">
        <div className="p-3 border-b border-neutral-700">
          <div className="flex items-center justify-between mb-2">
            <span className="text-xs font-semibold text-orange-500 tracking-wider">CAPTURED REQUESTS</span>
            <Button
              variant="ghost" size="icon"
              className="h-6 w-6 text-neutral-400 hover:text-orange-500"
              onClick={fetchRequests}
            >
              <RefreshCw className="w-3 h-3" />
            </Button>
          </div>
          <Input
            placeholder="Search URL or host..."
            value={searchFilter}
            onChange={e => setSearchFilter(e.target.value)}
            className="h-7 text-xs bg-neutral-800 border-neutral-600 text-white mb-2"
          />
          <Select value={methodFilter} onValueChange={setMethodFilter}>
            <SelectTrigger className="h-7 bg-neutral-800 border-neutral-600 text-white text-xs">
              <SelectValue placeholder="Method" />
            </SelectTrigger>
            <SelectContent className="bg-neutral-800 border-neutral-600">
              <SelectItem value="all" className="text-white text-xs">All Methods</SelectItem>
              <SelectItem value="GET" className="text-white text-xs">GET</SelectItem>
              <SelectItem value="POST" className="text-white text-xs">POST</SelectItem>
              <SelectItem value="PUT" className="text-white text-xs">PUT</SelectItem>
              <SelectItem value="DELETE" className="text-white text-xs">DELETE</SelectItem>
              <SelectItem value="PATCH" className="text-white text-xs">PATCH</SelectItem>
            </SelectContent>
          </Select>
        </div>

        <div className="flex-1 overflow-y-auto">
          {loadingList && filteredRequests.length === 0 && (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="w-4 h-4 animate-spin text-orange-500" />
            </div>
          )}
          {!loadingList && filteredRequests.length === 0 && (
            <p className="text-xs text-neutral-500 p-4 text-center">No requests captured yet.</p>
          )}
          {filteredRequests.map(req => (
            <button
              key={req.id}
              onClick={() => selectRequest(req)}
              className={`w-full text-left px-3 py-2.5 border-b border-neutral-800 transition-colors ${
                selectedId === req.id
                  ? "bg-orange-500/15 border-l-2 border-l-orange-500"
                  : "hover:bg-neutral-800"
              }`}
            >
              <div className="flex items-center gap-2 mb-1">
                <Badge className={`${getMethodColor(req.method)} text-white border-0 text-xs px-1.5 py-0 shrink-0`}>
                  {req.method}
                </Badge>
                {req.status_code && (
                  <Badge className={`${getStatusColor(req.status_code)} text-white border-0 text-xs px-1.5 py-0 shrink-0`}>
                    {req.status_code}
                  </Badge>
                )}
                <span className="text-xs text-neutral-500 ml-auto shrink-0">{formatTime(req.timestamp)}</span>
              </div>
              <div className="text-xs text-neutral-300 truncate font-mono">{req.host}{req.path}</div>
            </button>
          ))}
        </div>
      </aside>

      {/* ------------------------------------------------------------------ */}
      {/* Center panel — editable request + response                          */}
      {/* ------------------------------------------------------------------ */}
      <section className="flex-1 flex flex-col min-w-0">
        {!selectedId ? (
          <div className="flex-1 flex items-center justify-center text-neutral-500">
            <div className="text-center">
              <RotateCcw className="w-12 h-12 mx-auto mb-3 opacity-30" />
              <p className="text-sm">Select a captured request to replay</p>
              <p className="text-xs mt-1 text-neutral-600">Modify headers, body, or URL before sending</p>
            </div>
          </div>
        ) : (
          <>
            {/* Toolbar */}
            <div className="border-b border-neutral-700 p-3 flex items-center gap-2 bg-neutral-900 shrink-0">
              {/* Method selector */}
              <Select value={editMethod} onValueChange={setEditMethod}>
                <SelectTrigger className="w-28 h-8 bg-neutral-800 border-neutral-600 text-white text-xs font-mono">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent className="bg-neutral-800 border-neutral-600">
                  {["GET","POST","PUT","DELETE","PATCH","HEAD","OPTIONS"].map(m => (
                    <SelectItem key={m} value={m} className="text-white text-xs font-mono">{m}</SelectItem>
                  ))}
                </SelectContent>
              </Select>

              {/* URL input */}
              <Input
                value={editUrl}
                onChange={e => setEditUrl(e.target.value)}
                onKeyDown={e => { if (e.key === "Enter") sendReplay() }}
                placeholder="https://example.com/api/endpoint"
                className="flex-1 h-8 text-xs font-mono bg-neutral-800 border-neutral-600 text-white"
              />

              {/* Send button */}
              <Button
                size="sm"
                onClick={sendReplay}
                disabled={replaying || !editUrl.trim()}
                className="bg-orange-500 hover:bg-orange-600 text-white text-xs h-8 shrink-0"
              >
                {replaying ? (
                  <Loader2 className="w-3 h-3 mr-1 animate-spin" />
                ) : (
                  <Send className="w-3 h-3 mr-1" />
                )}
                Send
              </Button>

              {/* Reset to original */}
              <Button
                size="sm"
                variant="outline"
                onClick={resetToOriginal}
                className="border-neutral-600 text-neutral-400 hover:text-white text-xs h-8 shrink-0"
                title="Reset to original captured request"
              >
                <RotateCcw className="w-3 h-3 mr-1" />
                Reset
              </Button>

              {/* AI Chat toggle */}
              <Button
                size="sm"
                variant="outline"
                onClick={() => setChatOpen(!chatOpen)}
                className="border-neutral-600 text-neutral-300 hover:text-orange-500 text-xs h-8 shrink-0"
              >
                <MessageSquare className="w-3 h-3 mr-1" />
                AI Chat
              </Button>
            </div>

            {/* Tabs */}
            <div className="border-b border-neutral-700 flex bg-neutral-900 shrink-0">
              {(["request", "response"] as const).map(tab => (
                <button
                  key={tab}
                  onClick={() => setActiveTab(tab)}
                  className={`px-4 py-2 text-xs font-medium transition-colors capitalize ${
                    activeTab === tab
                      ? "text-orange-500 border-b-2 border-orange-500"
                      : "text-neutral-400 hover:text-white"
                  }`}
                >
                  {tab === "response" && replayResult && (
                    <span className={`inline-block w-2 h-2 rounded-full mr-1.5 ${getStatusColor(replayResult.status_code)}`} />
                  )}
                  {tab.charAt(0).toUpperCase() + tab.slice(1)}
                  {tab === "response" && replayResult && (
                    <span className="ml-1.5 text-neutral-500">{replayResult.status_code}</span>
                  )}
                </button>
              ))}
            </div>

            {/* Tab content */}
            <div className="flex-1 overflow-auto flex flex-col">
              {activeTab === "request" && (
                <div className="flex flex-col flex-1 p-3 gap-3">
                  <div>
                    <label className="text-xs text-neutral-400 block mb-1">Headers <span className="text-neutral-600">(one per line: Key: Value)</span></label>
                    <Textarea
                      value={editHeaders}
                      onChange={e => setEditHeaders(e.target.value)}
                      placeholder={"Content-Type: application/json\nAuthorization: Bearer <token>"}
                      className="font-mono text-xs bg-neutral-950 border-neutral-700 text-cyan-300 resize-none h-40"
                      spellCheck={false}
                    />
                  </div>
                  <div className="flex-1 flex flex-col">
                    <label className="text-xs text-neutral-400 block mb-1">Body</label>
                    <Textarea
                      value={editBody}
                      onChange={e => setEditBody(e.target.value)}
                      placeholder='{"key": "value"}'
                      className="flex-1 font-mono text-xs bg-neutral-950 border-neutral-700 text-green-300 resize-none min-h-48"
                      spellCheck={false}
                    />
                  </div>
                </div>
              )}

              {activeTab === "response" && (
                <div className="flex-1 flex flex-col">
                  {replaying && (
                    <div className="flex items-center justify-center flex-1 gap-2 text-neutral-500">
                      <Loader2 className="w-5 h-5 animate-spin text-orange-500" />
                      <span className="text-sm">Sending request...</span>
                    </div>
                  )}
                  {replayError && !replaying && (
                    <div className="m-4 bg-red-900/40 border border-red-700 text-red-300 rounded px-4 py-3 text-sm">
                      ⚠ {replayError}
                    </div>
                  )}
                  {!replaying && !replayError && !replayResult && (
                    <div className="flex items-center justify-center flex-1 text-neutral-600 text-sm">
                      Hit <kbd className="mx-1 px-1.5 py-0.5 bg-neutral-800 border border-neutral-600 rounded text-xs font-mono">Send</kbd> to see the response
                    </div>
                  )}
                  {replayResult && !replaying && (
                    <>
                      {/* Response meta bar */}
                      <div className="flex items-center gap-4 px-4 py-2 bg-neutral-900 border-b border-neutral-700 shrink-0">
                        <Badge className={`${getStatusColor(replayResult.status_code)} text-white border-0 text-xs`}>
                          {replayResult.status_code}
                        </Badge>
                        <span className="flex items-center gap-1 text-xs text-neutral-400">
                          <Clock className="w-3 h-3" />
                          {Math.round(replayResult.response_time)}ms
                        </span>
                        <span className="flex items-center gap-1 text-xs text-neutral-400">
                          <Zap className="w-3 h-3" />
                          {replayResult.response_size}B
                        </span>
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={copyResponse}
                          className="ml-auto text-neutral-400 hover:text-white h-6 text-xs"
                        >
                          {copied ? <Check className="w-3 h-3 mr-1" /> : <Copy className="w-3 h-3 mr-1" />}
                          {copied ? "Copied" : "Copy"}
                        </Button>
                      </div>

                      {/* Response headers */}
                      <div className="px-4 pt-3 pb-1 shrink-0">
                        <p className="text-xs text-neutral-400 mb-1">Response Headers</p>
                        <pre className="text-xs font-mono text-cyan-300 bg-neutral-950 p-2 rounded max-h-32 overflow-auto whitespace-pre-wrap">
                          {Object.entries(replayResult.response_headers)
                            .map(([k, v]) => `${k}: ${v}`)
                            .join("\n") || "(none)"}
                        </pre>
                      </div>

                      {/* Response body */}
                      <div className="flex-1 flex flex-col px-4 pb-3 pt-1 min-h-0">
                        <p className="text-xs text-neutral-400 mb-1">Response Body</p>
                        <pre className="flex-1 text-xs font-mono text-green-300 bg-neutral-950 p-3 rounded overflow-auto whitespace-pre-wrap min-h-0">
                          {replayResult.response_body || "(empty body)"}
                        </pre>
                      </div>
                    </>
                  )}
                </div>
              )}
            </div>

            {/* Original request comparison footer */}
            {selectedRequest && (
              <div className="border-t border-neutral-700 px-4 py-2 bg-neutral-900 shrink-0 flex items-center gap-3 text-xs text-neutral-500">
                <span>Original:</span>
                <Badge className={`${getMethodColor(selectedRequest.method)} text-white border-0 text-xs px-1.5 py-0`}>
                  {selectedRequest.method}
                </Badge>
                {selectedRequest.status_code && (
                  <Badge className={`${getStatusColor(selectedRequest.status_code)} text-white border-0 text-xs px-1.5 py-0`}>
                    {selectedRequest.status_code}
                  </Badge>
                )}
                <span className="font-mono truncate text-neutral-400">{selectedRequest.host}{selectedRequest.path}</span>
                {selectedRequest.response_time != null && (
                  <span className="shrink-0">{Math.round(selectedRequest.response_time)}ms</span>
                )}
              </div>
            )}
          </>
        )}
      </section>

      {/* ------------------------------------------------------------------ */}
      {/* Right panel — AI chat drawer                                        */}
      {/* ------------------------------------------------------------------ */}
      {chatOpen && (
        <aside className="w-80 border-l border-neutral-700 flex flex-col bg-neutral-900 shrink-0">
          <div className="p-3 border-b border-neutral-700 flex items-center justify-between">
            <span className="text-xs font-semibold text-orange-500">AI ASSISTANT</span>
            <Button
              variant="ghost" size="icon"
              className="h-6 w-6 text-neutral-400"
              onClick={() => setChatOpen(false)}
            >
              <X className="w-3 h-3" />
            </Button>
          </div>

          <div className="flex-1 overflow-y-auto p-3 space-y-3">
            {chatMessages.length === 0 && (
              <p className="text-xs text-neutral-500">
                Ask the AI to suggest parameter mutations, explain the response, or craft a security test for this request.
              </p>
            )}
            {chatMessages.map((msg, i) => (
              <div
                key={i}
                className={`text-xs rounded p-2 ${
                  msg.role === "user"
                    ? "bg-neutral-800 text-white ml-4"
                    : "bg-neutral-700 text-neutral-200 mr-4"
                }`}
              >
                <span className="font-semibold text-orange-400 block mb-1">
                  {msg.role === "user" ? "You" : "AI"}
                </span>
                <span className="whitespace-pre-wrap">{msg.content}</span>
              </div>
            ))}
            {chatLoading && (
              <div className="bg-neutral-700 rounded p-2 mr-4">
                <Loader2 className="w-3 h-3 animate-spin text-orange-400" />
              </div>
            )}
          </div>

          <div className="p-3 border-t border-neutral-700 flex gap-2">
            <Textarea
              value={chatInput}
              onChange={e => setChatInput(e.target.value)}
              onKeyDown={e => {
                if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendChat() }
              }}
              placeholder="Ask about this request..."
              className="flex-1 text-xs bg-neutral-800 border-neutral-600 text-white resize-none min-h-0 h-16"
            />
            <Button
              size="icon"
              onClick={sendChat}
              disabled={chatLoading || !chatInput.trim()}
              className="bg-orange-500 hover:bg-orange-600 self-end h-8 w-8"
            >
              <ChevronRight className="w-4 h-4" />
            </Button>
          </div>
        </aside>
      )}
    </div>
  )
}
