"use client"

import React, { useEffect, useState, useCallback, useRef } from "react"
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet"
import { Badge } from "@/components/ui/badge"
import { ExternalLink, RefreshCw } from "lucide-react"

// ─── Types ────────────────────────────────────────────────────────────────────

export type SigintItemType = "release" | "security" | "feature" | "tip" | "news"

export interface SigintItem {
  id: string
  type: SigintItemType
  title: string
  body: string
  url?: string
  date: string
}

interface SigintFeed {
  items: SigintItem[]
}

// ─── Feed URL ─────────────────────────────────────────────────────────────────
// Defaults to the live endpoint. Override via NEXT_PUBLIC_SIGINT_URL build arg if needed.
const SIGINT_API_URL =
  process.env.NEXT_PUBLIC_SIGINT_URL ?? "https://synlace.ai/ferret/news.json"

const MOCK_FEED: SigintFeed = {
  items: [
    {
      id: "2026-05-14-v1.0",
      type: "release",
      title: "Ferret v1.0 released",
      body: "Initial public release. MITM proxy, Gnaw, Workspaces, and AI-powered Findings are live.",
      url: "https://synlace.ai/ferret/changelog",
      date: "2026-05-14",
    },
    {
      id: "2026-05-13-cert-tip",
      type: "tip",
      title: "Install the CA certificate",
      body: "For full HTTPS interception, install the Ferret CA cert in your browser's trust store. See docs for instructions.",
      url: "https://synlace.ai/ferret/docs/ca-cert",
      date: "2026-05-13",
    },
    {
      id: "2026-05-12-security-note",
      type: "security",
      title: "Bind proxy to loopback only",
      body: "Ensure your proxy listen address is 127.0.0.1 and not 0.0.0.0 unless you intend to expose it on your network.",
      date: "2026-05-12",
    },
  ],
}

async function fetchSigintFeed(): Promise<SigintFeed> {
  if (!SIGINT_API_URL) return MOCK_FEED
  try {
    const res = await fetch(SIGINT_API_URL, { cache: "no-store" })
    if (!res.ok) return MOCK_FEED
    return (await res.json()) as SigintFeed
  } catch {
    return MOCK_FEED
  }
}

// ─── localStorage helpers ─────────────────────────────────────────────────────

const STORAGE_KEY = "ferret:sigint:read"

function getReadIds(): Set<string> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    return new Set(raw ? (JSON.parse(raw) as string[]) : [])
  } catch {
    return new Set()
  }
}

function saveReadIds(ids: Set<string>) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify([...ids]))
  } catch {
    // ignore
  }
}

// ─── Type badge colours ───────────────────────────────────────────────────────

const TYPE_STYLES: Record<SigintItemType, string> = {
  release:  "bg-green-500/20 text-green-400 border-green-500/30",
  security: "bg-red-500/20 text-red-400 border-red-500/30",
  feature:  "bg-blue-500/20 text-blue-400 border-blue-500/30",
  news:     "bg-blue-500/20 text-blue-400 border-blue-500/30",
  tip:      "bg-purple-500/20 text-purple-400 border-purple-500/30",
}

// ─── Hook ─────────────────────────────────────────────────────────────────────

const POLL_INTERVAL_MS = 30 * 60 * 1000 // 30 minutes

export function useSigint() {
  const [items, setItems] = useState<SigintItem[]>([])
  const [readIds, setReadIds] = useState<Set<string>>(new Set())

  const [refreshing, setRefreshing] = useState(false)
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const doFetch = useCallback(() => {
    setRefreshing(true)
    fetchSigintFeed()
      .then(feed => setItems(feed.items))
      .finally(() => setRefreshing(false))
  }, [])

  useEffect(() => {
    setReadIds(getReadIds())
    doFetch()

    intervalRef.current = setInterval(doFetch, POLL_INTERVAL_MS)
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current)
    }
  }, [doFetch])

  const refresh = useCallback(() => {
    // Reset the interval so the next auto-poll is 30 min from now
    if (intervalRef.current) clearInterval(intervalRef.current)
    doFetch()
    intervalRef.current = setInterval(doFetch, POLL_INTERVAL_MS)
  }, [doFetch])

  const unreadCount = items.filter(i => !readIds.has(i.id)).length

  const markAllRead = useCallback(() => {
    const all = new Set(items.map(i => i.id))
    setReadIds(all)
    saveReadIds(all)
  }, [items])

  const markRead = useCallback((id: string) => {
    setReadIds(prev => {
      const next = new Set(prev)
      next.add(id)
      saveReadIds(next)
      return next
    })
  }, [])

  return { items, readIds, unreadCount, markAllRead, markRead, refresh, refreshing }
}

