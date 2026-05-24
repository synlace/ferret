"use client"

import { apiFetch } from "@/lib/api-fetch"
import React, { useState, useEffect, useCallback, useRef, useMemo } from "react"
import { js as beautifyJs } from "js-beautify"
import {
  Plus, Trash2, Loader2, FolderOpen, FolderClosed, Play, MessageSquare,
  RefreshCw, ChevronRight, ChevronDown, File,
  Copy, Download, X, Check, ExternalLink,
} from "lucide-react"
import { useProject } from "../context/project-context"
import { NewRunModal } from "../runs/NewRunModal"
import { NewChatModal } from "../chat/NewChatModal"
import { useRouter } from "next/navigation"
import CodeMirror, { EditorView } from "@uiw/react-codemirror"
import { atomoneInit } from "@uiw/codemirror-theme-atomone"
import { StreamLanguage } from "@codemirror/language"
import { json } from "@codemirror/lang-json"
import { html } from "@codemirror/lang-html"
import { javascript } from "@codemirror/lang-javascript"
import { css as cssLang } from "@codemirror/lang-css"
import { shell as shellMode } from "@codemirror/legacy-modes/mode/shell"
import { EditorState } from "@codemirror/state"
import ReactMarkdown from "react-markdown"
import remarkGfm from "remark-gfm"

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000"
const LIST_WIDTH_KEY  = "ferret_workspaces_list_width"
const SELECTED_WS_KEY = "ferret_workspaces_selected_ws"
/** Per-workspace file key — each workspace remembers its own last-opened file. */
const wsFileKey = (wsId: string) => `ferret_ws_file_${wsId}`
const DEFAULT_LIST_WIDTH = 260
const MIN_LIST_WIDTH = 160
const MAX_LIST_WIDTH = 520

// ---------------------------------------------------------------------------
// CodeMirror theme (matches proxy history / gnaw)
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

const cmBaseExtensions = [cmTheme, cmOverrides, EditorView.lineWrapping, EditorState.readOnly.of(true)]

