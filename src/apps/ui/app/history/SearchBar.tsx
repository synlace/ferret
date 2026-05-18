"use client"

import React, { useRef, useState, useEffect } from "react"
import { Input } from "@/components/ui/input"
import { Clock, SlidersHorizontal, Link, Check, X, Bookmark, BookmarkCheck } from "lucide-react"
import { type SavedSearch } from "./useSavedSearches"

interface SearchBarProps {
  rawText: string
  activePills: SavedSearch[]
  historyOpen: boolean
  filterOpen: boolean
  hasActiveFilters: boolean
  copiedFilterUrl: boolean
  savedSearches: SavedSearch[]
  historyIndex: number
  historySuggestions: string[]
  onRawTextChange: (value: string) => void
  onHistoryIndexChange: (updater: (i: number) => number) => void
  onSelectHistory: (entry: string) => void
  onPushHistory: (query: string) => void
  onRemovePill: (name: string) => void
  onAddPill: (s: SavedSearch) => void
  onSaveSearch: (name: string, query: string) => void
  onToggleHistory: () => void
  onToggleFilter: () => void
  onCopyFilterUrl: () => void
  onClearAll: () => void
  searchInputRef: React.RefObject<HTMLInputElement | null>
  tabResetRef: React.RefObject<HTMLDivElement | null>
}

