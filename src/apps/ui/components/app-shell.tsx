"use client"

import React, { useState, useEffect, useRef, useCallback } from "react"
import Link from "next/link"
import Image from "next/image"
import { usePathname, useRouter } from "next/navigation"
import {
  Globe,
  Shield,
  LayoutDashboard,
  Zap,
  RefreshCw,
  FolderOpen,
  SlidersHorizontal,
  ChevronRight,
  Target,
  Radio,
  ExternalLink,
} from "lucide-react"
import ProjectSwitcher from "@/components/project-switcher"
import ProjectSheet from "@/components/project-sheet"
import SigintPanel, { useSigint } from "@/components/sigint-panel"

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000"

const MIN_WIDTH = 48   // collapsed icon-only width
const MAX_WIDTH = 320
const DEFAULT_WIDTH = 208 // w-52

interface ProxyStatus {
  running: boolean
  uptime: number
  listen_address: string
  intercepted: number
}

const navItems = [
  { href: "/history",    icon: Globe,             label: "History" },
  { href: "/snare",      icon: Zap,               label: "Snare" },
  { href: "/gnaw",       icon: RefreshCw,         label: "Gnaw" },
  { href: "/pounce",     icon: Target,            label: "Pounce" },
  { href: "/workspaces", icon: LayoutDashboard,   label: "Workspaces" },
  { href: "/findings",   icon: Shield,            label: "Findings" },
  { href: "/projects",   icon: FolderOpen,        label: "Projects" },
  { href: "/settings",   icon: SlidersHorizontal, label: "Settings" },
]

const STORAGE_KEY = "ferret:sidebarWidth"

