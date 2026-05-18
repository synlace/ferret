"use client"

import React, { useState, useEffect, useRef } from "react"
import { X } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"

interface PromoteModalProps {
  onClose: () => void
  onPromote: (name: string) => Promise<void>
}

export function PromoteModal({ onClose, onPromote }: PromoteModalProps) {
  const [name, setName] = useState("")
  const [loading, setLoading] = useState(false)
  const modalRef = useRef<HTMLDivElement>(null)

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!name.trim()) return
    setLoading(true)
    await onPromote(name.trim())
    setLoading(false)
  }

  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === "Escape") onClose() }
    document.addEventListener("keydown", handler)
    return () => document.removeEventListener("keydown", handler)
  }, [onClose])

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (modalRef.current && !modalRef.current.contains(e.target as Node)) onClose()
    }
    document.addEventListener("mousedown", handler)
    return () => document.removeEventListener("mousedown", handler)
  }, [onClose])

  return (
    <div className="fixed inset-0 bg-black/60 z-50 flex items-center justify-center">
      <div ref={modalRef} className="bg-neutral-900 border border-neutral-700 rounded-lg p-6 w-full max-w-sm shadow-2xl">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-white font-semibold text-lg">Promote Workspace</h2>
          <button onClick={onClose} className="text-neutral-400 hover:text-white"><X className="w-4 h-4" /></button>
        </div>
        <p className="text-xs text-neutral-400 mb-4">
          Copy the temporary workspace into a new permanent project. The temp workspace stays intact.
        </p>
        <form onSubmit={handleSubmit} className="space-y-4">
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Project name..."
            className="bg-neutral-800 border-neutral-600 text-white placeholder-neutral-500 focus:border-brand-500" autoFocus />
          <div className="flex gap-2">
            <Button type="submit" disabled={loading || !name.trim()}
              className="flex-1 bg-brand-500 hover:bg-brand-600 text-neutral-900 disabled:opacity-50">
              {loading ? "Copying..." : "Copy to Project"}
            </Button>
            <Button type="button" variant="outline" onClick={onClose}
              className="border-neutral-600 text-neutral-300 hover:bg-neutral-800">Cancel</Button>
          </div>
        </form>
      </div>
    </div>
  )
}
