"use client"

import React, { useState, useEffect, useRef } from "react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { X } from "lucide-react"
import { EmojiInput } from "../projects/IconPicker"

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000"

export const SCOPE_LABELS: Record<string, string> = {
  single: "Single Request",
  host: "All from Host",
  selected: "Selected Requests",
  page: "Current Page",
  all: "All Requests",
  blank: "No Context",
}

export const SCOPE_ICONS: Record<string, string> = {
  single: "🔍",
  host: "🌐",
  selected: "☑️",
  page: "📄",
  all: "📦",
  blank: "💬",
}

interface NewChatModalProps {
  activeProjectId: string
  onClose: () => void
  onCreated: (session: { id: string; name: string; scope: string; scope_data: Record<string, unknown> | null; created_at: string }) => void
  initialScope?: string
  initialSelectedIds?: string[]
  initialName?: string
}

export function NewChatModal({
  activeProjectId,
  onClose,
  onCreated,
  initialName = "",
}: NewChatModalProps) {
  const [name, setName] = useState(initialName)
  const [emoji, setEmoji] = useState("📦")
  const [showEmojiPicker, setShowEmojiPicker] = useState(false)
  const emojiAnchorRef = useRef<HTMLDivElement>(null)
  const [creating, setCreating] = useState(false)
  const modalRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  // Focus input on mount
  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  // Esc key
  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === "Escape") onClose() }
    document.addEventListener("keydown", handler)
    return () => document.removeEventListener("keydown", handler)
  }, [onClose])

  // Outside click — don't close if emoji picker is open
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (showEmojiPicker) return
      if (modalRef.current && !modalRef.current.contains(e.target as Node)) onClose()
    }
    document.addEventListener("mousedown", handler)
    return () => document.removeEventListener("mousedown", handler)
  }, [onClose, showEmojiPicker])

  const handleCreate = async () => {
    const baseName = name.trim() || "New Workspace"
    const chatName = `${emoji} ${baseName}`
    setCreating(true)
    try {
      const res = await fetch(`${API_BASE}/api/chats`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: chatName,
          scope: "all",
          scope_data: null,
          project_id: activeProjectId,
        }),
      })
      if (res.ok) {
        const session = await res.json()
        onCreated(session)
      }
    } catch {
      // ignore
    } finally {
      setCreating(false)
    }
  }

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50">
      <div
        ref={modalRef}
        className="bg-neutral-900 border border-neutral-700 rounded-lg w-[360px] p-5 shadow-2xl"
      >
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-sm font-semibold text-white">New Workspace</h2>
          <Button variant="ghost" size="icon" className="h-6 w-6 text-neutral-400 hover:text-white" onClick={onClose}>
            <X className="w-3 h-3" />
          </Button>
        </div>

        <div className="space-y-4">
          {/* Name + emoji picker */}
          <div>
            <label className="text-xs text-neutral-400 block mb-1.5">Name <span className="text-neutral-600">(optional)</span></label>
            <div className="flex items-center gap-2">
              <div ref={emojiAnchorRef}>
                <button
                  type="button"
                  onClick={() => setShowEmojiPicker(v => !v)}
                  className="w-8 h-8 rounded bg-neutral-800 border border-neutral-700 flex items-center justify-center text-lg hover:border-orange-500 transition-colors flex-shrink-0"
                  title="Choose emoji"
                >
                  {emoji}
                </button>
              </div>
              <Input
                ref={inputRef}
                value={name}
                onChange={e => setName(e.target.value)}
                onKeyDown={e => { if (e.key === "Enter") handleCreate() }}
                placeholder="e.g. auth-bypass-session"
                className="bg-neutral-800 border-neutral-600 text-white text-sm placeholder:text-neutral-600 flex-1"
              />
            </div>
          </div>

          {showEmojiPicker && (
            <EmojiInput
              value={emoji}
              anchorRef={emojiAnchorRef as unknown as React.RefObject<HTMLElement>}
              onChange={setEmoji}
              onClose={() => setShowEmojiPicker(false)}
            />
          )}

          <p className="text-xs text-neutral-500 leading-relaxed">
            The workspace will have access to <span className="text-neutral-300">all captured requests</span>. You can narrow the scope afterwards using the context panel.
          </p>

          <div className="flex gap-2">
            <Button
              onClick={handleCreate}
              disabled={creating}
              className="flex-1 bg-orange-500 hover:bg-orange-600 text-white text-sm h-9"
            >
              {creating ? "Creating..." : "Create Workspace"}
            </Button>
            <Button
              variant="outline"
              onClick={onClose}
              className="border-neutral-600 text-neutral-300 text-sm h-9 hover:bg-neutral-800"
            >
              Cancel
            </Button>
          </div>
        </div>
      </div>
    </div>
  )
}