// ─── Panel component ──────────────────────────────────────────────────────────

interface SigintPanelProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  items: SigintItem[]
  readIds: Set<string>
  onMarkAllRead: () => void
  onMarkRead: (id: string) => void
  onRefresh: () => void
  refreshing?: boolean
}

export default function SigintPanel({
  open,
  onOpenChange,
  items,
  readIds,
  onMarkAllRead,
  onMarkRead,
  onRefresh,
  refreshing = false,
}: SigintPanelProps) {
  // Mark all read when panel opens
  useEffect(() => {
    if (open) onMarkAllRead()
  }, [open, onMarkAllRead])

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        className="w-[360px] bg-neutral-900 border-l border-neutral-800 text-white p-0 flex flex-col"
      >
        {/* Refresh button — sits to the left of the Shadcn close (X) button which is absolute right-4 top-4 */}
        <button
          onClick={onRefresh}
          disabled={refreshing}
          aria-label="Refresh news feed"
          className="absolute right-10 top-4 text-neutral-500 hover:text-neutral-300 disabled:opacity-40 transition-colors z-10"
        >
          <RefreshCw className={`w-3.5 h-3.5 ${refreshing ? "animate-spin" : ""}`} />
        </button>

        {/* Header */}
        <SheetHeader className="px-4 py-3 border-b border-neutral-800 flex-shrink-0">
          <SheetTitle className="text-brand-500 font-bold text-sm tracking-wider">
            LATEST NEWS
          </SheetTitle>
        </SheetHeader>

        {/* Feed */}
        <div className="flex-1 overflow-y-auto">
          {items.length === 0 ? (
            <div className="px-4 py-8 text-center text-neutral-600 text-xs">
              NO SIGNALS RECEIVED
            </div>
          ) : (
            items.map(item => {
              const isRead = readIds.has(item.id)
              return (
                <div
                  key={item.id}
                  className="px-4 py-3 border-b border-neutral-800/60 transition-colors"
                >
                  {/* Top row: type badge + date */}
                  <div className="flex items-center justify-between mb-1.5">
                    <span
                      className={`text-[9px] font-bold tracking-widest uppercase px-1.5 py-0.5 rounded border ${
                        TYPE_STYLES[item.type]
                      }`}
                    >
                      {item.type}
                    </span>
                    <span className="text-[10px] text-neutral-400">{item.date}</span>
                  </div>

                  {/* Title — linked if url provided */}
                  <p className={`text-xs font-semibold mb-1 ${isRead ? "text-neutral-400" : "text-white"}`}>
                    {!isRead && (
                      <span className="inline-block w-1.5 h-1.5 rounded-full bg-brand-500 mr-1.5 mb-0.5 align-middle" />
                    )}
                    {item.url ? (
                      <a
                        href={item.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        onClick={() => onMarkRead(item.id)}
                        className="inline-flex items-center gap-1 hover:text-brand-400 transition-colors"
                      >
                        {item.title}
                        <ExternalLink className="w-2.5 h-2.5 shrink-0 opacity-60" />
                      </a>
                    ) : (
                      item.title
                    )}
                  </p>

                  {/* Body */}
                  <p className={`text-[11px] leading-relaxed ${isRead ? "text-neutral-500" : "text-neutral-300"}`}>{item.body}</p>
                </div>
              )
            })
          )}
        </div>

        {/* Footer */}
        <div className="px-4 py-2 border-t border-neutral-800 flex-shrink-0">
          <a
            href="https://synlace.ai"
            target="_blank"
            rel="noopener noreferrer"
            className="block text-[9px] text-neutral-600 hover:text-neutral-400 text-center tracking-wider transition-colors"
          >
            A SYNLACE PRODUCT
          </a>
        </div>
      </SheetContent>
    </Sheet>
  )
}
