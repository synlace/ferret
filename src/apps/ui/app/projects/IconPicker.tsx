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
  const [pos, setPos] = useState({ top: 0, left: 0 })

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
  const [pos, setPos] = useState({ top: 0, left: 0 })

  useEffect(() => {
    if (anchorRef.current) {
      const r = anchorRef.current.getBoundingClientRect()
      // Try to position it so it doesn't go off-screen
      const pickerWidth = 350
      const pickerHeight = 435
      let left = r.left
      let top = r.bottom + 4

      if (left + pickerWidth > window.innerWidth) {
        left = window.innerWidth - pickerWidth - 10
      }
      if (top + pickerHeight > window.innerHeight) {
        top = r.top - pickerHeight - 4
      }

      setPos({ top, left })
    }
  }, [anchorRef])

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        onClose()
      }
    }
    document.addEventListener("mousedown", handler)
    return () => document.removeEventListener("mousedown", handler)
  }, [onClose])

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
