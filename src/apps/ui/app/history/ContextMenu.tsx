"use client"

import React from "react"
import { useRouter } from "next/navigation"
import {
  Eye, Maximize2, MessageSquare, Zap, Terminal, Code2, Link,
  Filter, Highlighter, X, Ban, RefreshCw,
} from "lucide-react"
import { apiFetch } from "@/lib/api-fetch"
import { type ApiRequest } from "./DetailPanel"
import { upsertToken } from "./upsertToken"

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000"

export interface ContextMenuState {
  x: number
  y: number
  req: ApiRequest
}

interface ContextMenuProps {
  contextMenu: ContextMenuState
  onClose: () => void
  onToggleExpanded: (id: string) => void
  onMaximize: (id: string) => void
  onHighlight: (id: string) => void
  isHighlighted: boolean
  onFilterQuery: (updater: (q: string) => string) => void
}

type MenuItem =
  | { type: "item"; Icon: React.ElementType; label: string; action: () => void; danger?: boolean }
  | { type: "separator" }

export function ContextMenu({
  contextMenu,
  onClose,
  onToggleExpanded,
  onMaximize,
  onHighlight,
  isHighlighted,
  onFilterQuery,
}: ContextMenuProps) {
  const router = useRouter()
  const req = contextMenu.req

  const buildRawRequest = (r: ApiRequest) => {
    const hdrs = r.headers ?? {}
    const headerLines = Object.entries(hdrs)
      .filter(([k]) => k.toLowerCase() !== "host")
      .map(([k, v]) => `${k}: ${v}`)
      .join("\n")
    return [
      `${r.method} ${r.url} HTTP/1.1`,
      `Host: ${r.host}`,
      ...(headerLines ? [headerLines] : []),
      "",
      r.body ?? "",
    ].join("\n")
  }

  const sendToGnaw = async (r: ApiRequest) => {
    const res = await apiFetch(`${API_BASE}/api/gnaw/tabs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ raw_request: buildRawRequest(r), label: `${r.method} ${r.host}` }),
    }).catch(() => null)
    if (res?.ok) { const tab = await res.json(); router.push(`/gnaw?tab=${tab.id}`) }
    else router.push("/gnaw")
  }

  const groups: MenuItem[][] = [
    // Group 1 — Inspect
    [
      {
        type: "item",
        Icon: Eye,
        label: "View Details",
        action: () => { onToggleExpanded(req.id); onClose() },
      },
      {
        type: "item",
        Icon: Maximize2,
        label: "Open Maximized",
        action: () => { onMaximize(req.id); onClose() },
      },
    ],
    // Group 2 — Send / Replay
    [
      {
        type: "item",
        Icon: RefreshCw,
        label: "Send to Gnaw",
        action: async () => { await sendToGnaw(req); onClose() },
      },
      {
        type: "item",
        Icon: MessageSquare,
        label: "Send to Chat",
        action: () => { router.push(`/chat?requestId=${req.id}&method=${req.method}&url=${encodeURIComponent(req.url)}`); onClose() },
      },
      {
        type: "item",
        Icon: Zap,
        label: "Send to Snare",
        action: () => { router.push(`/snare?url=${encodeURIComponent(req.url)}&method=${req.method}`); onClose() },
      },
    ],
    // Group 3 — Copy
    [
      {
        type: "item",
        Icon: Link,
        label: "Copy URL",
        action: () => { navigator.clipboard.writeText(req.url).catch(() => {}); onClose() },
      },
      {
        type: "item",
        Icon: Terminal,
        label: "Copy as cURL",
        action: () => {
          const headers = Object.entries(req.headers ?? {}).map(([k, v]) => `-H '${k}: ${v}'`).join(" ")
          const body = req.body ? `--data '${req.body}'` : ""
          navigator.clipboard.writeText(`curl -X ${req.method} '${req.url}' ${headers} ${body}`.trim()).catch(() => {})
          onClose()
        },
      },
      {
        type: "item",
        Icon: Code2,
        label: "Copy as Python (httpx)",
        action: () => {
          const headers = JSON.stringify(req.headers ?? {})
          const body = req.body ? `, content=b'${req.body}'` : ""
          navigator.clipboard.writeText(`httpx.request('${req.method}', '${req.url}', headers=${headers}${body})`).catch(() => {})
          onClose()
        },
      },
    ],
    // Group 4 — Filter / Highlight
    [
      {
        type: "item",
        Icon: Filter,
        label: `Filter by Host: ${req.host}`,
        action: () => { onFilterQuery(q => upsertToken(q, "host", req.host)); onClose() },
      },
      {
        type: "item",
        Icon: Ban,
        label: `Exclude Domain: ${req.host}`,
        action: () => { onFilterQuery(q => upsertToken(q, "host", req.host, true)); onClose() },
      },
      {
        type: "item",
        Icon: Ban,
        label: `Exclude Domain + Path: ${req.host}${req.path}`,
        action: () => {
          onFilterQuery(q => {
            const withHost = upsertToken(q, "host", req.host, true)
            return upsertToken(withHost, "path", req.path, true)
          })
          onClose()
        },
      },
      {
        type: "item",
        Icon: isHighlighted ? X : Highlighter,
        label: isHighlighted ? "Remove Highlight" : "Highlight Row",
        action: () => { onHighlight(req.id); onClose() },
      },
    ],
  ]

  const allItems: MenuItem[] = groups.reduce<MenuItem[]>((acc, group, i) => {
    if (i > 0) acc.push({ type: "separator" })
    return acc.concat(group)
  }, [])

  const MENU_WIDTH = 280
  const ITEM_HEIGHT = 36
  const SEPARATOR_HEIGHT = 9
  const PADDING = 8
  const menuEstimatedHeight = allItems.reduce((h, item) =>
    h + (item.type === "separator" ? SEPARATOR_HEIGHT : ITEM_HEIGHT), PADDING * 2)

  const spaceBelow = window.innerHeight - contextMenu.y
  const spaceAbove = contextMenu.y
  const flipUp = spaceBelow < menuEstimatedHeight && spaceAbove >= menuEstimatedHeight

  let top: number | undefined
  let bottom: number | undefined
  if (flipUp) {
    bottom = window.innerHeight - contextMenu.y
  } else {
    top = Math.min(contextMenu.y, window.innerHeight - menuEstimatedHeight - 8)
    top = Math.max(top, 8)
  }
  const left = Math.min(contextMenu.x, window.innerWidth - MENU_WIDTH - 8)

  return (
    <div
      className="fixed z-50 bg-neutral-800 border border-neutral-700 rounded-lg shadow-2xl py-1 min-w-[220px]"
      style={{ top, bottom, left }}
      onClick={(e) => e.stopPropagation()}
    >
      {allItems.map((item, i) =>
        item.type === "separator" ? (
          <div key={`sep-${i}`} className="my-1 border-t border-neutral-700" />
        ) : (
          <button
            key={item.label}
            onClick={item.action}
            className="w-full text-left px-3 py-2 flex items-center gap-3 text-neutral-400 hover:text-white hover:bg-neutral-700 transition-colors text-sm"
          >
            <item.Icon className="w-4 h-4 flex-shrink-0" />
            <span className="font-medium">{item.label}</span>
          </button>
        )
      )}
    </div>
  )
}