/** Pick a CodeMirror language extension based on file extension. */
function cmLangForFile(filename: string) {
  const ext = filename.split(".").pop()?.toLowerCase() ?? ""
  switch (ext) {
    case "json": return [json()]
    case "html": case "htm": return [html()]
    case "js": case "ts": case "jsx": case "tsx": return [javascript({ typescript: ext === "ts" || ext === "tsx" })]
    case "css": return [cssLang()]
    case "sh": case "bash": return [StreamLanguage.define(shellMode)]
    default: return []
  }
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface Workspace {
  id: string
  project_id: string
  parent_id: string | null              // explicit DB parent (e.g. wildcard enum child)
  name: string
  created_at: string
  run_count: number
  hunt_count: number
  file_counts: Record<string, number>   // subdir → count, dynamic
}

interface WorkspaceFile {
  path: string
  subdir: string
  name: string
  size: number
  modified: number
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`
}

function totalFiles(ws: Workspace): number {
  if (!ws.file_counts) return 0
  return Object.values(ws.file_counts).reduce((a, b) => a + b, 0)
}

/** Assign a consistent color to any subdir name by hashing it. */
const PALETTE = [
  "#3b82f6","#22c55e","#eab308","#a855f7",
  "#ef4444","#06b6d4","#f97316","#ec4899","#14b8a6","#8b5cf6",
]
function subdirColor(name: string): string {
  let h = 0
  for (let i = 0; i < name.length; i++) h = ((h * 31) + name.charCodeAt(i)) >>> 0
  return PALETTE[h % PALETTE.length]
}

// ---------------------------------------------------------------------------
// Tree builder
// ---------------------------------------------------------------------------
// Two grouping mechanisms, applied in priority order:
//
//   1. parent_id (explicit DB relationship)
//      Set when a workspace was discovered by a wildcard run.
//      e.g. *.scanme.sh discovers honey.scanme.sh → parent_id = wildcard ws id.
//      Names stay clean; the relationship is stored in the DB.
//
//   2. Path-prefix fallback (display-only heuristic)
//      Used when parent_id is null. A workspace whose name starts with
//      "<candidate.name>/" is a display-child of that candidate.
//      e.g. "example.com/api" is a child of "example.com".
//
// The API returns workspaces sorted by name, so path-prefix parents always
// precede their children in the list.

interface TreeNode {
  ws: Workspace
  children: TreeNode[]
  depth: number
}

function buildTree(workspaces: Workspace[]): TreeNode[] {
  // Sort defensively; API already returns sorted by name
  const sorted = [...workspaces].sort((a, b) => a.name.localeCompare(b.name))

  const nodes = new Map<string, TreeNode>()
  sorted.forEach(ws => nodes.set(ws.id, { ws, children: [], depth: 0 }))

  const roots: TreeNode[] = []

  sorted.forEach(ws => {
    const node = nodes.get(ws.id)!

    // ── Priority 1: explicit parent_id ──────────────────────────────────
    if (ws.parent_id && nodes.has(ws.parent_id)) {
      const parentNode = nodes.get(ws.parent_id)!
      node.depth = parentNode.depth + 1
      parentNode.children.push(node)
      return
    }

    // ── Priority 2: path-prefix heuristic ───────────────────────────────
    let bestAncestor: Workspace | null = null
    sorted.forEach(candidate => {
      if (candidate.id === ws.id) return
      const prefix = candidate.name + "/"
      if (ws.name.startsWith(prefix)) {
        if (!bestAncestor || candidate.name.length > bestAncestor.name.length) {
          bestAncestor = candidate
        }
      }
    })

    if (bestAncestor) {
      const parentNode = nodes.get((bestAncestor as Workspace).id)!
      node.depth = parentNode.depth + 1
      parentNode.children.push(node)
    } else {
      roots.push(node)
    }
  })

  return roots
}

function flattenTree(roots: TreeNode[], expandedIds: Set<string>): TreeNode[] {
  const result: TreeNode[] = []
  function walk(node: TreeNode) {
    result.push(node)
    if (node.children.length > 0 && expandedIds.has(node.ws.id)) {
      node.children.forEach(walk)
    }
  }
  roots.forEach(walk)
  return result
}

// ---------------------------------------------------------------------------
// FileViewer
// ---------------------------------------------------------------------------

interface FileViewerProps {
  workspaceId: string
  file: WorkspaceFile
  onClose: () => void
}

function FileViewer({ workspaceId, file, onClose }: FileViewerProps) {
  const [content, setContent] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    setLoading(true)
    apiFetch(`${API_BASE}/api/workspaces/${workspaceId}/files/${file.path}`)
      .then(r => r.json())
      .then(d => setContent(d.content ?? ""))
      .catch(() => setContent("(error loading file)"))
      .finally(() => setLoading(false))
  }, [workspaceId, file.path])

  /** For JSON files, pretty-print before display. Raw content is kept for copy/download. */
  const displayContent = useMemo(() => {
    if (content == null) return null
    const ext = file.name.split(".").pop()?.toLowerCase() ?? ""
    if (ext === "json") {
      try {
        return beautifyJs(content, { indent_size: 2, brace_style: "collapse" })
      } catch {
        return content
      }
    }
    return content
  }, [content, file.name])

  const handleCopy = () => {
    if (content == null) return
    navigator.clipboard.writeText(content).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    })
  }

  const handleDownload = () => {
    if (content == null) return
    const blob = new Blob([content], { type: "text/plain" })
    const url = URL.createObjectURL(blob)
    const a = document.createElement("a")
    a.href = url; a.download = file.name; a.click()
    URL.revokeObjectURL(url)
  }

  const color = subdirColor(file.subdir)

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Viewer header */}
      <div className="flex items-center gap-2 px-3 h-8 border-b border-neutral-800 flex-shrink-0 bg-neutral-900">
        <span
          className="w-1.5 h-1.5 rounded-full flex-shrink-0"
          style={{ background: color }}
        />
        <span className="text-[11px] text-neutral-300 font-mono flex-1 truncate">
          {file.subdir}/{file.name}
        </span>
        <span className="text-[10px] text-neutral-600 flex-shrink-0">{formatSize(file.size)}</span>
        <button
          onClick={handleCopy}
          className="flex items-center gap-1 text-[10px] text-neutral-500 hover:text-neutral-300 transition-colors px-1.5 py-0.5 border border-neutral-800 hover:border-neutral-600 rounded"
        >
          {copied ? <Check className="w-2.5 h-2.5 text-green-400" /> : <Copy className="w-2.5 h-2.5" />}
          {copied ? "Copied" : "Copy"}
        </button>
        <button
          onClick={handleDownload}
          className="flex items-center gap-1 text-[10px] text-neutral-500 hover:text-neutral-300 transition-colors px-1.5 py-0.5 border border-neutral-800 hover:border-neutral-600 rounded"
        >
          <Download className="w-2.5 h-2.5" />
        </button>
        <button
          onClick={onClose}
          className="text-neutral-600 hover:text-red-400 transition-colors ml-1"
        >
          <X className="w-3 h-3" />
        </button>
      </div>
      {/* Content */}
      <div className="flex-1 overflow-hidden bg-neutral-950">
        {loading ? (
          <div className="flex items-center gap-2 px-3 py-4 text-[10px] text-neutral-600">
            <Loader2 className="w-3 h-3 animate-spin" />Loading…
          </div>
        ) : file.name.endsWith(".md") ? (
          <div className="h-full overflow-auto px-5 py-4 prose prose-invert prose-sm max-w-none
            prose-headings:text-neutral-100 prose-headings:font-semibold
            prose-p:text-neutral-300 prose-p:leading-relaxed
            prose-a:text-blue-400 prose-a:no-underline hover:prose-a:underline
            prose-strong:text-neutral-100
            prose-code:text-emerald-400 prose-code:bg-neutral-800 prose-code:px-1 prose-code:py-0.5 prose-code:rounded prose-code:text-[11px] prose-code:font-mono
            prose-pre:bg-neutral-900 prose-pre:border prose-pre:border-neutral-800 prose-pre:rounded
            prose-blockquote:border-neutral-700 prose-blockquote:text-neutral-400
            prose-li:text-neutral-300
            prose-hr:border-neutral-800
            prose-table:text-neutral-300
            prose-th:text-neutral-200 prose-th:border-neutral-700
            prose-td:border-neutral-800">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>
              {content ?? ""}
            </ReactMarkdown>
          </div>
        ) : (
          <div className="h-full overflow-hidden">
            <CodeMirror
              value={displayContent ?? ""}
              extensions={[...cmBaseExtensions, ...cmLangForFile(file.name)]}
              editable={false}
              basicSetup={{ lineNumbers: true, foldGutter: false, highlightActiveLine: false }}
            />
          </div>
        )}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// FileBrowser
// ---------------------------------------------------------------------------

interface FileBrowserProps {
  workspace: Workspace | null
  selectedFile: WorkspaceFile | null
  savedFilePath: string | null       // path to auto-restore on load
  onSelectFile: (f: WorkspaceFile | null) => void
}

function FileBrowser({ workspace, selectedFile, savedFilePath, onSelectFile }: FileBrowserProps) {
  const [files, setFiles] = useState<WorkspaceFile[]>([])
  const [loading, setLoading] = useState(false)
  const [activeFilter, setActiveFilter] = useState("all")

  const fetchFiles = useCallback(async () => {
    if (!workspace) return
    setLoading(true)
    try {
      const res = await apiFetch(`${API_BASE}/api/workspaces/${workspace.id}/files`)
      if (res.ok) {
        const data = await res.json()
        const loaded: WorkspaceFile[] = data.files ?? []
        setFiles(loaded)
        // Restore previously selected file if it still exists
        if (savedFilePath) {
          const match = loaded.find(f => f.path === savedFilePath)
          if (match) onSelectFile(match)
        }
      }
    } catch { /* ignore */ } finally { setLoading(false) }
  }, [workspace?.id]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    setFiles([])
    setActiveFilter("all")
    onSelectFile(null)
    if (workspace) fetchFiles()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspace?.id])

  if (!workspace) {
    return (
      <div className="flex flex-col h-full">
        <div className="h-8 border-b border-neutral-800 flex items-center px-3 bg-neutral-900 flex-shrink-0">
          <span className="text-[11px] text-neutral-600">No workspace selected</span>
        </div>
        <div className="flex-1 flex items-center justify-center">
          <span className="text-[11px] text-neutral-700">Select a workspace</span>
        </div>
      </div>
    )
  }

  // Derive unique subdirs from file list (dynamic — no hardcoded list)
  const subdirs = Array.from(new Set(files.map(f => f.subdir)))
  const filtered = activeFilter === "all" ? files : files.filter(f => f.subdir === activeFilter)

  // Group by subdir
  const groups = new Map<string, WorkspaceFile[]>()
  filtered.forEach(f => {
    if (!groups.has(f.subdir)) groups.set(f.subdir, [])
    groups.get(f.subdir)!.push(f)
  })

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Header */}
      <div className="flex items-center gap-2 px-3 h-8 border-b border-neutral-800 flex-shrink-0 bg-neutral-900">
        <FolderOpen className="w-3 h-3 text-neutral-600 flex-shrink-0" />
        <span className="text-[12px] font-mono font-medium text-neutral-200 truncate flex-shrink-0">
          {workspace.name}
        </span>
        {/* Dynamic filter pills */}
        <div className="flex items-center gap-1.5 flex-1 overflow-x-auto min-w-0 scrollbar-none">
          {["all", ...subdirs].map(d => (
            <button
              key={d}
              onClick={() => { setActiveFilter(d); onSelectFile(null) }}
              className={`text-[10px] px-2 py-0.5 rounded-full border flex-shrink-0 font-mono transition-colors ${
                activeFilter === d
                  ? "border-orange-500/40 bg-orange-500/10 text-orange-400"
                  : "border-neutral-800 text-neutral-600 hover:text-neutral-400 hover:border-neutral-700"
              }`}
            >
              {d}
            </button>
          ))}
        </div>
        <button
          onClick={fetchFiles}
          className="text-neutral-600 hover:text-neutral-400 transition-colors flex-shrink-0"
          title="Refresh files"
        >
          <RefreshCw className={`w-3 h-3 ${loading ? "animate-spin" : ""}`} />
        </button>
      </div>

      {/* File list */}
      <div className="flex-1 overflow-y-auto py-1">
        {loading && files.length === 0 ? (
          <div className="flex items-center gap-2 px-3 py-3 text-[10px] text-neutral-600">
            <Loader2 className="w-3 h-3 animate-spin" />Loading files…
          </div>
        ) : filtered.length === 0 ? (
          <div className="px-3 py-4 text-[11px] text-neutral-700 text-center">
            {activeFilter === "all" ? "No files in this workspace." : `No files in ${activeFilter}/.`}
          </div>
        ) : (
          Array.from(groups.entries()).map(([dir, dirFiles]) => {
            const color = subdirColor(dir)
            return (
              <div key={dir} className="mb-1">
                {/* Subdir header */}
                <div className="flex items-center gap-1.5 px-3 pt-2 pb-1">
                  <span className="w-1.5 h-1.5 rounded-full flex-shrink-0" style={{ background: color }} />
                  <span className="text-[10px] font-mono font-semibold" style={{ color }}>{dir}/</span>
                  <span className="text-[10px] text-neutral-700">{dirFiles.length}</span>
                </div>
                {/* File rows */}
                {dirFiles.map(f => (
                  <button
                    key={f.path}
                    onClick={() => onSelectFile(selectedFile?.path === f.path ? null : f)}
                    className={`w-full flex items-center gap-2 px-3 pl-6 py-1 text-left border-l-2 transition-colors ${
                      selectedFile?.path === f.path
                        ? "border-orange-500 bg-neutral-900/80 text-white"
                        : "border-transparent hover:bg-neutral-900/40 text-neutral-500 hover:text-neutral-300"
                    }`}
                  >
                    <File className="w-3 h-3 flex-shrink-0 text-neutral-700" />
                    <span className="text-[11px] font-mono flex-1 truncate">{f.name}</span>
                    <span className="text-[10px] text-neutral-700 flex-shrink-0 tabular-nums">{formatSize(f.size)}</span>
                  </button>
                ))}
              </div>
            )
          })
        )}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// WorkspaceTree (left panel)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Context menu
// ---------------------------------------------------------------------------

interface CtxMenuState {
  ws: Workspace
  x: number
  y: number
}

type CtxMenuItem =
  | { type: "item"; Icon: React.ElementType; label: string; action: () => void; danger?: boolean; disabled?: boolean }
  | { type: "separator" }

function WorkspaceCtxMenu({
  ctx, onClose, onNewRun, onNewHunt, onDelete,
}: {
  ctx: CtxMenuState
  onClose: () => void
  onNewRun: (ws: Workspace) => void
  onNewHunt: (ws: Workspace) => void
  onDelete: (ws: Workspace) => void
}) {
  const { ws, x, y } = ctx
  const isWildcard = ws.name.startsWith("*.")

  // Close on outside click or Escape
  useEffect(() => {
    const onDown = () => onClose()
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose() }
    document.addEventListener("click", onDown)
    document.addEventListener("keydown", onKey)
    return () => { document.removeEventListener("click", onDown); document.removeEventListener("keydown", onKey) }
  }, [onClose])

  const MENU_WIDTH = 220
  const ITEM_HEIGHT = 36
  const SEP_HEIGHT = 9
  const PADDING = 8

  const groups: CtxMenuItem[][] = [
    [
      { type: "item", Icon: Play,          label: "New Run",          action: () => onNewRun(ws) },
      { type: "item", Icon: MessageSquare, label: "New Hunt",         action: () => onNewHunt(ws) },
    ],
    [
      { type: "item", Icon: Copy,         label: "Copy name",        action: () => navigator.clipboard.writeText(ws.name).catch(() => {}) },
      { type: "item", Icon: ExternalLink, label: "Open in browser",  action: () => window.open(`https://${ws.name}`, "_blank", "noopener"), disabled: isWildcard },
    ],
    [
      { type: "item", Icon: Trash2, label: "Delete workspace…", action: () => onDelete(ws), danger: true },
    ],
  ]

  const allItems: CtxMenuItem[] = groups.reduce<CtxMenuItem[]>((acc, group, i) => {
    if (i > 0) acc.push({ type: "separator" })
    return acc.concat(group)
  }, [])

  const menuEstimatedHeight = allItems.reduce(
    (h, item) => h + (item.type === "separator" ? SEP_HEIGHT : ITEM_HEIGHT), PADDING * 2
  )

  const spaceBelow = window.innerHeight - y
  const flipUp = spaceBelow < menuEstimatedHeight && y >= menuEstimatedHeight
  const top    = flipUp ? undefined : Math.max(8, Math.min(y, window.innerHeight - menuEstimatedHeight - 8))
  const bottom = flipUp ? window.innerHeight - y : undefined
  const left   = Math.min(x, window.innerWidth - MENU_WIDTH - 8)

  return (
    <div
      className="fixed z-50 bg-neutral-800 border border-neutral-700 rounded-lg shadow-2xl py-1 min-w-[220px]"
      style={{ top, bottom, left }}
      onClick={e => e.stopPropagation()}
      onContextMenu={e => e.preventDefault()}
    >
      {allItems.map((item, i) =>
        item.type === "separator" ? (
          <div key={`sep-${i}`} className="my-1 border-t border-neutral-700" />
        ) : (
          <button
            key={item.label}
            onClick={() => { if (!item.disabled) { onClose(); item.action() } }}
            disabled={item.disabled}
            className={`w-full text-left px-3 py-2 flex items-center gap-3 transition-colors text-sm disabled:opacity-35 disabled:cursor-default ${
              item.danger
                ? "text-neutral-400 hover:text-red-400 hover:bg-red-500/10"
                : "text-neutral-400 hover:text-white hover:bg-neutral-700"
            }`}
          >
            <item.Icon className="w-4 h-4 flex-shrink-0" />
            <span className="font-medium">{item.label}</span>
          </button>
        )
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// WorkspaceTree (left panel)
// ---------------------------------------------------------------------------

interface WorkspaceTreeProps {
  nodes: TreeNode[]
  selectedId: string | null
  expandedIds: Set<string>
  onSelect: (ws: Workspace) => void
  onToggleExpand: (id: string) => void
  onNewRun: (ws: Workspace) => void
  onNewHunt: (ws: Workspace) => void
  onDelete: (id: string) => void
}

function WorkspaceTree({
  nodes, selectedId, expandedIds, onSelect, onToggleExpand,
  onNewRun, onNewHunt, onDelete,
}: WorkspaceTreeProps) {
  const [ctx, setCtx] = useState<CtxMenuState | null>(null)
  const [deletingId, setDeletingId] = useState<string | null>(null)

  const handleDelete = async (ws: Workspace) => {
    if (!confirm(`Delete workspace "${ws.name}" and all its files?`)) return
    setDeletingId(ws.id)
    try {
      await apiFetch(`${API_BASE}/api/workspaces/${ws.id}`, { method: "DELETE" })
      onDelete(ws.id)
    } catch { /* ignore */ } finally { setDeletingId(null) }
  }

  return (
    <>
      {ctx && (
        <WorkspaceCtxMenu
          ctx={ctx}
          onClose={() => setCtx(null)}
          onNewRun={onNewRun}
          onNewHunt={onNewHunt}
          onDelete={ws => { setCtx(null); handleDelete(ws) }}
        />
      )}
      {nodes.map(node => {
        const { ws, children, depth } = node
        const isSelected = ws.id === selectedId
        const isExpanded = expandedIds.has(ws.id)
        const hasChildren = children.length > 0
        // Show only the leaf segment for child nodes
        const displayName = depth > 0 ? ws.name.split("/").pop()! : ws.name
        const indent = depth * 14

        return (
          <div key={ws.id}>
            <div
              onClick={() => onSelect(ws)}
              onContextMenu={e => {
                e.preventDefault()
                e.stopPropagation()
                onSelect(ws)
                setCtx({ ws, x: e.clientX, y: e.clientY })
              }}
              className={`flex items-center gap-1.5 h-7 pr-2 cursor-pointer border-l-2 transition-colors ${
                isSelected
                  ? "border-orange-500 bg-neutral-900/80"
                  : "border-transparent hover:bg-neutral-900/40"
              } ${deletingId === ws.id ? "opacity-40 pointer-events-none" : ""}`}
              style={{ paddingLeft: `${8 + indent}px` }}
            >
              {/* Chevron */}
              {hasChildren ? (
                <button
                  onClick={e => { e.stopPropagation(); onToggleExpand(ws.id) }}
                  className="w-3.5 h-3.5 flex items-center justify-center text-neutral-600 hover:text-neutral-400 flex-shrink-0 rounded"
                >
                  {isExpanded
                    ? <ChevronDown className="w-3 h-3" />
                    : <ChevronRight className="w-3 h-3" />
                  }
                </button>
              ) : (
                <span className="w-3.5 flex-shrink-0" />
              )}

              {/* Folder icon */}
              <span className="flex-shrink-0 text-neutral-600">
                {hasChildren && isExpanded
                  ? <FolderOpen className="w-3.5 h-3.5" />
                  : <FolderClosed className="w-3.5 h-3.5" />
                }
              </span>

              {/* Name */}
              <span className={`text-[12px] font-mono flex-1 truncate ${isSelected ? "text-white" : "text-neutral-400 hover:text-neutral-200"}`}>
                {displayName}
              </span>
            </div>

            {/* Render children if expanded */}
            {hasChildren && isExpanded && (
              <WorkspaceTree
                nodes={children}
                selectedId={selectedId}
                expandedIds={expandedIds}
                onSelect={onSelect}
                onToggleExpand={onToggleExpand}
                onNewRun={onNewRun}
                onNewHunt={onNewHunt}
                onDelete={onDelete}
              />
            )}
          </div>
        )
      })}
    </>
  )
}

// ---------------------------------------------------------------------------
// Main page
// ---------------------------------------------------------------------------

export default function WorkspacesPage() {
  const { activeProjectId } = useProject()
  const router = useRouter()

  const [workspaces, setWorkspaces] = useState<Workspace[]>([])
  const [loading, setLoading] = useState(false)
  const [selectedWs, setSelectedWs] = useState<Workspace | null>(null)
  const [selectedFile, setSelectedFile] = useState<WorkspaceFile | null>(null)
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set())

  // Persist selected workspace + file across page navigations.
  // Each workspace stores its own last-opened file under a per-workspace key,
  // so switching workspaces and returning restores the correct file.
  const selectWorkspace = useCallback((ws: Workspace | null) => {
    setSelectedWs(ws)
    setSelectedFile(null)
    if (ws) localStorage.setItem(SELECTED_WS_KEY, ws.id)
    else localStorage.removeItem(SELECTED_WS_KEY)
    // Do NOT clear the per-workspace file key — each workspace keeps its own
  }, [])

  const selectFile = useCallback((file: WorkspaceFile | null, wsId?: string) => {
    setSelectedFile(file)
    if (wsId) {
      if (file) localStorage.setItem(wsFileKey(wsId), file.path)
      else localStorage.removeItem(wsFileKey(wsId))
    }
  }, [])
  const [showNewRunModal, setShowNewRunModal] = useState(false)
  const [showNewHuntModal, setShowNewHuntModal] = useState(false)
  const [targetWorkspace, setTargetWorkspace] = useState<Workspace | null>(null)

  // Resizable left panel
  const [listWidth, setListWidth] = useState(() => {
    if (typeof window !== "undefined") {
      const saved = localStorage.getItem(LIST_WIDTH_KEY)
      return saved ? parseInt(saved, 10) : DEFAULT_LIST_WIDTH
    }
    return DEFAULT_LIST_WIDTH
  })
  const draggingRef = useRef(false)
  const startXRef   = useRef(0)
  const startWRef   = useRef(0)

  // Resizable file browser height (as % of right panel)
  const [browserHeightPct, setBrowserHeightPct] = useState(40)
  const draggingVRef = useRef(false)
  const startYRef    = useRef(0)
  const startPctRef  = useRef(40)
  const rightPanelRef = useRef<HTMLDivElement>(null)

  const fetchWorkspaces = useCallback(async () => {
    if (!activeProjectId) return
    setLoading(true)
    try {
      const res = await apiFetch(`${API_BASE}/api/workspaces?project_id=${activeProjectId}`)
      if (res.ok) {
        const data = await res.json()
        const list: Workspace[] = Array.isArray(data) ? data : []
        setWorkspaces(list)
        // Auto-expand any workspace that has children (via parent_id or path-prefix)
        const toExpand = new Set<string>()
        list.forEach(ws => {
          list.forEach(candidate => {
            if (candidate.id === ws.id) return
            // parent_id relationship
            if (candidate.parent_id === ws.id) { toExpand.add(ws.id); return }
            // path-prefix relationship
            if (candidate.name.startsWith(ws.name + "/")) { toExpand.add(ws.id) }
          })
        })
        setExpandedIds(toExpand)
        // Restore previously selected workspace
        const savedWsId = localStorage.getItem(SELECTED_WS_KEY)
        if (savedWsId) {
          const restored = list.find(w => w.id === savedWsId)
          if (restored) setSelectedWs(restored)
        }
        // Note: selected file is restored by FileBrowser once it loads the file list
      }
    } catch { /* ignore */ } finally { setLoading(false) }
  }, [activeProjectId])

  useEffect(() => { fetchWorkspaces() }, [fetchWorkspaces])

  // Horizontal resize
  const onResizeMouseDown = (e: React.MouseEvent) => {
    draggingRef.current = true
    startXRef.current   = e.clientX
    startWRef.current   = listWidth
    e.preventDefault()
  }
  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (!draggingRef.current) return
      const w = Math.min(MAX_LIST_WIDTH, Math.max(MIN_LIST_WIDTH, startWRef.current + e.clientX - startXRef.current))
      setListWidth(w)
    }
    const onUp = () => {
      if (!draggingRef.current) return
      draggingRef.current = false
      localStorage.setItem(LIST_WIDTH_KEY, String(listWidth))
    }
    window.addEventListener("mousemove", onMove)
    window.addEventListener("mouseup", onUp)
    return () => { window.removeEventListener("mousemove", onMove); window.removeEventListener("mouseup", onUp) }
  }, [listWidth])

  // Vertical resize
  const onVResizeMouseDown = (e: React.MouseEvent) => {
    draggingVRef.current = true
    startYRef.current    = e.clientY
    startPctRef.current  = browserHeightPct
    e.preventDefault()
  }
  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (!draggingVRef.current || !rightPanelRef.current) return
      const panelH = rightPanelRef.current.offsetHeight
      const delta  = e.clientY - startYRef.current
      const newPct = Math.min(80, Math.max(15, startPctRef.current + (delta / panelH) * 100))
      setBrowserHeightPct(newPct)
    }
    const onUp = () => { draggingVRef.current = false }
    window.addEventListener("mousemove", onMove)
    window.addEventListener("mouseup", onUp)
    return () => { window.removeEventListener("mousemove", onMove); window.removeEventListener("mouseup", onUp) }
  }, [])

  const handleDelete = (id: string) => {
    setWorkspaces(prev => prev.filter(w => w.id !== id))
    if (selectedWs?.id === id) { selectWorkspace(null) }
  }

  const handleToggleExpand = (id: string) => {
    setExpandedIds(prev => {
      const next = new Set(prev)
      next.has(id) ? next.delete(id) : next.add(id)
      return next
    })
  }

  const handleNewRun = (ws: Workspace) => { setTargetWorkspace(ws); setShowNewRunModal(true) }
  const handleNewHunt = (ws: Workspace) => { setTargetWorkspace(ws); setShowNewHuntModal(true) }

  const handleRunCreated = (_run: { id: string }) => {
    setShowNewRunModal(false); setTargetWorkspace(null); router.push("/runs")
  }
  const handleHuntCreated = (session: { id: string }) => {
    setShowNewHuntModal(false); setTargetWorkspace(null); router.push(`/hunts?session=${session.id}`)
  }

  const tree = buildTree(workspaces)

  const totalRuns  = workspaces.reduce((a, w) => a + w.run_count, 0)
  const totalHunts = workspaces.reduce((a, w) => a + w.hunt_count, 0)
  const totalFilesCount = workspaces.reduce((a, w) => a + totalFiles(w), 0)

  return (
    <div className="flex h-full overflow-hidden bg-neutral-950">

      {/* ── LEFT PANEL: Workspace tree ──────────────────────────────────── */}
      <div
        className="flex flex-col border-r border-neutral-800 bg-neutral-900 flex-shrink-0 overflow-hidden"
        style={{ width: listWidth }}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-2 h-8 border-b border-neutral-800 flex-shrink-0 gap-2">
          <span className="text-[11px] font-semibold text-neutral-500 uppercase tracking-wider flex-1">
            Workspaces
          </span>
          <button
            onClick={fetchWorkspaces}
            className="text-neutral-600 hover:text-neutral-400 transition-colors"
            title="Refresh"
          >
            <RefreshCw className={`w-3 h-3 ${loading ? "animate-spin" : ""}`} />
          </button>
          <button
            onClick={() => { setTargetWorkspace(null); setShowNewRunModal(true) }}
            className="flex items-center gap-1 text-[10px] text-neutral-500 hover:text-neutral-300 border border-neutral-800 hover:border-neutral-600 px-1.5 py-0.5 rounded transition-colors"
          >
            <Plus className="w-2.5 h-2.5" />New
          </button>
        </div>

        {/* Summary */}
        {workspaces.length > 0 && (
          <div className="flex items-center gap-3 px-3 py-1 border-b border-neutral-800/60 flex-shrink-0">
            <span className="text-[10px] text-neutral-600">
              <span className="text-neutral-400">{workspaces.length}</span> ws
            </span>
            <span className="text-[10px] text-neutral-600">
              <span className="text-neutral-400">{totalRuns}</span> runs
            </span>
            <span className="text-[10px] text-neutral-600">
              <span className="text-neutral-400">{totalHunts}</span> hunts
            </span>
            <span className="text-[10px] text-neutral-600">
              <span className="text-neutral-400">{totalFilesCount}</span> files
            </span>
          </div>
        )}

        {/* Tree */}
        <div className="flex-1 overflow-y-auto py-1">
          {loading && workspaces.length === 0 && (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="w-4 h-4 animate-spin text-neutral-700" />
            </div>
          )}
          {!loading && workspaces.length === 0 && (
            <div className="flex flex-col items-center justify-center py-10 px-4 text-center gap-2">
              <FolderOpen className="w-8 h-8 text-neutral-800" />
              <p className="text-[11px] text-neutral-600">No workspaces yet</p>
              <button
                onClick={() => setShowNewRunModal(true)}
                className="text-[10px] text-orange-500 hover:text-orange-400 border border-orange-500/30 px-2 py-1 rounded transition-colors"
              >
                Start a Run
              </button>
            </div>
          )}
          <WorkspaceTree
            nodes={tree}
            selectedId={selectedWs?.id ?? null}
            expandedIds={expandedIds}

            onSelect={selectWorkspace}
            onToggleExpand={handleToggleExpand}
            onNewRun={handleNewRun}
            onNewHunt={handleNewHunt}
            onDelete={handleDelete}
          />
        </div>
      </div>

      {/* ── RESIZE HANDLE ──────────────────────────────────────────────── */}
      <div
        onMouseDown={onResizeMouseDown}
        className="w-1 bg-neutral-800 hover:bg-orange-500/60 cursor-col-resize flex-shrink-0 transition-colors"
      />

      {/* ── RIGHT PANEL: File browser + viewer ─────────────────────────── */}
      <div ref={rightPanelRef} className="flex-1 flex flex-col overflow-hidden min-w-0">

        {/* File browser */}
        <div style={{ height: `${browserHeightPct}%` }} className="overflow-hidden flex-shrink-0">
          <FileBrowser
            workspace={selectedWs}
            selectedFile={selectedFile}
            savedFilePath={selectedWs && typeof window !== "undefined" ? localStorage.getItem(wsFileKey(selectedWs.id)) : null}
            onSelectFile={(file) => selectFile(file, selectedWs?.id)}
          />
        </div>

        {/* Vertical resize handle */}
        <div
          onMouseDown={onVResizeMouseDown}
          className="h-1 bg-neutral-800 hover:bg-orange-500/60 cursor-row-resize flex-shrink-0 transition-colors"
        />

        {/* File viewer */}
        <div className="flex-1 overflow-hidden">
          {selectedFile && selectedWs ? (
            <FileViewer
              workspaceId={selectedWs.id}
              file={selectedFile}
              onClose={() => selectFile(null, selectedWs.id)}
            />
          ) : (
            <div className="flex flex-col h-full">
              <div className="h-8 border-b border-neutral-800 flex items-center px-3 bg-neutral-900 flex-shrink-0" />
              <div className="flex-1 flex flex-col items-center justify-center gap-3 bg-neutral-950">
                <File className="w-9 h-9 text-neutral-800" />
                <span className="text-[12px] text-neutral-600">Select a file to view its contents</span>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* ── Modals ─────────────────────────────────────────────────────── */}
      {showNewRunModal && (
        <NewRunModal
          activeProjectId={activeProjectId}
          onClose={() => { setShowNewRunModal(false); setTargetWorkspace(null) }}
          onCreated={handleRunCreated}
          initialWorkspaceId={targetWorkspace?.id}
          initialTargetUrl={targetWorkspace?.name ?? ""}
        />
      )}
      {showNewHuntModal && (
        <NewChatModal
          activeProjectId={activeProjectId}
          onClose={() => { setShowNewHuntModal(false); setTargetWorkspace(null) }}
          onCreated={handleHuntCreated}
          initialName={targetWorkspace?.name ?? ""}
        />
      )}
    </div>
  )
}
