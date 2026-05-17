"use client"

import { apiFetch } from "@/lib/api-fetch"

import React, { useState, useEffect, useRef } from "react"
import { ArrowLeft, Loader2, Save, Trash2, Play, Square, Terminal, FileCode, WrapText } from "lucide-react"
import { Button } from "@/components/ui/button"
import { useDragResize } from "./tool-views"
import CodeMirror, { EditorView } from "@uiw/react-codemirror"
import { atomoneInit } from "@uiw/codemirror-theme-atomone"
import { StreamLanguage } from "@codemirror/language"
import { python as pythonMode } from "@codemirror/legacy-modes/mode/python"
import { shell } from "@codemirror/legacy-modes/mode/shell"
import { indentWithTab } from "@codemirror/commands"
import { keymap } from "@codemirror/view"

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000"

// ── CodeMirror theme (matches Gnaw) ──────────────────────────────────────

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

function langExtensions(filePath: string) {
  if (filePath.endsWith(".py")) return [StreamLanguage.define(pythonMode)]
  if (filePath.endsWith(".sh")) return [StreamLanguage.define(shell)]
  return []
}

interface FileEditorProps { sessionId: string; filePath: string; onBack: () => void; onDeleted: () => void }

export function FileEditor({ sessionId, filePath, onBack, onDeleted }: FileEditorProps) {
  const [content, setContent] = useState("")
  const [originalContent, setOriginalContent] = useState("")
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [running, setRunning] = useState(false)
  const [runOutput, setRunOutput] = useState<string[]>([])
  const [runStatus, setRunStatus] = useState<"idle" | "running" | "passed" | "failed" | "error">("idle")
  const [splitPct, dragHandleProps] = useDragResize(45)
  const [stacked, setStacked] = useState(false)
  const [wordWrap, setWordWrap] = useState(() => ["tests", "scripts"].includes(filePath.split("/")[0]))
  const outputRef = useRef<HTMLPreElement>(null)
  const runAbortRef = useRef<AbortController | null>(null)
  const fileName = filePath.split("/").pop() ?? filePath
  const subdir = filePath.split("/")[0]
  const isRunnable = subdir !== "notes"

  useEffect(() => {
    setLoading(true)
    apiFetch(`${API_BASE}/api/workspaces/${sessionId}/files/${filePath}`)
      .then(r => r.json()).then(d => { setContent(d.content ?? ""); setOriginalContent(d.content ?? "") })
      .catch(() => setContent("")).finally(() => setLoading(false))
  }, [sessionId, filePath])

  const isDirty = content !== originalContent

  const handleSave = async () => {
    setSaving(true)
    try {
      await apiFetch(`${API_BASE}/api/workspaces/${sessionId}/files/${filePath}`, {
        method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ content }),
      })
      setOriginalContent(content)
    } finally { setSaving(false) }
  }

  const handleRun = async () => {
    if (isDirty) await handleSave()
    setRunning(true); setRunOutput([]); setRunStatus("running")
    runAbortRef.current = new AbortController()
    try {
      const res = await apiFetch(`${API_BASE}/api/workspaces/${sessionId}/files/${filePath}/run`, { method: "POST", signal: runAbortRef.current.signal })
      const reader = res.body?.getReader()
      if (!reader) throw new Error("No stream")
      const decoder = new TextDecoder(); let buf = ""
      while (true) {
        const { done, value } = await reader.read(); if (done) break
        buf += decoder.decode(value, { stream: true })
        const lines = buf.split("\n"); buf = lines.pop() ?? ""
        for (const line of lines) {
          if (!line.startsWith("data:")) continue
          try {
            const evt = JSON.parse(line.slice(5).trim())
            if (evt.line !== undefined) { setRunOutput(prev => [...prev, evt.line]); if (outputRef.current) outputRef.current.scrollTop = outputRef.current.scrollHeight }
            if (evt.status && evt.status !== "running") setRunStatus(evt.status)
          } catch { /**/ }
        }
      }
    } catch (err: unknown) {
      if ((err as Error)?.name !== "AbortError") { setRunStatus("error"); setRunOutput(prev => [...prev, `Error: ${(err as Error).message}`]) }
    } finally { setRunning(false) }
  }

  const handleDelete = async () => {
    if (!confirm(`Delete ${filePath}?`)) return
    await apiFetch(`${API_BASE}/api/workspaces/${sessionId}/files/${filePath}`, { method: "DELETE" })
    onDeleted()
  }

  const statusColor = runStatus === "passed" ? "text-green-400" : runStatus === "failed" ? "text-red-400" : runStatus === "error" ? "text-red-500" : "text-neutral-400"

  const editorPane = (
    <div className="flex flex-col h-full min-w-0">
      <div className="flex items-center gap-2 px-3 py-2 border-b border-neutral-800 bg-neutral-900 flex-shrink-0">
        <FileCode className="w-3.5 h-3.5 text-neutral-500" />
        <span className="text-xs text-neutral-300 font-mono truncate flex-1">{filePath}</span>
        {isDirty && <span className="text-[10px] text-orange-400">●</span>}
      </div>
      {loading
        ? <div className="flex-1 flex items-center justify-center"><Loader2 className="w-5 h-5 animate-spin text-neutral-500" /></div>
        : <div className="flex-1 overflow-hidden">
            <CodeMirror
              value={content}
              onChange={setContent}
              theme={cmTheme}
              extensions={[
                cmOverrides,
                keymap.of([indentWithTab]),
                ...langExtensions(filePath),
                ...(wordWrap ? [EditorView.lineWrapping] : []),
              ]}
              basicSetup={{ lineNumbers: true, foldGutter: false, highlightActiveLine: true }}
              style={{ height: "100%" }}
            />
          </div>
      }
    </div>
  )

  const outputPane = (
    <div className="flex flex-col h-full min-w-0">
      <div className="flex items-center gap-2 px-3 py-2 border-b border-neutral-800 bg-neutral-900 flex-shrink-0">
        <Terminal className="w-3.5 h-3.5 text-neutral-500" />
        <span className="text-xs text-neutral-400">Output</span>
        {runStatus !== "idle" && <span className={`text-[10px] font-medium uppercase ml-auto ${statusColor}`}>{runStatus}</span>}
      </div>
      <pre ref={outputRef} className="flex-1 overflow-y-auto p-3 text-xs font-mono text-neutral-300 bg-neutral-950 whitespace-pre-wrap">
        {runOutput.length === 0 && !running ? <span className="text-neutral-600 italic">No output yet. Click Run to execute.</span> : runOutput.join("\n")}
        {running && <span className="text-orange-400 animate-pulse">▌</span>}
      </pre>
    </div>
  )

  return (
    <div className="flex flex-col h-full">
      {/* Toolbar */}
      <div className="flex items-center gap-2 px-3 py-2 border-b border-neutral-800 bg-neutral-900 flex-shrink-0">
        <button onClick={onBack} className="flex items-center gap-1.5 text-sm text-neutral-400 hover:text-white transition-colors">
          <ArrowLeft className="w-3.5 h-3.5" /><span className="font-bold text-white">Chat</span>
        </button>
        <span className="text-neutral-600">/</span>
        <span className="text-sm font-bold text-white font-mono">{fileName}</span>
        <div className="flex-1" />
        <button onClick={() => setWordWrap(w => !w)} title={wordWrap ? "Disable word wrap" : "Enable word wrap"}
          className={`text-xs transition-colors px-2 py-1 border ${wordWrap ? "text-orange-400 border-orange-500/40 hover:border-orange-400" : "text-neutral-500 border-neutral-700 hover:text-neutral-300 hover:border-neutral-600"}`}>
          <WrapText className="w-3.5 h-3.5" />
        </button>
        <button onClick={() => setStacked(s => !s)}
          className="text-xs text-neutral-500 hover:text-neutral-300 transition-colors px-2 py-1 border border-neutral-700 hover:border-neutral-600">
          {stacked ? "⬛⬛" : "⬜⬜"}
        </button>
        <Button size="sm" variant="ghost" className="h-7 text-xs text-neutral-400 hover:text-red-400" onClick={handleDelete}>
          <Trash2 className="w-3.5 h-3.5" />
        </Button>
        <Button size="sm" variant="ghost"
          className={`h-7 text-xs ${isDirty ? "text-orange-400 hover:text-orange-300" : "text-neutral-500"}`}
          onClick={handleSave} disabled={saving || !isDirty}>
          {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />}
          <span className="ml-1">Save</span>
        </Button>
        {isRunnable && (
          <Button size="sm"
            className={`h-7 text-xs ${running ? "bg-red-600 hover:bg-red-700" : "bg-orange-500 hover:bg-orange-600"} text-white`}
            onClick={running ? () => { runAbortRef.current?.abort(); setRunning(false) } : handleRun}>
            {running ? <><Square className="w-3.5 h-3.5 mr-1" />Stop</> : <><Play className="w-3.5 h-3.5 mr-1" />Run</>}
          </Button>
        )}
      </div>
      {stacked ? (
        <div className="flex flex-col flex-1 overflow-hidden">
          <div className="flex-1 overflow-hidden border-b border-neutral-800">{editorPane}</div>
          <div className="flex-1 overflow-hidden">{outputPane}</div>
        </div>
      ) : (
        <div className="flex flex-1 overflow-hidden">
          <div className="overflow-hidden" style={{ width: `${splitPct}%` }}>{editorPane}</div>
          <div className="w-1 bg-neutral-800 hover:bg-orange-500/40 flex-shrink-0 transition-colors" {...dragHandleProps} />
          <div className="overflow-hidden flex-1">{outputPane}</div>
        </div>
      )}
    </div>
  )
}