export function SearchBar({
  rawText,
  activePills,
  historyOpen,
  filterOpen,
  hasActiveFilters,
  copiedFilterUrl,
  savedSearches,
  historyIndex,
  historySuggestions,
  onRawTextChange,
  onHistoryIndexChange,
  onSelectHistory,
  onPushHistory,
  onRemovePill,
  onAddPill,
  onSaveSearch,
  onToggleHistory,
  onToggleFilter,
  onCopyFilterUrl,
  onClearAll,
  searchInputRef,
  tabResetRef,
}: SearchBarProps) {
  const [savingSearch, setSavingSearch] = useState(false)
  const [saveNameInput, setSaveNameInput] = useState("")
  const saveNameInputRef = useRef<HTMLInputElement>(null)
  const hasContent = activePills.length > 0 || rawText.length > 0

  // Focus save name input when save mode opens
  useEffect(() => {
    if (savingSearch) {
      setTimeout(() => saveNameInputRef.current?.focus(), 50)
    }
  }, [savingSearch])

  const handleSaveConfirm = () => {
    if (!saveNameInput.trim()) return
    onSaveSearch(saveNameInput.trim(), rawText)
    setSaveNameInput("")
    setSavingSearch(false)
  }

  return (
    <div className="flex border-b border-neutral-800 flex-shrink-0">
      {/* Pill + text input area */}
      <div className="relative flex-1 flex items-center bg-neutral-900 min-w-0 flex-wrap gap-1 px-1">
        {/* Active pills */}
        {activePills.map(pill => (
          <span
            key={pill.name}
            className="inline-flex items-center gap-1 bg-brand-500/20 border border-brand-500/40 text-brand-300 text-[11px] font-mono rounded px-1.5 py-0.5 flex-shrink-0 my-0.5"
            title={pill.query}
          >
            🔖 {pill.name}
            <button
              tabIndex={-1}
              onClick={() => onRemovePill(pill.name)}
              className="text-brand-400/60 hover:text-white transition-colors ml-0.5"
            >
              <X className="w-2.5 h-2.5" />
            </button>
          </span>
        ))}

        {/* Text input */}
        <Input
          ref={searchInputRef}
          placeholder={activePills.length > 0 ? "Add more filters..." : "Search... or use qualifiers: method:GET status:4xx host:*api* mime:json -ext:js"}
          value={rawText}
          tabIndex={1}
          onChange={(e) => { onRawTextChange(e.target.value); onHistoryIndexChange(() => -1) }}
          onKeyDown={(e) => {
            if (historyOpen && historySuggestions.length > 0) {
              if (e.key === "ArrowDown") { e.preventDefault(); onHistoryIndexChange(i => Math.min(i + 1, historySuggestions.length - 1)); return }
              if (e.key === "ArrowUp")   { e.preventDefault(); onHistoryIndexChange(i => Math.max(i - 1, -1)); return }
              if (e.key === "Enter") {
                e.preventDefault()
                if (historyIndex >= 0 && historySuggestions[historyIndex]) onSelectHistory(historySuggestions[historyIndex])
                else if (rawText.trim()) onPushHistory(rawText)
                return
              }
              if (e.key === "Escape") { return }
            } else if (e.key === "Enter" && rawText.trim()) {
              onPushHistory(rawText)
            } else if (e.key === "Escape") {
              searchInputRef.current?.blur()
              tabResetRef.current?.focus()
            }
          }}
          className="h-8 text-xs bg-transparent border-0 border-transparent text-white flex-1 min-w-[120px] focus-visible:outline-none focus-visible:ring-0 focus-visible:ring-offset-0 font-mono placeholder:font-sans placeholder:text-neutral-600 pr-1"
        />

        {/* Clear all button */}
        {hasContent && (
          <button
            tabIndex={-1}
            onClick={onClearAll}
            className="absolute right-2 top-1/2 -translate-y-1/2 text-neutral-500 hover:text-white transition-colors"
            title="Clear search"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        )}
      </div>

      {/* Save search button — shown when rawText is non-empty */}
      {rawText.trim() && !savingSearch && (
        <button
          tabIndex={-1}
          onClick={() => { setSavingSearch(true); setSaveNameInput("") }}
          className="h-8 px-2.5 flex items-center border-l border-neutral-800 transition-colors flex-shrink-0 bg-neutral-900 text-neutral-400 hover:text-brand-400"
          title="Save search"
        >
          <Bookmark className="w-3.5 h-3.5" />
        </button>
      )}

      {/* Inline save name prompt */}
      {savingSearch && (
        <div className="flex items-center border-l border-neutral-800 bg-neutral-900 flex-shrink-0">
          <input
            ref={saveNameInputRef}
            value={saveNameInput}
            onChange={e => setSaveNameInput(e.target.value)}
            onKeyDown={e => {
              if (e.key === "Enter") handleSaveConfirm()
              if (e.key === "Escape") { setSavingSearch(false); setSaveNameInput("") }
            }}
            placeholder="Name..."
            className="h-8 px-2 text-xs bg-transparent text-white border-0 outline-none font-mono w-28 placeholder:text-neutral-600"
          />
          <button
            tabIndex={-1}
            onClick={handleSaveConfirm}
            disabled={!saveNameInput.trim()}
            className="h-8 px-2 text-green-400 hover:text-green-300 disabled:opacity-30 transition-colors"
            title="Confirm save"
          >
            <BookmarkCheck className="w-3.5 h-3.5" />
          </button>
          <button
            tabIndex={-1}
            onClick={() => { setSavingSearch(false); setSaveNameInput("") }}
            className="h-8 px-1.5 text-neutral-500 hover:text-white transition-colors border-r border-neutral-800"
            title="Cancel"
          >
            <X className="w-3 h-3" />
          </button>
        </div>
      )}

      {/* Clock (history) button */}
      <button
        tabIndex={-1}
        onClick={onToggleHistory}
        className={`h-8 px-2.5 flex items-center border-l border-neutral-800 transition-colors flex-shrink-0 ${
          historyOpen ? "bg-brand-500/20 text-brand-400" : "bg-neutral-900 text-neutral-400 hover:text-brand-400"
        }`}
        title="Search history"
      >
        <Clock className="w-3.5 h-3.5" />
      </button>

      {/* Copy shareable URL button */}
      {hasContent && (
        <button
          tabIndex={-1}
          onClick={onCopyFilterUrl}
          className={`h-8 px-2.5 flex items-center border-l border-neutral-800 transition-colors flex-shrink-0 ${
            copiedFilterUrl ? "text-green-400 bg-neutral-900" : "bg-neutral-900 text-neutral-400 hover:text-brand-400"
          }`}
          title="Copy shareable filter URL"
        >
          {copiedFilterUrl ? <Check className="w-3.5 h-3.5" /> : <Link className="w-3.5 h-3.5" />}
        </button>
      )}

      {/* Filter button */}
      <button
        tabIndex={-1}
        onClick={onToggleFilter}
        className={`h-8 px-3 text-xs flex items-center gap-1.5 border-l border-neutral-800 transition-colors flex-shrink-0 ${
          filterOpen || hasActiveFilters
            ? "bg-brand-500/20 text-brand-400"
            : "bg-neutral-900 text-neutral-400 hover:text-brand-400"
        }`}
      >
        <SlidersHorizontal className="w-3 h-3" />
        Filter
        <span className={`w-1.5 h-1.5 rounded-full bg-brand-400 ml-0.5 transition-opacity ${hasActiveFilters ? "opacity-100" : "opacity-0"}`} />
      </button>
    </div>
  )
}
