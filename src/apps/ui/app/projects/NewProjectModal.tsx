"use client"

import React, { useState, useEffect, useRef } from "react"
import { X, Cpu, Key } from "lucide-react"
import { ModelPickerModal } from "./ModelPickerModal"
import { EmojiInput } from "./IconPicker"
import { DEFAULT_MODEL } from "./types"

interface NewProjectModalProps {
  onClose: () => void
  onCreate: (
    name: string,
    description: string,
    color: string,
    emoji: string,
    labels: string[],
    defaultModel: string,
    provisionKey: boolean,
  ) => Promise<void>
}

export function NewProjectModal({ onClose, onCreate }: NewProjectModalProps) {
  const [name, setName] = useState("")
  const [description, setDescription] = useState("")
  const [emoji, setEmoji] = useState("📁")
  const [showEmojiPicker, setShowEmojiPicker] = useState(false)
  const emojiAnchorRef = useRef<HTMLDivElement>(null)
  const [labelInput, setLabelInput] = useState("")
  const [labels, setLabels] = useState<string[]>([])
  const [defaultModel, setDefaultModel] = useState(DEFAULT_MODEL)
  const [showModelPicker, setShowModelPicker] = useState(false)
  const [provisionKey, setProvisionKey] = useState(true)
  const [loading, setLoading] = useState(false)
  const modalRef = useRef<HTMLDivElement>(null)

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!name.trim()) return
    setLoading(true)
    await onCreate(name.trim(), description.trim(), "#f97316", emoji, labels, defaultModel, provisionKey)
    setLoading(false)
  }

  const addLabel = () => {
    const t = labelInput.trim()
    if (t && !labels.includes(t)) setLabels((prev) => [...prev, t])
    setLabelInput("")
  }

  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === "Escape") onClose() }
    document.addEventListener("keydown", handler)
    return () => document.removeEventListener("keydown", handler)
  }, [onClose])

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (showModelPicker || showEmojiPicker) return
      if (modalRef.current && !modalRef.current.contains(e.target as Node)) onClose()
    }
    document.addEventListener("mousedown", handler)
    return () => document.removeEventListener("mousedown", handler)
  }, [onClose, showModelPicker, showEmojiPicker])

  const modelLabel = defaultModel.split("/").slice(-1)[0] ?? defaultModel

  return (
    <div className="fixed inset-0 bg-black/60 z-50 flex items-center justify-center">
      <div ref={modalRef} className="bg-neutral-900 border border-neutral-800 rounded-lg w-full max-w-md shadow-2xl">

        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-neutral-800">
          <h2 className="text-sm font-semibold text-white">New Project</h2>
          <button onClick={onClose} className="text-neutral-500 hover:text-white transition-colors">
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Form */}
        <form onSubmit={handleSubmit}>
          <div className="p-4 space-y-4">

            {/* Name + emoji */}
            <div className="flex items-end gap-3">
              <div className="flex-1">
                <label className="text-[10px] font-semibold text-neutral-500 uppercase tracking-wider block mb-1">Name *</label>
                <input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="My Project"
                  autoFocus
                  className="w-full h-8 px-3 bg-neutral-800 border border-neutral-700 rounded text-sm text-white placeholder-neutral-600 focus:outline-none focus:border-orange-500"
                />
              </div>
              <div ref={emojiAnchorRef}>
                <button
                  type="button"
                  onClick={() => setShowEmojiPicker(true)}
                  className="w-8 h-8 rounded bg-neutral-800 border border-neutral-700 flex items-center justify-center text-lg hover:border-orange-500 transition-colors"
                  title="Choose emoji"
                >
                  {emoji || "📁"}
                </button>
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

            {/* Description */}
            <div>
              <label className="text-[10px] font-semibold text-neutral-500 uppercase tracking-wider block mb-1">Description</label>
              <textarea
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="Optional description…"
                rows={2}
                className="w-full bg-neutral-800 border border-neutral-700 rounded px-3 py-2 text-sm text-white placeholder-neutral-600 focus:outline-none focus:border-orange-500 resize-none"
              />
            </div>

            {/* Labels */}
            <div>
              <label className="text-[10px] font-semibold text-neutral-500 uppercase tracking-wider block mb-1">
                Labels <span className="text-neutral-700 normal-case font-normal">(optional)</span>
              </label>
              {labels.length > 0 && (
                <div className="flex items-center gap-1 flex-wrap mb-1.5">
                  {labels.map((l) => (
                    <span key={l} className="flex items-center gap-1 text-[10px] bg-neutral-800 border border-neutral-700 text-neutral-300 rounded px-1.5 py-0.5">
                      {l}
                      <button
                        type="button"
                        onClick={() => setLabels((prev) => prev.filter((x) => x !== l))}
                        className="text-neutral-500 hover:text-white transition-colors"
                      >
                        <X className="w-2.5 h-2.5" />
                      </button>
                    </span>
                  ))}
                </div>
              )}
              <div className="flex gap-1.5">
                <input
                  type="text"
                  value={labelInput}
                  onChange={(e) => setLabelInput(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addLabel() } }}
                  placeholder="Add label…"
                  className="flex-1 h-7 px-2 bg-neutral-800 border border-neutral-700 rounded text-xs text-white placeholder-neutral-600 focus:outline-none focus:border-orange-500"
                />
                <button
                  type="button"
                  onClick={addLabel}
                  className="px-2.5 h-7 text-xs bg-neutral-700 hover:bg-neutral-600 text-white rounded transition-colors"
                >
                  Add
                </button>
              </div>
            </div>

            {/* Default AI Model */}
            <div>
              <label className="text-[10px] font-semibold text-neutral-500 uppercase tracking-wider block mb-1">Default AI Model</label>
              <button
                type="button"
                onClick={() => setShowModelPicker(true)}
                className="w-full flex items-center gap-2 bg-neutral-800 border border-neutral-700 rounded px-3 py-2 text-xs text-white hover:border-orange-500 transition-colors text-left"
              >
                <Cpu className="w-3.5 h-3.5 text-orange-400 shrink-0" />
                <span className="flex-1 truncate font-mono">{modelLabel}</span>
                <span className="text-neutral-600 text-[10px] shrink-0">change ▾</span>
              </button>
            </div>

            {/* Provision key */}
            <label className="flex items-center gap-2 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={provisionKey}
                onChange={(e) => setProvisionKey(e.target.checked)}
                className="w-3.5 h-3.5 accent-orange-500"
              />
              <Key className="w-3 h-3 text-neutral-500" />
              <span className="text-xs text-neutral-300">Auto-provision OpenRouter API key</span>
              <span className="text-[10px] text-neutral-600">(requires provisioning key)</span>
            </label>

          </div>

          {/* Footer */}
          <div className="flex items-center justify-end gap-2 px-4 py-3 border-t border-neutral-800">
            <button
              type="button"
              onClick={onClose}
              className="h-7 px-3 text-xs text-neutral-500 border border-neutral-700 rounded hover:text-neutral-300 hover:bg-neutral-800 transition-colors"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={loading || !name.trim()}
              className="h-7 px-4 text-xs font-semibold bg-orange-500 hover:bg-orange-600 text-white rounded transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {loading ? "Creating…" : "Create Project"}
            </button>
          </div>
        </form>
      </div>

      {showModelPicker && (
        <ModelPickerModal
          currentModel={defaultModel}
          onSelect={(m) => { setDefaultModel(m); setShowModelPicker(false) }}
          onClose={() => setShowModelPicker(false)}
        />
      )}
    </div>
  )
}