export default function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname()
  const router   = useRouter()

  // State is only used for drag logic / collapsed detection.
  // The visual width is driven by the CSS custom property --sidebar-w which is
  // set synchronously by the blocking script in layout.tsx before first paint,
  // so there is never a flash on reload.
  const [sidebarWidth, setSidebarWidth] = useState(DEFAULT_WIDTH)
  const [proxyStatus, setProxyStatus] = useState<ProxyStatus | null>(null)
  const [projectOpen, setProjectOpen] = useState(false)
  const [sigintOpen, setSigintOpen] = useState(false)
  const { items: sigintItems, readIds, unreadCount, markAllRead, markRead, refresh: refreshSigint, refreshing: sigintRefreshing } = useSigint()
  const dragging = useRef(false)
  const asideRef = useRef<HTMLElement>(null)

  // On mount, sync React state from the CSS var (already set by the blocking script).
  useEffect(() => {
    const cssVal = getComputedStyle(document.documentElement)
      .getPropertyValue("--sidebar-w").trim()
    const parsed = parseInt(cssVal, 10)
    if (!isNaN(parsed)) setSidebarWidth(Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, parsed)))
  }, [])

  // First-run check: redirect to /setup if the wizard has not been completed.
  // Skipped when already on /setup to avoid redirect loops.
  useEffect(() => {
    if (pathname === "/setup") return
    const check = async () => {
      try {
        const res = await fetch(`${API_BASE}/api/setup`)
        if (!res.ok) return  // API not ready yet — don't block the UI
        const data = await res.json()
        if (!data.setup_complete) {
          router.replace("/setup")
        }
      } catch {
        // Backend unreachable on first load — don't block the UI
      }
    }
    check()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pathname])

  // Proxy status polling — must be declared before any early return to satisfy
  // the Rules of Hooks (hooks must always be called in the same order).
  useEffect(() => {
    if (pathname === "/setup") return
    const fetchStatus = async () => {
      try {
        const res = await fetch(`${API_BASE}/api/proxy/status`)
        if (res.ok) setProxyStatus(await res.json())
      } catch {
        // silently ignore — sidebar is non-critical
      }
    }
    fetchStatus()
    const id = setInterval(fetchStatus, 5000)
    return () => clearInterval(id)
  }, [pathname])

  const collapsed = sidebarWidth <= MIN_WIDTH + 8

  const onDragStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    dragging.current = true
    // Disable transition during drag for instant feedback
    asideRef.current?.classList.remove("transition-[width]", "duration-200")
    document.body.style.cursor = "col-resize"
    document.body.style.userSelect = "none"

    const onMove = (ev: MouseEvent) => {
      if (!dragging.current) return
      const w = Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, ev.clientX))
      setSidebarWidth(w)
      document.documentElement.style.setProperty("--sidebar-w", `${w}px`)
    }
    const onUp = (ev: MouseEvent) => {
      dragging.current = false
      document.body.style.cursor = ""
      document.body.style.userSelect = ""
      window.removeEventListener("mousemove", onMove)
      window.removeEventListener("mouseup", onUp)
      // Persist final width after drag ends
      const w = Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, ev.clientX))
      localStorage.setItem(STORAGE_KEY, String(w))
      // Re-enable transition after drag
      asideRef.current?.classList.add("transition-[width]", "duration-200")
    }
    window.addEventListener("mousemove", onMove)
    window.addEventListener("mouseup", onUp)
  }, [])

  const toggleCollapse = () => {
    setSidebarWidth(w => {
      const next = w <= MIN_WIDTH + 8 ? DEFAULT_WIDTH : MIN_WIDTH
      localStorage.setItem(STORAGE_KEY, String(next))
      document.documentElement.style.setProperty("--sidebar-w", `${next}px`)
      return next
    })
  }

  // If we are on the setup page, render children directly (no sidebar).
  // This early return must come AFTER all hooks/callbacks to satisfy the Rules of Hooks.
  if (pathname === "/setup") {
    return <>{children}</>
  }

  return (
    <div className="flex h-screen overflow-hidden">
      {/* Sidebar — width driven by CSS var set before paint; suppressHydrationWarning avoids
          mismatch between server-rendered DEFAULT_WIDTH and the client CSS var value */}
      <aside
        ref={asideRef}
        suppressHydrationWarning
        style={{ width: "var(--sidebar-w, 208px)" }}
        className="flex-shrink-0 bg-neutral-900 border-r border-neutral-800 flex flex-col overflow-hidden transition-[width] duration-200"
      >
        {/* Header — single layout; text fades in after the width transition completes */}
        <div className="flex items-center justify-between px-3 py-2.5 border-b border-neutral-800 flex-shrink-0 overflow-hidden">
          <div className="flex items-center gap-2 min-w-0">
            <Image
              src="/ferret.png"
              alt="FERRET"
              width={collapsed ? 24 : 28}
              height={collapsed ? 24 : 28}
              className="rounded flex-shrink-0"
              priority
            />
            <div
              className={`min-w-0 leading-none transition-opacity duration-150 ${
                collapsed ? "opacity-0 pointer-events-none delay-0" : "opacity-100 delay-150"
              }`}
            >
              <h1 className="text-orange-500 font-bold text-sm tracking-wider whitespace-nowrap">FERRET <span className="text-orange-400/70 font-normal text-xs">{process.env.NEXT_PUBLIC_APP_VERSION ?? "dev"}</span></h1>
              <a
                href="https://synlace.ai"
                target="_blank"
                rel="noopener noreferrer"
                className="text-neutral-500 hover:text-orange-400 text-[10px] transition-colors mt-0.5 flex items-center gap-1 whitespace-nowrap"
              >
                A Synlace product
                <ExternalLink className="w-2.5 h-2.5 shrink-0 opacity-60" />
              </a>
            </div>
          </div>
          <button
            onClick={toggleCollapse}
            className="text-neutral-400 hover:text-orange-500 p-1 transition-colors ml-auto flex-shrink-0"
            title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          >
            <ChevronRight
              className={`w-4 h-4 transition-transform duration-200 ${collapsed ? "" : "rotate-180"}`}
            />
          </button>
        </div>

        {/* Project Switcher */}
        <ProjectSwitcher collapsed={collapsed} onOpen={() => setProjectOpen(true)} />

        {/* Nav items */}
        <nav className="flex-1 overflow-y-auto">
          {navItems.map(({ href, icon: Icon, label }) => {
            const active = pathname === href || pathname.startsWith(href + "/")
            return (
              <Link
                key={href}
                href={href}
                className={`flex items-center gap-3 px-3 py-2 text-sm transition-colors border-b border-neutral-800/60 overflow-hidden ${
                  active
                    ? "bg-orange-500/20 text-orange-400 border-l-2 border-l-orange-500"
                    : "text-neutral-400 hover:text-white hover:bg-neutral-800"
                }`}
                title={collapsed ? label : undefined}
              >
                <Icon className="w-4 h-4 flex-shrink-0" />
                <span
                  className={`font-medium whitespace-nowrap transition-opacity duration-150 ${
                    collapsed ? "opacity-0 pointer-events-none delay-0" : "opacity-100 delay-150"
                  }`}
                >
                  {label}
                </span>
              </Link>
            )
          })}
        </nav>

        {/* SIGINT bell */}
        <div className="border-t border-neutral-800 flex-shrink-0">
          <button
            onClick={() => setSigintOpen(true)}
            className={`w-full flex items-center gap-3 px-3 py-2 text-sm transition-colors hover:bg-neutral-800 overflow-hidden ${
              unreadCount > 0 ? "text-orange-400" : "text-neutral-400 hover:text-white"
            }`}
            title="Latest News"
          >
            <div className="relative flex-shrink-0">
              <Radio className="w-4 h-4" />
              {unreadCount > 0 && (
                <span className="absolute -top-1 -right-1 bg-orange-500 text-white text-[8px] font-bold rounded-full w-3.5 h-3.5 flex items-center justify-center leading-none">
                  {unreadCount > 9 ? "9+" : unreadCount}
                </span>
              )}
            </div>
            <span
              className={`font-medium whitespace-nowrap transition-opacity duration-150 ${
                collapsed ? "opacity-0 pointer-events-none delay-0" : "opacity-100 delay-150"
              }`}
            >
              Latest News
            </span>
          </button>
        </div>

        {/* Proxy status at bottom */}
        <div className="border-t border-neutral-800 flex-shrink-0 overflow-hidden">
          <div className="flex items-center gap-3 px-3 py-2">
            {/* Icon-sized container so the dot aligns with nav icons above */}
            <div className="w-4 h-4 flex items-center justify-center flex-shrink-0">
              <div
                className={`w-2 h-2 rounded-full ${
                  proxyStatus?.running ? "bg-green-500 animate-pulse" : "bg-red-500"
                }`}
                title={proxyStatus?.running ? "Proxy active" : "Proxy stopped"}
              />
            </div>
            <span
              className={`text-[11px] text-neutral-500 whitespace-nowrap transition-opacity duration-150 ${
                collapsed ? "opacity-0 pointer-events-none" : "opacity-100 delay-150"
              }`}
            >
              {proxyStatus?.listen_address ?? "127.0.0.1:1337"}
            </span>
          </div>
        </div>
      </aside>

      {/* Drag handle */}
      <div
        onMouseDown={onDragStart}
        className="w-1 flex-shrink-0 bg-neutral-800 hover:bg-orange-500/60 cursor-col-resize transition-colors active:bg-orange-500"
        title="Drag to resize sidebar"
      />

      {/* Main content */}
      <main className="flex-1 overflow-hidden min-w-0">
        {children}
      </main>

      {/* Project slide-over sheet */}
      <ProjectSheet open={projectOpen} onOpenChange={setProjectOpen} />

      {/* SIGINT slide-over panel */}
      <SigintPanel
        open={sigintOpen}
        onOpenChange={setSigintOpen}
        items={sigintItems}
        readIds={readIds}
        onMarkAllRead={markAllRead}
        onMarkRead={markRead}
        onRefresh={refreshSigint}
        refreshing={sigintRefreshing}
      />
    </div>
  )
}
