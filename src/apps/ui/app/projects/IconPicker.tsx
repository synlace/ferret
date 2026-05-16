"use client"

import React, { useState, useEffect, useRef } from "react"
import data from "@emoji-mart/data"
import Picker from "@emoji-mart/react"
import { PRESET_COLORS } from "./types"

// ---------------------------------------------------------------------------
// Colour picker popover — fixed-position to avoid z-index clipping in tables
// ---------------------------------------------------------------------------

export function ColorPicker({
  value,
  anchorRef,
  onChange,
  onClose,
}: {
  value: string
  anchorRef: React.RefObject<HTMLElement>
  onChange: (c: string) => void
  onClose: () => void
}) {
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null)

  useEffect(() => {
    if (anchorRef.current) {
      const r = anchorRef.current.getBoundingClientRect()
      setPos({ top: r.bottom + 4, left: r.left })
    }
  }, [anchorRef])

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose()
    }
    document.addEventListener("mousedown", handler)
    return () => document.removeEventListener("mousedown", handler)
  }, [onClose])

  if (!pos) return null

  return (
    <div
      ref={ref}
      style={{ position: "fixed", top: pos.top, left: pos.left, zIndex: 9999 }}
      className="bg-neutral-800 border border-neutral-700 rounded p-2 flex gap-1 flex-wrap w-28 shadow-xl"
    >
      {PRESET_COLORS.map((c) => (
        <button
          key={c}
          onClick={() => { onChange(c); onClose() }}
          className={`w-6 h-6 rounded-full border-2 transition-colors ${value === c ? "border-white" : "border-transparent"}`}
          style={{ backgroundColor: c }}
          title={c}
        />
      ))}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Emoji input popover — fixed-position, emoji-mart picker
// ---------------------------------------------------------------------------

export function EmojiInput({
  value,
  anchorRef,
  onChange,
  onClose,
}: {
  value: string
  anchorRef: React.RefObject<HTMLElement>
  onChange: (e: string) => void
  onClose: () => void
}) {
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null)

  useEffect(() => {
    if (anchorRef.current) {
      const r = anchorRef.current.getBoundingClientRect()
      const pickerWidth = 350
      const pickerHeight = 435

      // Default: open to the right of the anchor button so it stays visible
      let left = r.right + 4
      let top = r.top

      // If it overflows the right edge, flip to open left of the anchor
      if (left + pickerWidth > window.innerWidth) {
        left = r.left - pickerWidth - 4
      }
      // If it still overflows left, clamp to 8px from left edge
      if (left < 8) left = 8

      // If it overflows the bottom, shift up
      if (top + pickerHeight > window.innerHeight) {
        top = window.innerHeight - pickerHeight - 8
      }
      // Clamp so the picker never goes above the viewport
      if (top < 8) top = 8

      setPos({ top, left })
    }
  }, [anchorRef])

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      // Ignore clicks on the picker itself or on the anchor button that opened it
      if (ref.current && ref.current.contains(e.target as Node)) return
      if (anchorRef.current && anchorRef.current.contains(e.target as Node)) return
      onClose()
    }
    document.addEventListener("mousedown", handler)
    return () => document.removeEventListener("mousedown", handler)
  }, [onClose, anchorRef])

  // Don't render until position is calculated — prevents flash to top-left
  if (!pos) return null

  return (
    <div
      ref={ref}
      style={{ position: "fixed", top: pos.top, left: pos.left, zIndex: 9999 }}
      className="shadow-2xl"
    >
      <Picker
        data={data}
        onEmojiSelect={(emoji: any) => {
          onChange(emoji.native)
          onClose()
        }}
        theme="dark"
        set="native"
      />
    </div>
  )
}
